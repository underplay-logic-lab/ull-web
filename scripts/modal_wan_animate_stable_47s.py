"""
Wan Animate 2 on Modal — GPU inference service backed by a persistent Volume.

Clones ComfyUI's master branch (targeting the v0.31.0+ native Wan Animate 2
support) fresh at image-build time, installs a couple of supporting custom
node packs, and downloads the Wan 2.1 / Wan Animate 2 model weights into a
Modal Volume on first run so subsequent cold starts skip the download.

Two GPU tiers are deployed from the same codebase (see _WanAnimateBase):
  - WanAnimate      (Standard, gpu="L40S", 48GB VRAM)
  - WanAnimateUltra  (ULTRA, gpu="B300", 288GB VRAM)
The B300 string is sent to Modal as-is (the SDK doesn't validate GPU names
client-side — see parse_gpu_config in modal/_utils/function_utils.py); if
that GPU class isn't actually available on Modal, generation on the ULTRA
tier will fail at request time even though this file deploys cleanly. Swap
ULTRA_GPU_TYPE below to a confirmed-available type if that happens.

A separate, GPU-less ModalStorage class exposes volume/custom-node
management (list/download/delete/install) behind the same shared-secret
auth as generation, for the admin-only Modal Storage tab in /admin.

Usage:
  modal run scripts/modal_wan_animate.py
    - ensures models are present in the volume, then submits a one-off test
      generation using the same local reference image / pose video / API
      workflow JSON that scripts/test-wan-animate.ts uses against RunPod.

  modal deploy scripts/modal_wan_animate.py
    - publishes the FastAPI POST endpoints for external use.

Env overrides (mirrors scripts/test-wan-animate.ts):
  WAN_WORKFLOW_PATH, WAN_REFERENCE_IMAGE_PATH, WAN_POSE_VIDEO_PATH
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

app = modal.App("ull-wan-animate")

MODELS_DIR = "/models"
COMFY_DIR = "/root/comfy/ComfyUI"
CUSTOM_NODES_SUBDIR = "custom_nodes"
LOGS_SUBDIR = "_logs"
COMFYUI_LOG_FILENAME = "comfyui.log"

STANDARD_GPU_TYPE = "L40S"
ULTRA_GPU_TYPE = "B300"

# Model-management endpoints only accept URLs/git remotes from these hosts —
# both are admin-only, but they're still "fetch this remote thing onto our
# server" primitives, so keep the blast radius of a compromised admin
# account bounded to known-good model/code sources.
ALLOWED_DOWNLOAD_HOSTS = ("huggingface.co", "civitai.com")
ALLOWED_GIT_HOSTS = ("github.com",)

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)


def _reload_volume(tag: str) -> None:
    """Best-effort vol.reload() — pull the latest committed Volume state into
    this container. Used before admin mutate/list operations so a warm
    container never acts on (or reports) a stale snapshot. Never fatal: a
    reload can fail if files are held open, and a stale-but-present view is
    still better than a hard error."""
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[{tag}] vol.reload() skipped: {exc}", flush=True)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "git", "ffmpeg", "libgl1-mesa-glx", "libglib2.0-0", "wget",
        # Needed to compile SageAttention's CUDA kernels from source below —
        # a C/C++ toolchain (build-essential) and a fast build system
        # (ninja-build) that its setup.py shells out to for the actual
        # nvcc invocations.
        "build-essential", "ninja-build",
    )
    # The PyPI "sageattention" wheel (previously installed here) is a
    # pure-Python package that JIT-compiles its Triton kernels at runtime —
    # it never shipped a prebuilt kernel for Blackwell (sm_100, i.e. the
    # ULTRA tier's B300), and Triton's JIT path doesn't reliably target that
    # architecture either. Building the real thu-ml/SageAttention CUDA
    # extension from source (below) is what actually gets fast attention on
    # B300 — which means an actual nvcc, not just the CUDA *runtime* libs
    # torch's pip wheel bundles. debian_slim ships neither, so NVIDIA's own
    # apt repo is added here to install just the toolkit (nvcc + headers),
    # matching the cu130 (CUDA 13.0) pip wheel index used for torch below so
    # the extension links against the same CUDA version torch expects.
    .run_commands(
        "wget https://developer.download.nvidia.com/compute/cuda/repos/debian12/x86_64/cuda-keyring_1.1-1_all.deb",
        "dpkg -i cuda-keyring_1.1-1_all.deb",
        "apt-get update",
        "apt-get install -y cuda-toolkit-13-0",
        "rm cuda-keyring_1.1-1_all.deb",
    )
    # Pulled from the cu130 (CUDA 13.0) wheel index in its own pip_install
    # call so it doesn't drag the other packages onto that index too —
    # required for SageAttention 2.2 / Triton to link against a matching
    # CUDA runtime.
    .pip_install(
        "torch",
        "torchvision",
        "torchaudio",
        extra_index_url="https://download.pytorch.org/whl/cu130",
    )
    .env(
        {
            "CUDA_HOME": "/usr/local/cuda",
            # Prepended onto Debian's own default secure_path (rather than
            # trying to reference the prior $PATH, which container ENV
            # directives don't reliably expand) so nvcc is discoverable
            # without dropping anything apt/pip already installed there.
            "PATH": "/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "LD_LIBRARY_PATH": "/usr/local/cuda/lib64",
            # Compiles fat binaries covering both GPU tiers this image
            # serves: 8.9 = Ada Lovelace (Standard/L40S), 10.0 = Blackwell
            # (ULTRA/B300, the "sm_100" the admin wants fast attention on).
            # Set explicitly because the image build runs on a CPU-only
            # worker with no GPU attached to auto-detect from — without
            # this, SageAttention's setup.py has nothing to target and
            # either fails or silently builds for the wrong architecture.
            "TORCH_CUDA_ARCH_LIST": "8.9;10.0",
            # Caps parallel nvcc jobs so the source build doesn't spawn one
            # compiler process per core and OOM the image-build worker.
            "MAX_JOBS": "4",
        }
    )
    # Built from source rather than the PyPI wheel — see the apt_install
    # comment above for why. --no-build-isolation is required: SageAttention's
    # setup.py does `import torch` to read TORCH_CUDA_ARCH_LIST/query the ABI,
    # which fails in the isolated build venv pip creates by default (no
    # torch installed there) unless this is passed.
    .pip_install(
        "packaging",
        "wheel",
    )
    .run_commands(
        "pip install --no-build-isolation 'git+https://github.com/thu-ml/SageAttention.git'",
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
        # Pinned to the latest tagged release rather than tracking master —
        # v0.31.0+ added native Wan Animate 2 node support (WanAnimate2Cache /
        # WanAnimate2ToVideo), sidestepping the "missing custom node" errors
        # seen on stale pre-built RunPod images. master HEAD hit a transient
        # upstream bug (SaveVideo.execute() missing required arg 'format'),
        # so a tagged release is used for a tested, stable SaveVideo node.
        f"cd {COMFY_DIR} && git fetch --tags && git checkout v0.33.3",
        f"cd {COMFY_DIR} && pip install -r requirements.txt",
    )
    .run_commands(
        f"git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git"
        f" {COMFY_DIR}/custom_nodes/ComfyUI-VideoHelperSuite",
        # URL unverified — best-effort clone; failure here does not break the
        # image build, but the node pack simply won't be present if wrong.
        f"git clone https://github.com/IAMCCS/IAMCCS-nodes.git"
        f" {COMFY_DIR}/custom_nodes/IAMCCS-nodes || echo 'IAMCCS-nodes clone failed, continuing without it'",
    )
)

# Same five Wan 2.1 / Wan Animate 2 weights the RunPod Dockerfile downloads,
# reused here so the workflow JSON's loader nodes resolve identically.
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

# Folders under MODELS_DIR that get symlinked into ComfyUI's models/ dir —
# shared between the WanAnimate setup() loop and the storage admin's folder
# picker validation.
MODEL_SUBFOLDERS = ("diffusion_models", "text_encoders", "vae", "clip_vision", "loras")


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
    Normalizes a MODELS_DIR-relative directory path for the repo downloader
    (e.g. "LLM/Qwen3.8-27B-Abliterated/"). Unlike the single-file downloader,
    this isn't restricted to MODEL_SUBFOLDERS — a whole repo (an LLM, say)
    doesn't belong in one of ComfyUI's symlinked model-type folders. Returns
    None for anything that would escape MODELS_DIR (absolute paths, '..',
    empty segments) instead of the normalized relative path.
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
    Deletes outputs/all/* older than OUTPUTS_ALL_RETENTION_DAYS — the
    temporary per-generation archive every generate_video / run_custom_workflow
    call writes to (see _WanAnimateBase._save_output_temp), which backs the
    Admin logs preview feature. Runs once a day; does NOT touch
    outputs/admin/ (the separate, permanent admin-triggered save).
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
    admin Storage tab's "📥 ダウンロードタスク一覧" panel) — never raises,
    since a Supabase hiccup should never abort an in-flight model download.
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


@app.function(
    image=image,
    volumes={MODELS_DIR: vol},
    timeout=3600,
    secrets=[modal.Secret.from_name("supabase-model-downloads")],
)
def download_model_async(download_id: str, url: str, subfolder: str, filename: str):
    """
    Background half of ModalStorage._download_async — streams `url` into
    MODELS_DIR/subfolder/filename exactly like the old synchronous
    ModalStorage._download, but runs via .spawn() (see
    ModalStorage._download_async) so the admin's POST returns immediately,
    and reports progress_percent into `download_id`'s model_downloads row as
    it goes instead of the caller blocking on the whole transfer.
    """
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
                        # Capped at 99 here — the 100 written below only
                        # once the file has actually been renamed into place,
                        # so a poller never sees "100%" before the file
                        # exists. Throttled to once per whole percentage
                        # point rather than once per 8MB chunk.
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
    """
    Background half of ModalStorage._download_repo_async — snapshot_downloads
    an entire Hugging Face repo (e.g. a sharded LLM) into
    MODELS_DIR/save_dir via .spawn(), reporting progress into `download_id`'s
    model_downloads row the same way download_model_async does for single
    files. Unlike download_model_async, there's no single response with a
    content-length to track progress against — instead, a background thread
    polls save_dir's total size on disk against an upfront size estimate
    (via HfApi.model_info) while snapshot_download runs.
    """
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
                # Skip repo bookkeeping files — the actual model weights
                # (including sharded ones) are what the admin asked for.
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


class _WanAnimateBase:
    """
    Shared implementation for both GPU tiers. Not itself decorated with
    @app.cls — WanAnimate / WanAnimateUltra below apply that (each with its
    own gpu=...), inheriting these methods and their @modal.* decorations.
    """

    GPU_TIER = "standard"

    @modal.enter()
    def setup(self):
        import shutil

        # Point ComfyUI's model folders at the persistent volume instead of
        # the (ephemeral, per-container) image filesystem.
        for sub in MODEL_SUBFOLDERS:
            src = os.path.join(MODELS_DIR, sub)
            dst = os.path.join(COMFY_DIR, "models", sub)
            os.makedirs(src, exist_ok=True)
            if os.path.islink(dst):
                os.remove(dst)
            elif os.path.exists(dst):
                shutil.rmtree(dst)
            os.symlink(src, dst)

        # Custom nodes installed via the admin Storage tab (ModalStorage.
        # install_node) land in the volume rather than the image, so they
        # survive across deploys. Link each one in individually rather than
        # replacing custom_nodes/ wholesale, so the packs baked into the
        # image at build time (ComfyUI-VideoHelperSuite, IAMCCS-nodes) are
        # left alone. A node installed this way takes effect starting with
        # the next generation request (this container is freshly booted per
        # request anyway — there's no already-running process to hot-reload).
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
        # flags below (--disable-smart-memory, most of --gpu-only, and
        # nearly all of extra_args) are parsed once by ComfyUI at process
        # startup and never re-read, so the only way to actually apply them
        # per-workflow is to launch main.py with the right flags in the
        # first place. See _ensure_comfy_running, called from generate_video
        # / run_custom_workflow instead.
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
        exec_config (disable_smart_memory / cpu_vae / gpu_only /
        use_pytorch_cross_attention / high_vram / extra_args) differs from
        what it's currently running with — these are all process-startup-only ComfyUI
        CLI flags (verified against comfy/model_management.py in the pinned
        ComfyUI version: e.g. DISABLE_SMART_MEMORY is copied from
        args.disable_smart_memory into a module-level constant exactly once
        at import time), so there is no way to apply them to an
        already-running process.

        use_pytorch_cross_attention maps to `--use-pytorch-cross-attention`
        rather than `--use-flash-attention`: the standalone `flash-attn`
        PyPI package ships no prebuilt wheels at all (source dist only), and
        the official prebuilt wheels on GitHub don't cover this image's
        Python 3.11 / torch cu130 combination — installing it would mean an
        hours-long from-source CUDA build (or a wheel with a mismatched ABI
        that fails at import). PyTorch's own scaled_dot_product_attention
        (which this flag switches ComfyUI to) already includes a flash-
        attention backend and needs no extra package, so it gets the same
        practical speedup without that risk.
        """
        import shlex
        import subprocess

        cfg = exec_config or {}
        normalized = (
            bool(cfg.get("disable_smart_memory", False)),
            bool(cfg.get("cpu_vae", False)),
            bool(cfg.get("gpu_only", False)),
            bool(cfg.get("use_pytorch_cross_attention", False)),
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

        disable_smart_memory, cpu_vae, gpu_only, use_pytorch_cross_attention, high_vram, extra_args = normalized
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
        if gpu_only:
            argv.append("--gpu-only")
        if use_pytorch_cross_attention:
            argv.append("--use-pytorch-cross-attention")
        if high_vram:
            argv.append("--highvram")
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
        /history response is read first — falls back to the generic scan
        below (across all nodes) if it's unset, absent from the response, or
        doesn't resolve to an actual file, so an admin-mistyped id never
        breaks generation outright.
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
            # ComfyUI's /prompt validation failure body is JSON with a
            # node_errors map naming exactly which node/input failed and
            # why — surface it in full rather than letting raise_for_status()
            # swallow it into a generic "400 Client Error" with no detail.
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

                # Admin-pinned output node takes priority over the generic
                # scan below — matters when a workflow has more than one
                # SaveImage/SaveVideo-like node and the "last one found"
                # wouldn't otherwise be the intended final result.
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

                # Outputs JSON didn't point us at a file (key-name mismatch
                # across ComfyUI versions, etc.) — fall back to whatever new
                # file(s) showed up under output/ during this run.
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
            "gpu_tier": self.GPU_TIER,
            "status": status,
            "duration_s": round(duration_s, 1),
            "filename": filename,
            "error": error,
        }
        with open(os.path.join(log_dir, COMFYUI_LOG_FILENAME), "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        vol.commit()

    def _save_output_to_volume(self, filename, data):
        """Persists a generated output into the Volume's outputs/admin/ dir
        (requested only for admin-triggered generations — see save_to_volume
        below), timestamp-prefixed so repeated filenames (e.g. every Wan
        Animate run is named the same) never collide."""
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
        """Persists EVERY generation's output (all users, not just admins)
        into outputs/all/ so it can be previewed from the Admin logs UI —
        purely for QA/troubleshooting, independent of save_to_volume's
        permanent admin-only outputs/admin/ copy. Cleaned up after 7 days by
        the cleanup_old_outputs scheduled function below. UUID-prefixed
        (not timestamp) since concurrent requests can share a filename."""
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
        self._ensure_comfy_running(None)  # Wan Animate 2 standard flow always uses default flags.
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
            "gpu_tier": self.GPU_TIER,
            "output_path": output_path,
        }

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
    ) -> dict:
        """
        Generic counterpart to generate_video for admin-authored Custom
        Workflows (studio_custom_workflows): any ComfyUI API-format graph,
        any number of input files. Node/field values are already baked into
        workflow_json by the caller (see src/lib/customWorkflowExecution.ts)
        — this method just ensures ComfyUI is running with the workflow's
        exec_config, writes the referenced files, and runs the graph.
        """
        self._ensure_comfy_running(exec_config)
        workflow = json.loads(workflow_json)
        files = [(name, base64.b64decode(b64)) for name, b64 in files_b64.items()]
        started = time.time()
        try:
            result_bytes, filename = self._run_workflow(workflow, files, output_node_id=output_node_id or None)
        except Exception as exc:
            self._append_log("failed", time.time() - started, error=str(exc)[:500])
            raise
        self._append_log("success", time.time() - started, filename=filename)
        if save_to_volume:
            self._save_output_to_volume(filename, result_bytes)
        output_path = self._save_output_temp(filename, result_bytes)
        return {
            "filename": filename,
            "result_base64": base64.b64encode(result_bytes).decode("ascii"),
            "gpu_tier": self.GPU_TIER,
            "output_path": output_path,
        }

    @modal.fastapi_endpoint(method="POST")
    def custom_workflow(self, item: dict, request: fastapi.Request):
        _authorize(request)
        return self.run_custom_workflow.local(
            item["workflow_json"],
            item["files_b64"],
            item.get("exec_config"),
            item.get("save_to_volume", False),
            item.get("output_node_id"),
        )


