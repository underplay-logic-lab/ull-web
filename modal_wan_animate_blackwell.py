"""
Wan Animate 2 on Modal — Blackwell (B300 / sm_100 family) native rebuild.

Independent from scripts/modal_wan_animate.py, which is left untouched. That
file runs on modal.Image.debian_slim + a CUDA 13.0 toolkit bolted on via
apt, targeting both the Standard (L40S) and ULTRA (B300) tiers from one
image. This file instead starts from NVIDIA's own CUDA 13.0 "devel" image
(nvcc + full toolkit already present, nothing to bolt on) and Python 3.13,
and only ever targets B300 — no dual-tier abstraction, since there is only
one tier here.

It shares the SAME `ull-wan-models` Volume as scripts/modal_wan_animate.py,
just mounted directly at ComfyUI's own models/ dir (see MODELS_DIR below)
instead of a separate /models mount that gets symlinked in piece by piece.
Since it's the identical Volume with the identical subfolder layout
(diffusion_models/, loras/, text_encoders/, clip_vision/, vae/,
custom_nodes/, outputs/, _logs/), the two apps can be deployed side by side
against the same data with no migration step: switching the frontend's
MODAL_WAN_ANIMATE_ULTRA_URL / MODAL_STORAGE_URL env vars over to this app's
endpoints is enough.

Usage:
  modal run modal_wan_animate_blackwell.py
    - ensures models are present in the volume, then submits a one-off test
      generation (same env overrides as scripts/modal_wan_animate.py:
      WAN_WORKFLOW_PATH, WAN_REFERENCE_IMAGE_PATH, WAN_POSE_VIDEO_PATH).

  modal deploy modal_wan_animate_blackwell.py
    - publishes the FastAPI POST endpoints (/generate, /custom_workflow,
      /storage) for external use.
"""

import base64
import hmac
import json
import os
import pathlib
import re
import time
from urllib.parse import urlparse

import fastapi
import modal

app = modal.App("ull-wan-animate-blackwell")

COMFY_DIR = "/root/comfy/ComfyUI"
# The Volume is mounted directly here (see the `volumes={}` kwarg on
# WanAnimateBlackwell / ModalStorageBlackwell below) rather than at a
# separate path that gets symlinked subfolder-by-subfolder into ComfyUI's
# models/ dir — diffusion_models/, loras/, text_encoders/, clip_vision/ and
# vae/ land exactly where ComfyUI's folder_paths.py already expects them,
# with no setup()-time symlink step needed for models. custom_nodes/,
# outputs/ and _logs/ also end up nested under here as a side effect of
# reusing the same Volume layout; ComfyUI's folder scanner ignores
# subdirectories it doesn't recognize, so that's harmless — custom nodes
# still need their own symlink into COMFY_DIR/custom_nodes/ (see setup()).
MODELS_DIR = os.path.join(COMFY_DIR, "models")
CUSTOM_NODES_SUBDIR = "custom_nodes"
LOGS_SUBDIR = "_logs"
COMFYUI_LOG_FILENAME = "comfyui.log"
GPU_TIER = "blackwell"

# GPU passed to Modal as a plain string, not modal.gpu.B300() — the modal.gpu
# module was removed from the SDK well before this version (modal==1.5.4
# here; confirmed via `python -c "import modal.gpu"` -> ModuleNotFoundError).
# Modal's current @app.cls(gpu=...) just takes a string and doesn't validate
# it client-side (see parse_gpu_config in modal/_utils/function_utils.py) —
# if "B300" isn't actually available on the target Modal workspace,
# deployment still succeeds but generation requests fail at request time.
GPU_TYPE = "B300"

# Same admin-only allow-lists as scripts/modal_wan_animate.py — model-
# management endpoints only accept URLs/git remotes from known-good hosts.
ALLOWED_DOWNLOAD_HOSTS = ("huggingface.co", "civitai.com")
ALLOWED_GIT_HOSTS = ("github.com",)

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)

image = (
    modal.Image.from_registry(
        "nvidia/cuda:13.0.0-devel-ubuntu24.04",
        add_python="3.13",
    )
    .apt_install(
        # libgl1-mesa-glx was dropped from Ubuntu 24.04 (noble) — libgl1
        # is the package that replaces it there.
        "git", "ffmpeg", "libgl1", "libglib2.0-0", "wget",
        # C/C++ toolchain + fast build system for compiling SageAttention's
        # and flash-attn's CUDA kernels from source below.
        "build-essential", "ninja-build",
    )
    .env(
        {
            "CUDA_HOME": "/usr/local/cuda",
            # Prepended onto Ubuntu's own default secure_path rather than
            # referencing the prior $PATH — container ENV directives don't
            # reliably shell-expand it — so nvcc is discoverable without
            # dropping anything apt/pip already installed there.
            "PATH": "/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "LD_LIBRARY_PATH": "/usr/local/cuda/lib64",
            # 10.0 = Blackwell (B200/B300), 10.3 = Blackwell Ultra (matches
            # PyTorch's own named_arches table: 'Blackwell': '10.0;10.3;
            # 12.0;12.1+PTX' in torch/utils/cpp_extension.py), 12.0 =
            # consumer Blackwell (RTX 50-series) for forward compatibility
            # with any dev/test hardware. +PTX on 10.0 embeds forward-
            # compatible PTX for the base arch too, on top of the concrete
            # SASS built for each of 10.0/10.3/12.0.
            "TORCH_CUDA_ARCH_LIST": "10.0;10.3;12.0;10.0+PTX",
            # Narrows flash-attn's own (separate from TORCH_CUDA_ARCH_LIST)
            # arch env var to just the Blackwell targets this file cares
            # about — its setup.py's arch table (as of this writing) has no
            # distinct sm_103 branch, only 100/120/110(Thor), so 103 is left
            # out here; sm_100's build already covers B300 either way.
            "FLASH_ATTN_CUDA_ARCHS": "100;120",
            # Caps parallel nvcc jobs so the from-source builds below don't
            # spawn one compiler process per core and OOM the (CPU-only)
            # image-build worker.
            "MAX_JOBS": "4",
            # add_python's Python 3.13 build (python-build-standalone) was
            # itself compiled with clang, so its sysconfig bakes in
            # CXX=clang++ / CC=clang — which setuptools/distutils picks up
            # by default and which doesn't exist as an actual binary in
            # this image (only build-essential's real gcc/g++ do). Without
            # this override, SageAttention's/flash-attn's builds fail with
            # "clang++ (0.0.0) is less than the minimum required version".
            "CC": "gcc",
            "CXX": "g++",
        }
    )
    # Pulled from the cu130 (CUDA 13.0) wheel index, which as of this
    # writing publishes up to torch 2.9.1 for cp313 — there is no 2.10
    # release yet; left unpinned so the next `modal deploy` picks up 2.10+
    # automatically once PyTorch actually ships it for cu130/Python 3.13.
    .pip_install(
        "torch",
        "torchvision",
        "torchaudio",
        extra_index_url="https://download.pytorch.org/whl/cu130",
    )
    .pip_install(
        "packaging",
        "wheel",
        "ninja",
        # Triton also ships bundled with the torch wheel above (as its
        # `pytorch-triton` dependency); pinning nothing here just lets pip
        # pick whatever the resolver settles on to satisfy both.
        "triton",
    )
    # Built from source, from a *patched* local checkout rather than a
    # plain `pip install git+https://...` — thu-ml/SageAttention (as of
    # commit d1a57a5) doesn't recognize compute capability 10.3
    # ("Blackwell Ultra", B300's actual reported architecture) at either
    # the build level (setup.py silently drops it, so the extension ships
    # no sm_103 code at all) or the Python dispatch level (sageattn() has
    # no sm100/sm103 branch). See scripts/patch_sageattention_blackwell_ultra.py
    # for the full explanation and exactly what's patched.
    #
    # --no-build-isolation is required: setup.py does `import torch` to
    # read TORCH_CUDA_ARCH_LIST / query the ABI, which fails in the
    # isolated build venv pip creates by default (no torch installed
    # there) unless this is passed. Left un-suppressed (no `|| echo`
    # fallback) — this is the primary attention kernel this file exists
    # to ship, so a failure here should fail the build loudly rather than
    # silently degrade.
    .add_local_file(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "patch_sageattention_blackwell_ultra.py"),
        "/root/patch_sageattention_blackwell_ultra.py",
        copy=True,
    )
    .run_commands(
        "git clone https://github.com/thu-ml/SageAttention.git /opt/SageAttention",
        "python3 /root/patch_sageattention_blackwell_ultra.py /opt/SageAttention",
        "pip install --no-build-isolation /opt/SageAttention",
    )
    # flash-attn's mainline setup.py added real Blackwell (sm_100/120)
    # support gated on CUDA >= 12.8 (see add_cuda_gencodes in its setup.py),
    # so this is a genuine build against this image's CUDA 13.0 toolkit, not
    # a no-op. Still wrapped in `|| echo` — unlike SageAttention above, this
    # is a secondary/best-effort kernel (ComfyUI prefers sage attention over
    # flash attention when both are enabled; see attention.py's
    # sage_attention_enabled()/flash_attention_enabled() branch order), and
    # its build is long and more sensitive to upstream churn.
    .run_commands(
        "pip install --no-build-isolation flash-attn "
        "|| echo 'flash-attn build failed, continuing with SageAttention/SDPA fallback'",
    )
    .pip_install(
        "comfy-cli",
        "websockets",
        "requests",
        "aiohttp",
        "fastapi[standard]",
        # Repo-wide model downloads (download_repo_async / snapshot_download)
        # for the admin Storage tab's Hugging Face repo bulk-download mode.
        "huggingface_hub",
    )
    .run_commands(
        f"git clone https://github.com/comfyanonymous/ComfyUI.git {COMFY_DIR}",
        # Same tag scripts/modal_wan_animate.py pins — v0.31.0+ added native
        # Wan Animate 2 node support (WanAnimate2Cache / WanAnimate2ToVideo)
        # and comfy_extras/nodes_easycache.py (see below), and v0.33.3 is
        # the last tag verified not to hit master's transient SaveVideo bug.
        f"cd {COMFY_DIR} && git fetch --tags && git checkout v0.33.3",
        f"cd {COMFY_DIR} && pip install -r requirements.txt",
        # ComfyUI's repo ships models/ pre-populated with ~25 placeholder
        # subdirectories (checkpoints/, loras/, vae/, ...), so it's non-empty
        # right after clone. Modal's Volume mount (see MODELS_DIR above)
        # requires the mount path to be empty at container start — unlike a
        # plain Docker volume mount, it does not silently shadow existing
        # image content, it errors: 'cannot mount volume on non-empty path'.
        # Emptied here, as the last thing touching this path in the image,
        # so the directory exists but is empty by the time the Volume mounts
        # over it at runtime.
        f"rm -rf {COMFY_DIR}/models",
    )
    .run_commands(
        f"git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git"
        f" {COMFY_DIR}/custom_nodes/ComfyUI-VideoHelperSuite",
        # kijai/ComfyUI-KJNodes ships PathchSageAttentionKJ — a per-model
        # "patch this model to route through the sageattention package
        # built above" node. Note there's no separate "ComfyUI-EasyCache"
        # node pack to clone: EasyCache is a native node shipped in ComfyUI
        # core itself as of the pinned tag above
        # (comfy_extras/nodes_easycache.py), so it's already available.
        f"git clone https://github.com/kijai/ComfyUI-KJNodes.git"
        f" {COMFY_DIR}/custom_nodes/ComfyUI-KJNodes",
        f"pip install -r {COMFY_DIR}/custom_nodes/ComfyUI-KJNodes/requirements.txt",
        # Comfy-Org/ComfyUI-Manager is the current canonical location
        # (ltdrdata/ComfyUI-Manager now redirects here) — lets an admin
        # install/inspect further node packs from ComfyUI's own UI on top
        # of what's baked into this image.
        f"git clone https://github.com/Comfy-Org/ComfyUI-Manager.git"
        f" {COMFY_DIR}/custom_nodes/ComfyUI-Manager",
        f"pip install -r {COMFY_DIR}/custom_nodes/ComfyUI-Manager/requirements.txt",
    )
)