# `scaledown_window` is this SDK's current name for what used to be
# `container_idle_timeout` (modal 1.5.4 no longer accepts that kwarg, and
# rejects values below 2 at deploy time — "must be between 2 and 3600"). 2 is
# the closest equivalent to immediate teardown: effectively no idle billing.
@app.cls(
    image=image,
    gpu=STANDARD_GPU_TYPE,  # 48GB VRAM
    timeout=600,  # 10 min
    scaledown_window=30,  # 30s Keep-Warm 規格（CLAUDE.md §1）
    volumes={MODELS_DIR: vol},
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
class WanAnimate(_WanAnimateBase):
    GPU_TIER = "standard"


@app.cls(
    image=image,
    gpu=ULTRA_GPU_TYPE,  # 288GB VRAM — see module docstring re: availability risk
    timeout=600,
    scaledown_window=30,  # 30s Keep-Warm 規格（CLAUDE.md §1）
    volumes={MODELS_DIR: vol},
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
class WanAnimateUltra(_WanAnimateBase):
    GPU_TIER = "ultra"


@app.cls(
    image=image,
    timeout=300,
    scaledown_window=2,
    volumes={MODELS_DIR: vol},
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
class ModalStorage:
    """
    GPU-less volume/custom-node management for the admin Storage tab. A
    single POST endpoint dispatches on `action` rather than exposing one
    fastapi_endpoint per operation, so the Next.js side only needs one URL.
    """

    def _list(self) -> dict:
        # Fresh snapshot first — otherwise a warm container can keep reporting
        # a file (and its bytes) that another container already deleted +
        # committed, so the admin capacity total never drops.
        _reload_volume("admin-list")
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
        """
        Validates the request, then spawns download_model_async as a
        detached Modal function call and returns immediately — the actual
        transfer (and its model_downloads progress updates) happens in that
        background invocation, not on this request/response cycle. See
        POST /api/admin/modal/storage in route.ts, which inserts the
        'pending' model_downloads row before calling this action.
        """
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
        """
        Validates the request, then spawns download_repo_async as a detached
        Modal function call and returns immediately — mirrors _download_async
        above, but for a whole Hugging Face repo (snapshot_download) rather
        than a single file. save_dir is any path under MODELS_DIR, not
        limited to MODEL_SUBFOLDERS: a full repo (an LLM, say) doesn't belong
        in one of ComfyUI's symlinked model-type folders.
        """
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
        """Reads a file back out of the volume as base64 — used by the admin
        Storage tab's download button (e.g. for outputs/admin/* generations
        saved via save_to_volume)."""
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
        # Pull the freshest committed Volume state first so os.remove() acts on
        # what's really there and vol.commit()'s reconciliation is diffed
        # against current truth (a stale baseline can re-upload files another
        # container deleted).
        _reload_volume("admin-delete")
        if not os.path.isfile(full):
            raise fastapi.HTTPException(status_code=404, detail="File not found.")
        os.remove(full)
        # MUST commit right here — a Modal Volume rolls the unlink back when the
        # container exits unless it was explicitly persisted.
        vol.commit()
        print(f"[admin] Deleted and committed: {rel_path}", flush=True)
        return {"ok": True}

    def _delete_dir(self, item: dict) -> dict:
        """Recursively deletes an entire directory (e.g. an admin removing a
        whole custom node, or a model subfolder) — used by the "📁 フォルダ
        ごと一括削除" button in ModalStorageTab's folder tree."""
        import shutil

        rel_path = item["file_path"]
        base = os.path.normpath(MODELS_DIR)
        full = os.path.normpath(os.path.join(base, rel_path))
        if not full.startswith(base + os.sep) or full == base:
            # Deliberately excludes full == base too — never let this wipe
            # the whole volume root, only a subdirectory within it.
            raise fastapi.HTTPException(status_code=400, detail="Invalid file_path.")
        _reload_volume("admin-delete-dir")
        if not os.path.isdir(full):
            raise fastapi.HTTPException(status_code=404, detail="Directory not found.")
        shutil.rmtree(full)
        # MUST commit right here — see _delete().
        vol.commit()
        print(f"[admin] Deleted and committed: {rel_path}", flush=True)
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
    # This file is shared with scripts/test-wan-animate.ts (RunPod), whose
    # older ComfyUI expects SaveVideo.format as a MIME string. ComfyUI
    # v0.33.3's SaveVideo instead takes an enum (['auto', 'mp4']) — patched
    # here rather than in the shared file so RunPod compatibility is unaffected.
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
    service = WanAnimate()
    result = service.generate_video.remote(
        workflow_json,
        reference_image_b64,
        os.path.basename(reference_image_path),
        pose_video_b64,
        os.path.basename(pose_video_path),
    )
    elapsed = time.time() - started

    out_path = pathlib.Path("output_wan_animate_modal.mp4")
    out_path.write_bytes(base64.b64decode(result["video_base64"]))
    print(f"[main] saved output -> {out_path.resolve()} ({out_path.stat().st_size} bytes)")
    print(f"[main] total wall time: {elapsed:.1f}s")