# Same five Wan 2.1 / Wan Animate 2 weights scripts/modal_wan_animate.py
# downloads, reused here so the workflow JSON's loader nodes resolve
# identically against the same shared Volume.
MODEL_FILES = [
    (
        "https://huggingface.co/Comfy-Org/Wan-Animate-2/resolve/main/diffusion_models/wan_animate_2_int8_convrot.safetensors",
        "diffusion_models",
        "wan_animate_2_int8_convrot.safetensors",
    ),
    (
        "https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors",
        "loras",
        "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors",
    ),
    (
        "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        "text_encoders",
        "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    ),
    (
        "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/clip_vision/clip_vision_h.safetensors",
        "clip_vision",
        "clip_vision_h.safetensors",
    ),
    (
        "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors",
        "vae",
        "Wan2_1_VAE_bf16.safetensors",
    ),
]

# Folders under MODELS_DIR — shared between ensure_models() and the storage
# admin's folder picker validation.
MODEL_SUBFOLDERS = ("diffusion_models", "text_encoders", "vae", "clip_vision", "loras")

# ComfyUI startup profile this file exists to ship. Both --gpu-only and
# --use-sage-attention are single choices, not additive flags — ComfyUI's
# main.py groups --gpu-only/--highvram/--lowvram/--novram/--cpu into one
# argparse mutually-exclusive group, and separately groups every
# --use-*-attention flag into another; passing two members of the same
# group crashes main.py before it even binds its port (confirmed against
# this deployment: "argument --highvram: not allowed with argument
# --gpu-only", then separately "argument --use-flash-attention: not allowed
# with argument --use-sage-attention").
#
# --gpu-only wins its group: per cli_args.py's own help text it's the
# strict superset of --highvram (also keeps text encoders/CLIP resident on
# GPU, not just the diffusion model, and disables ComfyUI's "dynamic vram"
# feature outright) — the actual real equivalent of "every model pinned in
# VRAM, no CPU offload" on a tier with 288GB to spare.
#
# --use-sage-attention wins its group: the from-source-built, sm_100-
# targeted SageAttention kernel. The from-source-built flash-attn kernel is
# still installed in the image and still registered as ComfyUI's "flash"
# attention function once imported, so per-model nodes (e.g. KJNodes'
# attention-override nodes) can still select it explicitly even though it's
# not this file's own default.
#
# Deliberately does NOT set disable_smart_memory: despite the name, that
# flag doesn't pin models in VRAM — it does the opposite. In
# comfy/model_management.py's free_memory(), DISABLE_SMART_MEMORY skips the
# normal "only unload enough to fit the new model" calculation and instead
# leaves memory_to_free at its 1e32 sentinel, so every other currently
# loaded model gets evicted on every load rather than just the minimum
# needed. That fights VRAM residency instead of helping it, so it's left
# off; --gpu-only alone already keeps weights off the CPU.
BLACKWELL_EXEC_CONFIG = {
    "gpu_only": True,
    "use_sage_attention": True,
}


def _authorize(request: fastapi.Request) -> None:
    """Shared bearer-token check for every endpoint in this file."""
    expected = os.environ.get("MODAL_AUTH_TOKEN")
    if not expected:
        raise fastapi.HTTPException(status_code=500, detail="Server auth is not configured.")

    provided = request.headers.get("x-modal-secret") or request.headers.get(
        "authorization", ""
    ).removeprefix("Bearer ").strip()

    if not provided or not hmac.compare_digest(provided, expected):
        raise fastapi.HTTPException(status_code=401, detail="Unauthorized")


def _validate_host(url: str, allowed_hosts: tuple, label: str) -> None:
    host = (urlparse(url).hostname or "").lower()
    if not any(host == h or host.endswith(f".{h}") for h in allowed_hosts):
        raise fastapi.HTTPException(
            status_code=400,
            detail=f"{label} host not allowed: {host or url!r} (allowed: {', '.join(allowed_hosts)})",
        )


_REPO_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")


def _is_valid_repo_id(repo_id: str) -> bool:
    """owner/name only (e.g. hotdogs/Qwen3.8-27B-Abliterated) — no nested
    paths, no '..'."""
    return bool(repo_id) and bool(_REPO_ID_RE.match(repo_id)) and ".." not in repo_id


def _sanitize_relative_dir(raw: str) -> str | None:
    """
    Normalizes a MODELS_DIR-relative directory path for the repo downloader.
    Unlike the single-file downloader, this isn't restricted to
    MODEL_SUBFOLDERS — a whole repo (an LLM, say) doesn't belong in one of
    ComfyUI's model-type folders. Returns None for anything that would
    escape MODELS_DIR (absolute paths, '..', empty segments).
    """
    if not raw or not raw.strip():
        return None
    candidate = raw.strip().strip("/")
    if not candidate:
        return None
    base = os.path.normpath(MODELS_DIR)
    full = os.path.normpath(os.path.join(base, candidate))
    if full == base or not full.startswith(base + os.sep):
        return None
    return os.path.relpath(full, base).replace(os.sep, "/")


@app.function(image=image, volumes={MODELS_DIR: vol}, timeout=1800)
def ensure_models():
    """Download any missing Wan model weights into the persistent volume."""
    import requests

    for url, subdir, filename in MODEL_FILES:
        dest_dir = os.path.join(MODELS_DIR, subdir)
        os.makedirs(dest_dir, exist_ok=True)
        dest_path = os.path.join(dest_dir, filename)

        if os.path.exists(dest_path) and os.path.getsize(dest_path) > 0:
            print(f"[ensure_models] already present: {dest_path}")
            continue

        print(f"[ensure_models] downloading {filename} ...")
        tmp_path = dest_path + ".part"
        with requests.get(url, stream=True, timeout=60) as r:
            r.raise_for_status()
            with open(tmp_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=8 * 1024 * 1024):
                    f.write(chunk)
        os.rename(tmp_path, dest_path)
        print(f"[ensure_models] done: {dest_path} ({os.path.getsize(dest_path)} bytes)")

    vol.commit()
    print("[ensure_models] volume committed.")


OUTPUTS_ALL_RETENTION_DAYS = 7


@app.function(image=image, volumes={MODELS_DIR: vol}, schedule=modal.Period(days=1), timeout=300)
def cleanup_old_outputs():
    """
    Deletes outputs/all/* older than OUTPUTS_ALL_RETENTION_DAYS. Shares the
    same Volume (and thus the same outputs/all/ archive) as
    scripts/modal_wan_animate.py's cleanup_old_outputs — both apps' schedules
    run independently, but they clean up the same data, so this is
    redundant rather than conflicting if both are deployed at once.
    """
    out_dir = os.path.join(MODELS_DIR, "outputs", "all")
    if not os.path.isdir(out_dir):
        print("[cleanup_old_outputs] outputs/all/ does not exist yet, nothing to do.")
        return

    cutoff = time.time() - OUTPUTS_ALL_RETENTION_DAYS * 24 * 60 * 60
    removed = 0
    for name in os.listdir(out_dir):
        path = os.path.join(out_dir, name)
        if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
            os.remove(path)
            removed += 1

    if removed:
        vol.commit()
    print(f"[cleanup_old_outputs] removed {removed} file(s) older than {OUTPUTS_ALL_RETENTION_DAYS} days.")


def _supabase_patch_download(download_id: str, fields: dict) -> None:
    """
    Best-effort PATCH of one model_downloads row (progress reporting for the
    admin Storage tab) — never raises, since a Supabase hiccup should never
    abort an in-flight model download.
    """
    import requests

    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        print("[model_downloads] Supabase env not configured, skipping progress update.")
        return

    try:
        requests.patch(
            f"{supabase_url}/rest/v1/model_downloads",
            params={"id": f"eq.{download_id}"},
            json={**fields, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001 — best-effort, never propagate
        print(f"[model_downloads] failed to update progress for {download_id}: {exc}")


# --- Async job reporting (Cinematic Video / MiniMax H3) -------------------
#
# WanAnimateBlackwell.run_custom_workflow's job_id-branch (see below) is
# spawned via custom_workflow_async and runs completely independently of
# the Next.js request that kicked it off — src/app/api/generate/cinematic/
# route.ts has already returned a jobId to the browser by the time this
# code runs. These helpers are how that spawned job reports its own
# completion/failure straight back to Supabase, mirroring
# _supabase_patch_download's role for model_downloads above. All best-
# effort (never raise): a Supabase hiccup at the tail end of a
# potentially many-minutes-long render must never turn into an unhandled
# exception that masks the actual render result.

# Mirrors WARM_EXTEND_SECONDS in src/lib/gpuWarm.ts — kept as a literal
# here rather than fetched at runtime since there's no clean way for this
# Python process to import a TypeScript constant; update both if it ever
# changes.
GPU_WARM_EXTEND_SECONDS = 60


def _supabase_request(method: str, path: str, **kwargs) -> "requests.Response | None":
    """Shared plumbing for the generation_jobs / profiles / active_generation_jobs
    / RPC calls below — every caller already treats a failure as best-effort,
    so this centralizes the "env not configured" bail-out and the
    apikey/Authorization headers rather than repeating them per call site."""
    import requests

    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        print("[generation_jobs] Supabase env not configured, skipping request.")
        return None

    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    return requests.request(method, f"{supabase_url}{path}", headers=headers, timeout=10, **kwargs)


def _supabase_patch_job(job_id: str, fields: dict) -> None:
    """Best-effort PATCH of one generation_jobs row — status/video_url/
    error_message, called from run_custom_workflow as the spawned job
    progresses and finishes."""
    if not job_id:
        return
    try:
        _supabase_request(
            "PATCH",
            "/rest/v1/generation_jobs",
            params={"id": f"eq.{job_id}"},
            json={**fields, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            headers={"Prefer": "return=minimal"},
        )
    except Exception as exc:  # noqa: BLE001 — best-effort, never propagate
        print(f"[generation_jobs] failed to update job {job_id}: {exc}")


def _refund_credits(user_id: str, amount: int) -> None:
    """Best-effort credit refund after a failed async generation — the
    Next.js route already debited `amount` credits up front and has long
    since returned its response by the time a failure is detected here, so
    this is what actually issues the refund (mirrors the synchronous
    snapshot-restore refund /api/generate/cinematic used to do inline,
    same read-then-write race tradeoff and all)."""
    if not user_id or amount <= 0:
        return
    try:
        res = _supabase_request(
            "GET",
            "/rest/v1/profiles",
            params={"id": f"eq.{user_id}", "select": "credits"},
        )
        if res is None:
            return
        res.raise_for_status()
        rows = res.json()
        current = (rows[0].get("credits") if rows else None) or 0
        _supabase_request(
            "PATCH",
            "/rest/v1/profiles",
            params={"id": f"eq.{user_id}"},
            json={"credits": current + amount},
            headers={"Prefer": "return=minimal"},
        )
    except Exception as exc:  # noqa: BLE001 — best-effort, never propagate
        print(f"[generation_jobs] failed to refund {amount} credits to {user_id}: {exc}")


def _clear_active_job(active_job_id: str) -> None:
    """Best-effort removal of one active_generation_jobs row — the
    admin GPU task manager's "running now" list (see
    src/lib/activeGenerationJobs.ts). The synchronous /api/generate/
    cinematic route used to always clear this itself in a `finally` block;
    for the async job it has to be cleared from here instead, since that
    request returns long before the render actually finishes."""
    if not active_job_id:
        return
    try:
        _supabase_request(
            "DELETE",
            "/rest/v1/active_generation_jobs",
            params={"id": f"eq.{active_job_id}"},
        )
    except Exception as exc:  # noqa: BLE001 — best-effort, never propagate
        print(f"[generation_jobs] failed to clear active job {active_job_id}: {exc}")


def _extend_gpu_warm(user_id: str) -> None:
    """Best-effort call to the same extend_gpu_warm() Postgres RPC
    src/lib/gpuWarmAutoExtend.ts calls after a successful *synchronous*
    generation — free side effect of a successful render, replicated here
    since the async job has no live Next.js request left to call it from
    by the time it actually succeeds."""
    if not user_id:
        return
    try:
        _supabase_request(
            "POST",
            "/rest/v1/rpc/extend_gpu_warm",
            json={"p_user_id": user_id, "p_seconds": GPU_WARM_EXTEND_SECONDS},
        )
    except Exception as exc:  # noqa: BLE001 — best-effort, never propagate
        print(f"[generation_jobs] failed to auto-extend GPU warm for {user_id}: {exc}")


@app.function(
    image=image,
    volumes={MODELS_DIR: vol},
    timeout=3600,
    secrets=[modal.Secret.from_name("supabase-model-downloads")],
)
def download_model_async(download_id: str, url: str, subfolder: str, filename: str):
    """Background half of ModalStorageBlackwell._download_async — streams
    `url` into MODELS_DIR/subfolder/filename via .spawn(), reporting
    progress into `download_id`'s model_downloads row as it goes."""
    import requests

    def update(**fields):
        _supabase_patch_download(download_id, fields)

    try:
        if subfolder not in MODEL_SUBFOLDERS or "/" in filename or ".." in filename:
            raise ValueError("Invalid subfolder or filename.")

        update(status="downloading", progress_percent=0)

        dest_dir = os.path.join(MODELS_DIR, subfolder)
        os.makedirs(dest_dir, exist_ok=True)
        dest_path = os.path.join(dest_dir, filename)
        tmp_path = dest_path + ".part"

        with requests.get(url, stream=True, timeout=60) as r:
            r.raise_for_status()
            total = int(r.headers.get("content-length") or 0)
            written = 0
            last_reported = -1
            with open(tmp_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=8 * 1024 * 1024):
                    f.write(chunk)
                    written += len(chunk)
                    if total > 0:
                        percent = min(99, int(written * 100 / total))
                        if percent != last_reported:
                            update(progress_percent=percent)
                            last_reported = percent

        os.rename(tmp_path, dest_path)
        vol.commit()
        update(status="completed", progress_percent=100)
    except Exception as exc:
        update(status="failed", error_message=str(exc)[:500])
        raise


@app.function(
    image=image,
    volumes={MODELS_DIR: vol},
    timeout=7200,
    secrets=[modal.Secret.from_name("supabase-model-downloads")],
)
def download_repo_async(download_id: str, repo_id: str, save_dir: str):
    """Background half of ModalStorageBlackwell._download_repo_async —
    snapshot_downloads an entire Hugging Face repo into MODELS_DIR/save_dir
    via .spawn(), polling save_dir's size on disk against an upfront
    estimate (HfApi.model_info) to report progress."""
    import threading

    from huggingface_hub import HfApi, snapshot_download

    def update(**fields):
        _supabase_patch_download(download_id, fields)

    dest_dir = os.path.join(MODELS_DIR, save_dir)
    stop_progress = threading.Event()

    try:
        os.makedirs(dest_dir, exist_ok=True)
        update(status="downloading", progress_percent=0)

        total_bytes = 0
        try:
            info = HfApi().model_info(repo_id, files_metadata=True)
            total_bytes = sum((s.size or 0) for s in (info.siblings or []))
        except Exception as exc:  # noqa: BLE001 — size estimate is best-effort
            print(f"[download_repo_async] could not estimate size for {repo_id}: {exc}")

        def _poll_progress():
            last_reported = -1
            while not stop_progress.wait(2):
                if total_bytes <= 0:
                    continue
                written = 0
                for root, _dirs, filenames in os.walk(dest_dir):
                    for name in filenames:
                        try:
                            written += os.path.getsize(os.path.join(root, name))
                        except OSError:
                            continue
                percent = min(99, int(written * 100 / total_bytes))
                if percent != last_reported:
                    update(progress_percent=percent)
                    last_reported = percent

        progress_thread = threading.Thread(target=_poll_progress, daemon=True)
        progress_thread.start()

        try:
            snapshot_download(
                repo_id=repo_id,
                local_dir=dest_dir,
                ignore_patterns=[".gitattributes", ".gitignore"],
            )
        finally:
            stop_progress.set()
            progress_thread.join(timeout=5)

        vol.commit()
        update(status="completed", progress_percent=100)
    except Exception as exc:
        stop_progress.set()
        update(status="failed", error_message=str(exc)[:500])
        raise


# `scaledown_window` is this SDK's current name for what used to be
# `container_idle_timeout` (modal 1.5.4 rejects values below 2). 60s mirrors
# scripts/modal_wan_animate.py's WanAnimateUltra — cold starts on this tier
# are expensive enough that a short grace window is worth the idle billing.
@app.cls(
    image=image,
    gpu=GPU_TYPE,
    # 30 min, not 10 — run_custom_workflow can be pointed at far larger
    # checkpoints than the Wan Animate 2 weights this default was originally
    # sized for (e.g. MiniMax H3's BF16 diffusion model + text encoder are
    # ~118GB combined), and a cold container's first-ever load of those off
    # the Volume can plausibly exceed 10 minutes on its own.
    timeout=1800,
    scaledown_window=60,
    volumes={MODELS_DIR: vol},
    # supabase-model-downloads: despite the name, this is just generic
    # SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY credentials (see
    # _supabase_patch_download above) — reused here so run_custom_workflow's
    # async-job branch can report straight to generation_jobs/profiles/
    # active_generation_jobs without a live Next.js request to do it from.
    secrets=[modal.Secret.from_name("wan-animate-auth"), modal.Secret.from_name("supabase-model-downloads")],
)
class WanAnimateBlackwell:
    @modal.enter()
    def setup(self):
        # Model folders (diffusion_models/, loras/, text_encoders/,
        # clip_vision/, vae/) need no setup-time work — the Volume is
        # mounted directly at MODELS_DIR (== COMFY_DIR/models), so they're
        # already exactly where ComfyUI's folder_paths.py expects them.
        #
        # Custom nodes installed via the admin Storage tab
        # (ModalStorageBlackwell.install_node) land in
        # MODELS_DIR/custom_nodes/ (a sibling of diffusion_models/ etc. on
        # the Volume), not COMFY_DIR/custom_nodes/ where ComfyUI actually
        # looks — so each one still needs an individual symlink, the same
        # way scripts/modal_wan_animate.py does it. Linked in individually
        # rather than replacing custom_nodes/ wholesale so the packs baked
        # into the image at build time (VideoHelperSuite, KJNodes, Manager)
        # are left alone.
        volume_nodes_dir = os.path.join(MODELS_DIR, CUSTOM_NODES_SUBDIR)
        os.makedirs(volume_nodes_dir, exist_ok=True)
        for name in os.listdir(volume_nodes_dir):
            src = os.path.join(volume_nodes_dir, name)
            if not os.path.isdir(src):
                continue
            dst = os.path.join(COMFY_DIR, "custom_nodes", name)
            if os.path.islink(dst):
                os.remove(dst)
            elif os.path.exists(dst):
                continue  # an image-baked dir with this name wins
            os.symlink(src, dst)

        # ComfyUI itself is NOT started here — several of the exec-config
        # flags below are parsed once by ComfyUI at process startup and
        # never re-read, so the only way to actually apply them is to
        # launch main.py with the right flags in the first place. See
        # _ensure_comfy_running, called from generate_video /
        # run_custom_workflow instead.
        self._proc = None
        self._comfy_flags = None

    def _wait_for_server(self, timeout=120):
        import urllib.request

        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=2)
                return
            except Exception:
                time.sleep(1)
        raise RuntimeError("ComfyUI server did not come up within the timeout.")

    def _ensure_comfy_running(self, exec_config):
        """
        Starts ComfyUI on first use, and restarts it whenever the requested
        exec_config differs from what it's currently running with — these
        are all process-startup-only ComfyUI CLI flags (verified against
        comfy/model_management.py in the pinned ComfyUI version), so there
        is no way to apply them to an already-running process.
        """
        import shlex
        import subprocess

        cfg = exec_config if exec_config is not None else BLACKWELL_EXEC_CONFIG
        normalized = (
            bool(cfg.get("disable_smart_memory", False)),
            bool(cfg.get("cpu_vae", False)),
            bool(cfg.get("gpu_only", False)),
            bool(cfg.get("use_pytorch_cross_attention", False)),
            bool(cfg.get("use_sage_attention", False)),
            bool(cfg.get("use_flash_attention", False)),
            bool(cfg.get("high_vram", False)),
            str(cfg.get("extra_args") or "").strip(),
        )

        if self._proc is not None and self._proc.poll() is None and self._comfy_flags == normalized:
            return  # already running with these exact flags

        if self._proc is not None and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=5)

        (
            disable_smart_memory,
            cpu_vae,
            gpu_only,
            use_pytorch_cross_attention,
            use_sage_attention,
            use_flash_attention,
            high_vram,
            extra_args,
        ) = normalized
        try:
            extra_tokens = shlex.split(extra_args)
        except ValueError as exc:
            raise RuntimeError(f"extra_args could not be parsed: {exc}") from exc

        argv = ["python", "main.py"]
        argv += extra_tokens
        if disable_smart_memory:
            argv.append("--disable-smart-memory")
        if cpu_vae:
            argv.append("--cpu-vae")
        # ComfyUI's main.py also puts --gpu-only / --highvram / --lowvram /
        # --novram / --cpu in one argparse mutually-exclusive group (same
        # failure mode as the attention flags below: passing two of them
        # crashes main.py before the server even binds). --gpu-only is the
        # strict superset of --highvram here — per cli_args.py, --gpu-only
        # additionally keeps text encoders/CLIP on GPU too and disables
        # ComfyUI's "dynamic vram" feature outright — so it wins when both
        # are requested.
        if gpu_only:
            argv.append("--gpu-only")
        elif high_vram:
            argv.append("--highvram")
        # ComfyUI's main.py puts --use-pytorch-cross-attention /
        # --use-sage-attention / --use-flash-attention (among others) in a
        # single argparse mutually-exclusive group — passing more than one
        # crashes the process before it even starts (argparse error, not a
        # Python exception _ensure_comfy_running could catch). Sage wins
        # when both are requested, matching ComfyUI core's own preference
        # order between the two once both are actually available
        # (attention.py: sage_attention_enabled() is checked before
        # flash_attention_enabled()).
        if use_sage_attention:
            argv.append("--use-sage-attention")
        elif use_flash_attention:
            argv.append("--use-flash-attention")
        elif use_pytorch_cross_attention:
            argv.append("--use-pytorch-cross-attention")
        # Fixed and placed last so nothing smuggled into extra_args can
        # rebind the server off its expected address/port.
        argv += ["--listen", "0.0.0.0", "--port", "8188"]

        self._proc = subprocess.Popen(argv, cwd=COMFY_DIR)
        self._wait_for_server()
        self._comfy_flags = normalized

    def _write_inputs(self, files):
        """files: list of (filename, bytes) to place under ComfyUI's input/ dir."""
        input_dir = os.path.join(COMFY_DIR, "input")
        os.makedirs(input_dir, exist_ok=True)
        for filename, data in files:
            with open(os.path.join(input_dir, filename), "wb") as f:
                f.write(data)

    def _run_workflow(self, workflow, files, output_node_id=None):
        """
        files: list of (filename, bytes) referenced by the workflow's loader
        nodes. output_node_id: if given, that node's output in ComfyUI's
        /history response is read first — falls back to a generic scan
        (across all nodes) if it's unset, absent, or doesn't resolve to an
        actual file, so an admin-mistyped id never breaks generation.
        """
        import uuid

        import requests

        self._write_inputs(files)

        client_id = str(uuid.uuid4())
        output_dir = os.path.join(COMFY_DIR, "output")
        os.makedirs(output_dir, exist_ok=True)
        pre_existing = {
            os.path.join(root, f)
            for root, _dirs, files in os.walk(output_dir)
            for f in files
        }

        resp = requests.post(
            "http://127.0.0.1:8188/prompt",
            json={"prompt": workflow, "client_id": client_id},
            timeout=30,
        )
        if not resp.ok:
            try:
                error_body = json.dumps(resp.json(), ensure_ascii=False, indent=2)
            except ValueError:
                error_body = resp.text
            print(f"❌ [ComfyUI /prompt error] status={resp.status_code} body={error_body}")
            raise RuntimeError(
                f"ComfyUI /prompt rejected the workflow (status {resp.status_code}): {error_body[:4000]}"
            )
        submit_result = resp.json()
        prompt_id = submit_result.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"/prompt did not return a prompt_id: {submit_result}")

        deadline = time.time() + 550
        while time.time() < deadline:
            hist = requests.get(f"http://127.0.0.1:8188/history/{prompt_id}", timeout=30).json()
            if prompt_id in hist:
                entry = hist[prompt_id]
                status = entry.get("status", {})
                outputs = entry.get("outputs", {})

                ordered_node_outputs = list(outputs.values())
                if output_node_id and output_node_id in outputs:
                    ordered_node_outputs = [outputs[output_node_id]] + [
                        v for k, v in outputs.items() if k != output_node_id
                    ]

                for node_output in ordered_node_outputs:
                    for key in ("video", "videos", "gifs", "images"):
                        if key in node_output:
                            for item in node_output[key]:
                                subfolder = item.get("subfolder", "")
                                out_path = os.path.join(output_dir, subfolder, item["filename"])
                                if os.path.exists(out_path):
                                    with open(out_path, "rb") as f:
                                        return f.read(), item["filename"]

                post_existing = {
                    os.path.join(root, f)
                    for root, _dirs, files in os.walk(output_dir)
                    for f in files
                }
                new_files = sorted(post_existing - pre_existing, key=os.path.getmtime)
                if new_files:
                    newest = new_files[-1]
                    with open(newest, "rb") as f:
                        return f.read(), os.path.basename(newest)

                raise RuntimeError(
                    f"Prompt finished but no output file found.\n"
                    f"status: {json.dumps(status)}\n"
                    f"outputs: {json.dumps(outputs)}\n"
                    f"output/ dir contents: {sorted(post_existing)}"
                )
            time.sleep(2)
        raise TimeoutError("Timed out waiting for ComfyUI to finish the workflow.")

    def _append_log(self, status, duration_s, filename=None, error=None):
        log_dir = os.path.join(MODELS_DIR, LOGS_SUBDIR)
        os.makedirs(log_dir, exist_ok=True)
        entry = {
            "ts": time.time(),
            "gpu_tier": GPU_TIER,
            "status": status,
            "duration_s": round(duration_s, 1),
            "filename": filename,
            "error": error,
        }
        with open(os.path.join(log_dir, COMFYUI_LOG_FILENAME), "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        vol.commit()

    def _save_output_to_volume(self, filename, data):
        """Persists a generated output into outputs/admin/, timestamp-
        prefixed so repeated filenames never collide."""
        import datetime

        out_dir = os.path.join(MODELS_DIR, "outputs", "admin")
        os.makedirs(out_dir, exist_ok=True)
        ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d_%H%M%S")
        saved_name = f"{ts}_{filename}"
        with open(os.path.join(out_dir, saved_name), "wb") as f:
            f.write(data)
        vol.commit()
        return saved_name

    def _save_output_temp(self, filename, data):
        """Persists EVERY generation's output into outputs/all/ for the
        Admin logs preview — cleaned up after 7 days by cleanup_old_outputs.
        UUID-prefixed since concurrent requests can share a filename."""
        import uuid

        out_dir = os.path.join(MODELS_DIR, "outputs", "all")
        os.makedirs(out_dir, exist_ok=True)
        saved_name = f"{uuid.uuid4().hex}_{filename}"
        with open(os.path.join(out_dir, saved_name), "wb") as f:
            f.write(data)
        vol.commit()
        return f"outputs/all/{saved_name}"

    @modal.method()
    def generate_video(
        self,
        workflow_json: str,
        reference_image_b64: str,
        reference_image_name: str,
        pose_video_b64: str,
        pose_video_name: str,
        save_to_volume: bool = False,
    ) -> dict:
        self._ensure_comfy_running(BLACKWELL_EXEC_CONFIG)
        workflow = json.loads(workflow_json)
        started = time.time()
        try:
            video_bytes, filename = self._run_workflow(
                workflow,
                [
                    (reference_image_name, base64.b64decode(reference_image_b64)),
                    (pose_video_name, base64.b64decode(pose_video_b64)),
                ],
            )
        except Exception as exc:
            self._append_log("failed", time.time() - started, error=str(exc)[:500])
            raise
        self._append_log("success", time.time() - started, filename=filename)
        if save_to_volume:
            self._save_output_to_volume(filename, video_bytes)
        output_path = self._save_output_temp(filename, video_bytes)
        return {
            "filename": filename,
            "video_base64": base64.b64encode(video_bytes).decode("ascii"),
            "gpu_tier": GPU_TIER,
            "output_path": output_path,
        }

    # Same request/response JSON shape as scripts/modal_wan_animate.py's
    # WanAnimate(Ultra).generate — see src/lib/modalWanAnimate.ts, which
    # only cares about {filename, video_base64, output_path} in the
    # response and doesn't hardcode which Modal app served it.
    @modal.fastapi_endpoint(method="POST")
    def generate(self, item: dict, request: fastapi.Request):
        _authorize(request)
        return self.generate_video.local(
            item["workflow_json"],
            item["reference_image_b64"],
            item["reference_image_name"],
            item["pose_video_b64"],
            item["pose_video_name"],
            item.get("save_to_volume", False),
        )

    @modal.method()
    def run_custom_workflow(
        self,
        workflow_json: str,
        files_b64: dict,
        exec_config: dict = None,
        save_to_volume: bool = False,
        output_node_id: str = None,
        job_id: str = None,
        user_id: str = None,
        credits_cost: int = 0,
        active_job_id: str = None,
    ) -> dict:
        """
        Generic counterpart to generate_video for admin-authored Custom
        Workflows: any ComfyUI API-format graph, any number of input files.
        exec_config defaults to BLACKWELL_EXEC_CONFIG (see
        _ensure_comfy_running) rather than ComfyUI's own conservative
        defaults when the caller doesn't specify one — unlike
        scripts/modal_wan_animate.py's Standard tier, there's no reason to
        ever run this GPU below its fully-pinned-VRAM / sage-attention
        profile. An explicit exec_config from the caller still overrides it.

        job_id / user_id / credits_cost / active_job_id are only set on the
        async path (see custom_workflow_async below, currently Cinematic
        Video's only caller) — when job_id is given, this reports its own
        progress/completion/failure straight to Supabase as it goes,
        since by the time this actually runs (possibly many minutes after
        being spawned) the Next.js request that kicked it off has long
        since returned. Called with job_id=None (the plain synchronous
        path — still how custom_workflow below invokes this), none of that
        reporting happens and behavior is unchanged from before.
        """
        is_async = job_id is not None
        started = time.time()
        if is_async:
            _supabase_patch_job(job_id, {"status": "processing"})
        try:
            self._ensure_comfy_running(exec_config)
            workflow = json.loads(workflow_json)
            files = [(name, base64.b64decode(b64)) for name, b64 in files_b64.items()]
            result_bytes, filename = self._run_workflow(workflow, files, output_node_id=output_node_id or None)
        except Exception as exc:
            self._append_log("failed", time.time() - started, error=str(exc)[:500])
            if is_async:
                _supabase_patch_job(job_id, {"status": "failed", "error_message": str(exc)[:2000]})
                _refund_credits(user_id, credits_cost)
                _clear_active_job(active_job_id)
            raise
        self._append_log("success", time.time() - started, filename=filename)
        if save_to_volume:
            self._save_output_to_volume(filename, result_bytes)
        output_path = self._save_output_temp(filename, result_bytes)
        result_base64 = base64.b64encode(result_bytes).decode("ascii")
        result = {
            "filename": filename,
            "result_base64": result_base64,
            "gpu_tier": GPU_TIER,
            "output_path": output_path,
        }
        if is_async:
            # Stored as a data: URI directly in generation_jobs.video_url
            # rather than uploaded to object storage — deliberately simple
            # for this first async-job rollout (Cinematic only), consistent
            # with this app's existing "videos are never durably stored
            # server-side" privacy posture (see CinematicVideoTab.tsx's own
            # notice). Worth revisiting if/when this expands to other
            # workflow types or job history becomes a real feature: a hot
            # table growing multi-MB text rows isn't a great long-term fit.
            _supabase_patch_job(
                job_id, {"status": "completed", "video_url": f"data:video/mp4;base64,{result_base64}"}
            )
            _extend_gpu_warm(user_id)
            _clear_active_job(active_job_id)
        return result

    @modal.fastapi_endpoint(method="POST")
    def custom_workflow(self, item: dict, request: fastapi.Request):
        """Unchanged, fully-synchronous path — left as-is for any caller
        that still wants the old "block until done, get the result inline"
        behavior. Cinematic Video no longer uses this (see
        custom_workflow_async below)."""
        _authorize(request)
        return self.run_custom_workflow.local(
            item["workflow_json"],
            item["files_b64"],
            item.get("exec_config"),
            item.get("save_to_volume", False),
            item.get("output_node_id"),
        )


# GPU-less dispatcher for Cinematic Video's async job path — exists purely
# to accept the "start rendering this job" request and hand it off via
# .spawn() instantly, regardless of whether WanAnimateBlackwell currently
# has a warm B300 container or needs to cold-start one. This is
# deliberately NOT a fastapi_endpoint *method* of the GPU-attached
# WanAnimateBlackwell class (like custom_workflow above): invoking a
# fastapi_endpoint method on a GPU class still requires Modal to provision
# a GPU container just to run that method's body, even if the body itself
# is trivial — which would reintroduce the exact cold-start wait the async
# conversion exists to remove from this request's critical path. A plain
# function has no such requirement; .spawn() schedules the real work and
# returns a call handle without the caller (or Modal) needing to wait for
# a container at all.
@app.function(image=image, secrets=[modal.Secret.from_name("wan-animate-auth")])
@modal.fastapi_endpoint(method="POST")
def custom_workflow_async(item: dict, request: fastapi.Request):
    _authorize(request)
    job_id = item.get("job_id")
    if not job_id:
        raise fastapi.HTTPException(status_code=400, detail="job_id is required.")

    call = WanAnimateBlackwell().run_custom_workflow.spawn(
        item["workflow_json"],
        item["files_b64"],
        item.get("exec_config"),
        item.get("save_to_volume", False),
        item.get("output_node_id"),
        job_id,
        item.get("user_id"),
        item.get("credits_cost", 0),
        item.get("active_job_id"),
    )
    return {"ok": True, "job_id": job_id, "call_id": call.object_id}


@app.cls(
    image=image,
    timeout=300,
    scaledown_window=2,
    volumes={MODELS_DIR: vol},
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
class ModalStorageBlackwell:
    """
    GPU-less volume/custom-node management, mirroring ModalStorage in
    scripts/modal_wan_animate.py action-for-action (list / download_async /
    download_repo_async / read_file / delete / delete_dir / install_node /
    logs) so the admin Storage tab (POST /api/admin/modal/storage) works
    unchanged if MODAL_STORAGE_URL is pointed at this app instead.
    """

    def _list(self) -> dict:
        files = []
        for root, _dirs, filenames in os.walk(MODELS_DIR):
            for name in filenames:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, MODELS_DIR).replace(os.sep, "/")
                st = os.stat(full)
                files.append(
                    {
                        "path": rel,
                        "size_bytes": st.st_size,
                        "modified_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime)),
                    }
                )
        return {"files": files}

    def _download_async(self, item: dict) -> dict:
        url = item["url"]
        subfolder = item["subfolder"]
        filename = item["filename"]
        download_id = item["download_id"]
        _validate_host(url, ALLOWED_DOWNLOAD_HOSTS, "download")
        if subfolder not in MODEL_SUBFOLDERS or "/" in filename or ".." in filename:
            raise fastapi.HTTPException(status_code=400, detail="Invalid subfolder or filename.")

        download_model_async.spawn(download_id, url, subfolder, filename)
        return {"ok": True, "spawned": True}

    def _download_repo_async(self, item: dict) -> dict:
        repo_id = item["repo_id"]
        download_id = item["download_id"]

        if not _is_valid_repo_id(repo_id):
            raise fastapi.HTTPException(status_code=400, detail="Invalid repo_id.")
        save_dir = _sanitize_relative_dir(item.get("save_dir", ""))
        if save_dir is None:
            raise fastapi.HTTPException(status_code=400, detail="Invalid save_dir.")

        download_repo_async.spawn(download_id, repo_id, save_dir)
        return {"ok": True, "spawned": True}

    def _read_file(self, item: dict) -> dict:
        rel_path = item["file_path"]
        base = os.path.normpath(MODELS_DIR)
        full = os.path.normpath(os.path.join(base, rel_path))
        if not (full == base or full.startswith(base + os.sep)):
            raise fastapi.HTTPException(status_code=400, detail="Invalid file_path.")
        if not os.path.isfile(full):
            raise fastapi.HTTPException(status_code=404, detail="File not found.")
        with open(full, "rb") as f:
            data = f.read()
        return {"filename": os.path.basename(full), "base64": base64.b64encode(data).decode("ascii")}

    def _delete(self, item: dict) -> dict:
        rel_path = item["file_path"]
        base = os.path.normpath(MODELS_DIR)
        full = os.path.normpath(os.path.join(base, rel_path))
        if not (full == base or full.startswith(base + os.sep)):
            raise fastapi.HTTPException(status_code=400, detail="Invalid file_path.")
        if not os.path.isfile(full):
            raise fastapi.HTTPException(status_code=404, detail="File not found.")
        os.remove(full)
        vol.commit()
        return {"ok": True}

    def _delete_dir(self, item: dict) -> dict:
        import shutil

        rel_path = item["file_path"]
        base = os.path.normpath(MODELS_DIR)
        full = os.path.normpath(os.path.join(base, rel_path))
        if not full.startswith(base + os.sep) or full == base:
            raise fastapi.HTTPException(status_code=400, detail="Invalid file_path.")
        if not os.path.isdir(full):
            raise fastapi.HTTPException(status_code=404, detail="Directory not found.")
        shutil.rmtree(full)
        vol.commit()
        return {"ok": True}

    def _install_node(self, item: dict) -> dict:
        import re
        import subprocess

        git_url = item["git_url"]
        _validate_host(git_url, ALLOWED_GIT_HOSTS, "git")
        name = re.sub(r"\.git$", "", git_url.rstrip("/").split("/")[-1])
        if not re.match(r"^[A-Za-z0-9_-]+$", name):
            raise fastapi.HTTPException(status_code=400, detail="Could not derive a safe repo name from git_url.")

        nodes_dir = os.path.join(MODELS_DIR, CUSTOM_NODES_SUBDIR)
        os.makedirs(nodes_dir, exist_ok=True)
        dest = os.path.join(nodes_dir, name)
        if os.path.exists(dest):
            raise fastapi.HTTPException(status_code=409, detail=f"'{name}' is already installed.")
        subprocess.run(["git", "clone", "--depth", "1", git_url, dest], check=True, timeout=120)
        vol.commit()
        return {"ok": True, "name": name}

    def _logs(self, item: dict) -> dict:
        limit = item.get("limit") or 100
        log_path = os.path.join(MODELS_DIR, LOGS_SUBDIR, COMFYUI_LOG_FILENAME)
        if not os.path.exists(log_path):
            return {"entries": []}
        with open(log_path, "r", encoding="utf-8") as f:
            lines = f.readlines()[-limit:]
        entries = []
        for line in lines:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        entries.reverse()  # newest first
        return {"entries": entries}

    @modal.fastapi_endpoint(method="POST")
    def handle(self, item: dict, request: fastapi.Request):
        _authorize(request)
        action = item.get("action")
        if action == "list":
            return self._list()
        if action == "download_async":
            return self._download_async(item)
        if action == "download_repo_async":
            return self._download_repo_async(item)
        if action == "read_file":
            return self._read_file(item)
        if action == "delete":
            return self._delete(item)
        if action == "delete_dir":
            return self._delete_dir(item)
        if action == "install_node":
            return self._install_node(item)
        if action == "logs":
            return self._logs(item)
        raise fastapi.HTTPException(status_code=400, detail=f"Unknown action: {action!r}")


@app.local_entrypoint()
def main():
    workflow_path = os.environ.get("WAN_WORKFLOW_PATH", "C:/Users/t-num/Downloads/wan_animate2.json")
    reference_image_path = os.environ.get(
        "WAN_REFERENCE_IMAGE_PATH",
        "D:/ComfyUI/ComfyUI_windows_portable/ComfyUI/input/260811_00002_lu.png",
    )
    pose_video_path = os.environ.get(
        "WAN_POSE_VIDEO_PATH",
        "D:/ComfyUI/ComfyUI_windows_portable/ComfyUI/input/"
        "この画像を元に動画を作成して。アニメーション風にして、ストー.mp4",
    )

    print("[main] ensuring Wan model weights are present in the volume...")
    ensure_models.remote()

    print(f"[main] workflow: {workflow_path}")
    print(f"[main] reference image: {reference_image_path}")
    print(f"[main] pose video: {pose_video_path}")

    with open(workflow_path, "r", encoding="utf-8") as f:
        workflow = json.load(f)
    if "246" in workflow and workflow["246"].get("class_type") == "SaveVideo":
        workflow["246"]["inputs"]["format"] = "mp4"
        workflow["246"]["inputs"]["codec"] = "h264"
    workflow_json = json.dumps(workflow)
    with open(reference_image_path, "rb") as f:
        reference_image_b64 = base64.b64encode(f.read()).decode("ascii")
    with open(pose_video_path, "rb") as f:
        pose_video_b64 = base64.b64encode(f.read()).decode("ascii")

    print("[main] submitting test generation job on Modal GPU...")
    started = time.time()
    service = WanAnimateBlackwell()
    result = service.generate_video.remote(
        workflow_json,
        reference_image_b64,
        os.path.basename(reference_image_path),
        pose_video_b64,
        os.path.basename(pose_video_path),
    )
    elapsed = time.time() - started

    out_path = pathlib.Path("output_wan_animate_blackwell_modal.mp4")
    out_path.write_bytes(base64.b64decode(result["video_base64"]))
    print(f"[main] saved output -> {out_path.resolve()} ({out_path.stat().st_size} bytes)")
    print(f"[main] total wall time: {elapsed:.1f}s")
