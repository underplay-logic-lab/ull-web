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
import math
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

# 入力参照画像の正規化（ull_image_prep）。形式デコード / EXIF 回転 / ICC→sRGB /
# 透過→白合成 / 16bit→8bit の是正と過大サイズの頭打ちを担う。最終解像度は
# ワークフロー側のノード（ImageScaleToTotalPixels 等）が確定させる。
INPUT_IMG_MAX_EDGE = int(os.environ.get("ULL_INPUT_IMG_MAX_EDGE", "2048"))
INPUT_IMG_MIN_EDGE = int(os.environ.get("ULL_INPUT_IMG_MIN_EDGE", "512"))
INPUT_IMG_MULTIPLE = int(os.environ.get("ULL_INPUT_IMG_MULTIPLE", "16"))

# GPU passed to Modal as a plain string, not modal.gpu.B300() — the modal.gpu
# module was removed from the SDK well before this version (modal==1.5.4
# here; confirmed via `python -c "import modal.gpu"` -> ModuleNotFoundError).
# Modal's current @app.cls(gpu=...) just takes a string and doesn't validate
# it client-side (see parse_gpu_config in modal/_utils/function_utils.py) —
# if "B300" isn't actually available on the target Modal workspace,
# deployment still succeeds but generation requests fail at request time.
#
# 2026-09-17: DIRECTOR_WORKER_GPU env override を追加（CLAUDE.md §1「全機能
# 対象のB300代替洗い出し」）。VRAM実測127.7-158.5GBのためH200(141GB)は上限
# 側で足りない可能性が高く、実質B200/B300の2択のみ候補——他ワーカー
# （SEEDVR2_WORKER_GPU等）と同じパターンでB200との比較実測に使う。
GPU_TYPE = os.environ.get("DIRECTOR_WORKER_GPU", "").strip() or "B300"

# Same admin-only allow-lists as scripts/modal_wan_animate.py — model-
# management endpoints only accept URLs/git remotes from known-good hosts.
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
        # SageAttention の setup.py は CXX_FLAGS/NVCC_FLAGS に "-std=c++17" を
        # ハードコードしている（thu-ml/SageAttention commit d1a57a5 時点）が、
        # cu130 index が解決する現行 torch（2.14.0 系）のヘッダーは C++20 を
        # 要求し "#error C++20 or later compatible compiler is required" で
        # ビルドが落ちる（modal_seedvr2_worker.py で 2026-09-12 実機確認・
        # 同一の thu-ml/SageAttention ビルドなのでここも同様に踏む）。setup.py
        # 側が用意する CXX_APPEND_FLAGS / NVCC_APPEND_FLAGS で末尾に
        # -std=c++20 を追記し、複数回指定時は最後が勝つ gcc/nvcc の挙動で
        # 上書きする。
        env={"CXX_APPEND_FLAGS": "-std=c++20", "NVCC_APPEND_FLAGS": "-std=c++20"},
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
        # 2026-09-13: v0.33.3 -> v0.35.1 (CLAUDE.md §1 のComfyUIバージョン運用
        # 方針に基づく事前検証済みアップグレード)。v0.35.0 で core
        # comfy_extras/nodes_sparse_attention.py（BlockSparseAttention、
        # MiniMax H3向けsol-attn/sla/vsa 3バックエンド）が追加されたため、
        # VDN-H3([[cinematic-video-tab]]系の高速化調査参照)の上に重ねられる
        # か検証するために採用。v0.33.3を選んだ理由だった「masterのSaveVideo
        # 一時バグ」は、コアのSaveVideoノードを使わずComfyUI-VideoHelperSuite
        # のVHS_VideoCombineに差し替えることで回避（下記ワークフロー参照）。
        f"cd {COMFY_DIR} && git fetch --tags && git checkout v0.35.1",
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
        # 2026-09-15 実障害の修正: VHS_VideoCombine.combine_video()（nodes.py）
        # は audio['waveform'] を .cpu() を挟まず直接 .numpy().tobytes() して
        # おり、ComfyUI コア側の VAEDecodeAudio（comfy_extras/nodes_audio.py の
        # vae_decode_audio）が waveform を GPU 上のテンソルのまま返す
        # （.cpu() を呼んでいない）ため、この2つを繋ぐと必ず
        # "can't convert cuda:0 device type tensor to numpy" でクラッシュする
        # （GitHub 上の両方のソースを直接確認して特定 — CLAUDE.md §0の「読める
        # ソースは実機再検証より先に読む」方針どおり）。ComfyUI コア純正の
        # SaveAudio ノード（comfy_api/latest の AudioSaveHelper.save_audio）は
        # 同じ状況で `audio["waveform"].cpu()` を明示的に呼んでおり、これが
        # 本来あるべき挙動。VideoHelperSuite はバージョン固定していない
        # （CLAUDE.md §1のバージョン固定方針の例外 — 元々SaveVideoの一時バグ
        # 回避のためだけに採用した経緯があり、特定タグへの意図的な追従理由が
        # 無かった）ため、直接パッチして `.numpy().tobytes()` の直前に
        # `.cpu()` を挿入する。既にCPU上のテンソルに対して `.cpu()` を呼んでも
        # 何もしない（no-op）ので、他の `.numpy().tobytes()` 呼び出し（映像
        # フレーム側等）に副作用は無い。VideoHelperSuite が将来この関数を
        # 書き換えて対象文字列が消えた場合は assert で気づけるようにする。
        "python3 -c \""
        "import pathlib; "
        f"p = pathlib.Path('{COMFY_DIR}/custom_nodes/ComfyUI-VideoHelperSuite/videohelpersuite/nodes.py'); "
        "s = p.read_text(); "
        "s2 = s.replace('.numpy().tobytes()', '.cpu().numpy().tobytes()'); "
        "assert s2 != s, 'VHS nodes.py: .numpy().tobytes() not found — patch target moved, check upstream'; "
        "p.write_text(s2)\"",
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
    # 全ワーカー共通の入力画像正規化レイヤー（_write_inputs が参照画像に必ず適用）。
    # HEIC/AVIF プラグインつき。チェーン末尾に置き既存の重いビルド層を触らない。
    .pip_install("pillow-heif", "pillow-avif-plugin")
    .add_local_python_source("ull_image_prep")
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


# ---------------------------------------------------------------------------
# PyTorch 最適化標準（CLAUDE.md §1）: torch.compile を ComfyUI ワークフローへ
# 安全に組み込む。対象は呼び出し側が渡す任意の API-format グラフなので、少しでも
# 曖昧なら一切触らず原型を返す（fail-open）。WAN_TORCH_COMPILE=0 で完全無効化。
# ---------------------------------------------------------------------------
# ComfyUI 標準 "MODEL" 型を出力する diffusion ローダーのみ対象。KJNodes の
# WanVideoModelLoader（独自 WANVIDEOMODEL 型）は core TorchCompileModel と型が
# 合わず /prompt 検証で弾かれるため、あえて対象外。
_WAN_MODEL_LOADER_CLASSES = frozenset(
    {"UNETLoader", "UnetLoaderGGUF", "CheckpointLoaderSimple", "CheckpointLoader"}
)
_WAN_COMPILE_CLASSES = frozenset(
    {
        "TorchCompileModel",
        "TorchCompileModelAdvanced",
        "TorchCompileModelWanVideo",
        "TorchCompileModelWanVideoV2",
    }
)


def _comfy_node_available(class_type: str) -> bool:
    """その class_type が起動中の ComfyUI に登録されているか。未登録ノードを
    workflow に足すと /prompt 検証でグラフ全体が落ちるので、挿入前に必ず確認する。"""
    try:
        import requests

        r = requests.get(f"http://127.0.0.1:8188/object_info/{class_type}", timeout=5)
        return bool(r.ok and isinstance(r.json(), dict) and class_type in r.json())
    except Exception:
        return False


def _inject_torch_compile(workflow):
    """API-format ワークフローに core TorchCompileModel を 1 つ挿入し、DiT/UNet の
    サンプリングを Inductor でコンパイルする。次のいずれかに当たれば無改変で返す:
    WAN_TORCH_COMPILE=0 / workflow が dict でない / 既に compile 系ノードがある /
    MODEL を出すローダーが一意でない / そのローダーを model 入力に使うノードが無い /
    実行中 ComfyUI に TorchCompileModel が無い / 例外。"""
    if os.environ.get("WAN_TORCH_COMPILE", "1").strip().lower() in ("0", "false", "no"):
        return workflow
    try:
        if not isinstance(workflow, dict):
            return workflow
        nodes = {k: v for k, v in workflow.items() if isinstance(v, dict)}
        if any(v.get("class_type") in _WAN_COMPILE_CLASSES for v in nodes.values()):
            return workflow
        loaders = [
            k for k, v in nodes.items() if v.get("class_type") in _WAN_MODEL_LOADER_CLASSES
        ]
        if len(loaders) != 1:
            return workflow
        loader_id = loaders[0]
        consumers = []
        for k, v in nodes.items():
            m = v.get("inputs", {}).get("model")
            if isinstance(m, list) and len(m) == 2 and str(m[0]) == str(loader_id):
                consumers.append((k, m[1]))
        if not consumers:
            return workflow
        if not _comfy_node_available("TorchCompileModel"):
            print("[wan] torch.compile: TorchCompileModel node unavailable, skipping", flush=True)
            return workflow
        new_id = "torch_compile_std"
        while new_id in workflow:
            new_id += "_x"
        workflow[new_id] = {
            "class_type": "TorchCompileModel",
            "inputs": {"model": [str(loader_id), consumers[0][1]], "backend": "inductor"},
            "_meta": {"title": "torch.compile (CLAUDE.md §1)"},
        }
        for k, _idx in consumers:
            workflow[k]["inputs"]["model"] = [new_id, 0]
        print(
            f"[wan] torch.compile injected: loader {loader_id} -> {new_id} "
            f"-> {[c[0] for c in consumers]}",
            flush=True,
        )
        return workflow
    except Exception as exc:  # noqa: BLE001 — fail-open, never block a generation
        print(f"[wan] torch.compile injection skipped: {exc}", flush=True)
        return workflow


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


# ---------------------------------------------------------------------------
# CPU probe: 入力正規化レイヤー（ull_image_prep）の import 連鎖 + 実処理の検証。
# CLAUDE.md §1「CPU で import と資産準備がグリーン → はじめて GPU 実行」。
#   PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_wan_animate_blackwell.py::probe_image_prep
# ---------------------------------------------------------------------------
@app.function(image=image, cpu=2, memory=4096, timeout=300)
def probe_image_prep() -> dict:
    import io as _io

    from PIL import Image

    from ull_image_prep import looks_like_image, normalize_to_png_bytes

    report: dict = {"cases": {}, "plugins": {}, "looks_like_image": {}}

    for mod in ("pillow_heif", "pillow_avif"):
        try:
            __import__(mod)
            report["plugins"][mod] = "ok"
        except Exception as exc:  # noqa: BLE001
            report["plugins"][mod] = f"MISSING: {exc!r}"

    for fn, want in (("a.heic", True), ("b.JPG", True), ("c.webp", True), ("d.mp4", False), ("e.wav", False)):
        report["looks_like_image"][fn] = looks_like_image(fn) == want

    def _png(img):
        b = _io.BytesIO()
        img.save(b, format="PNG")
        return b.getvalue()

    def _run(name, raw):
        try:
            out = normalize_to_png_bytes(
                raw, max_edge=INPUT_IMG_MAX_EDGE, min_edge=INPUT_IMG_MIN_EDGE, multiple=INPUT_IMG_MULTIPLE
            )
            im = Image.open(_io.BytesIO(out))
            report["cases"][name] = {"size": list(im.size), "mode": im.mode}
        except Exception as exc:  # noqa: BLE001
            report["cases"][name] = f"FAIL: {exc!r}"

    _run("rgb", _png(Image.new("RGB", (1920, 1080), (10, 20, 30))))
    _run("rgba_transparent", _png(Image.new("RGBA", (900, 900), (255, 0, 0, 0))))
    _run("grayscale", _png(Image.new("L", (700, 500), 120)))
    cmyk = _io.BytesIO()
    Image.new("CMYK", (800, 600)).save(cmyk, format="JPEG")
    _run("cmyk_jpeg", cmyk.getvalue())
    _run("tiny_upscale", _png(Image.new("RGB", (100, 80), (0, 0, 0))))
    _run("huge_downscale", _png(Image.new("RGB", (6000, 4000), (0, 0, 0))))
    try:
        import pillow_heif  # type: ignore

        heif = pillow_heif.from_pillow(Image.new("RGB", (1200, 800), (40, 50, 60)))
        hb = _io.BytesIO()
        heif.save(hb, format="HEIF")
        _run("heic", hb.getvalue())
    except Exception as exc:  # noqa: BLE001
        report["cases"]["heic"] = f"SKIP: {exc!r}"

    report["ok"] = all(
        (not isinstance(v, str)) or (not v.startswith("FAIL")) for v in report["cases"].values()
    ) and all(report["looks_like_image"].values())
    print("[probe_image_prep]", report, flush=True)
    return report


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


def _supabase_request_checked(method: str, path: str, attempts: int = 3, backoff_s: float = 0.6, **kwargs):
    """_supabase_request + 成功判定 + リトライ。

    2026-09-13: modal_angle_worker.py の実障害（_supabase_request が非2xx
    でも例外を投げないため、書き込み失敗が握りつぶされてジョブが進捗の
    まま止まる／返金されない）と同じバグが本ファイルにも存在していたため
    横展開。status_code を必ずチェックし、一時的な失敗はリトライする。
    """
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            res = _supabase_request(method, path, **kwargs)
            if res is not None and res.ok:
                return res
            detail = f"HTTP {res.status_code}: {res.text[:300]}" if res is not None else "no response (env not configured)"
            last_exc = RuntimeError(detail)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
        if attempt < attempts:
            time.sleep(backoff_s * attempt)
    raise last_exc if last_exc is not None else RuntimeError("unknown Supabase request failure")


def _supabase_patch_job(job_id: str, fields: dict) -> None:
    """Best-effort PATCH of one generation_jobs row — status/video_url/
    error_message, called from run_custom_workflow as the spawned job
    progresses and finishes."""
    if not job_id:
        return
    try:
        _supabase_request_checked(
            "PATCH",
            "/rest/v1/generation_jobs",
            params={"id": f"eq.{job_id}"},
            json={**fields, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            headers={"Prefer": "return=minimal"},
        )
    except Exception as exc:  # noqa: BLE001 — best-effort, never propagate
        print(f"[generation_jobs] failed to update job {job_id} (after retries): {exc}")


_DIRECTOR_RESULTS_BUCKET = "director-results"


def _upload_director_video(user_id: str, job_id: str, video_bytes: bytes) -> str | None:
    """mp4 を director-results バケット（public）へ upsert し、公開 URL を返す。
    アップロード失敗時は None（呼び出し側で base64 data URI にフォールバック）。
    Multi-Angle の _upload_angle_image / 超解像の _upload_upscale_video と同じ
    パターンへ統一（CLAUDE.md §6「生成物は同期/非同期を問わず必ず永続ストレージ
    へ保存する」— Cinematic Director だけ video_url に base64 を直接埋め込む
    旧方式のままだったのを是正。2026-09-17）。"""
    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        return None
    obj_path = f"{user_id or 'anon'}/{job_id}.mp4"
    try:
        _supabase_request_checked(
            "POST",
            f"/storage/v1/object/{_DIRECTOR_RESULTS_BUCKET}/{obj_path}",
            headers={"Content-Type": "video/mp4", "x-upsert": "true"},
            data=video_bytes,
        )
        return f"{supabase_url}/storage/v1/object/public/{_DIRECTOR_RESULTS_BUCKET}/{obj_path}"
    except Exception as exc:  # noqa: BLE001 — 失敗時は呼び出し側が data URI にフォールバック
        print(f"[director-job] video upload failed ({obj_path}): {exc}", flush=True)
        return None


def _current_effective_vram_gb():
    """Device-global effective VRAM in use, in GB — just the one number, no
    total / denominator and no GPU model name (the client renders it as a
    spoiler-free 'Active VRAM' badge — CLAUDE.md §2). None when CUDA isn't
    available. Canonical copy lives in modal_lora_worker.py
    (_current_effective_vram_gb); keep them behaviourally identical."""
    try:
        import torch

        if torch.cuda.is_available():
            free_b, total_b = torch.cuda.mem_get_info()
            return round((total_b - free_b) / (1024**3), 1)
    except Exception:  # noqa: BLE001 — telemetry only, never fatal
        pass
    return None


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
        _supabase_request_checked(
            "PATCH",
            "/rest/v1/profiles",
            params={"id": f"eq.{user_id}"},
            json={"credits": current + amount},
            headers={"Prefer": "return=minimal"},
        )
    except Exception as exc:  # noqa: BLE001 — best-effort, never propagate
        print(f"[generation_jobs] failed to refund {amount} credits to {user_id} (after retries): {exc}")


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
# `container_idle_timeout` (modal 1.5.4 rejects values below 2).
# 30s Keep-Warm 規格（CLAUDE.md §1）— 全 GPU クラス/関数一律 30。
@app.cls(
    image=image,
    gpu=GPU_TYPE,
    # 2026-09-14: 1800s(30分) -> 7200s(2時間)。VDN-H3 Qualityモード(50step
    # 非蒸留)を60秒(4シーン)相当で使うと、15秒での実測681.3sから単純外挿でも
    # 2700s超、Attentionの非線形性を考えると更に伸びうる。GPUタイムアウトは
    # 「多めに設定する」方針（CLAUDE.md §0） — 上限を伸ばすこと自体はコスト
    # ゼロ（実際にその時間動いた分だけ課金される）なので、ここは安全側に倒す。
    timeout=7200,
    scaledown_window=30,
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
        """files: list of (filename, bytes) to place under ComfyUI's input/ dir.

        画像ファイルは書き出し前に必ず共通の入力正規化レイヤー
        （ull_image_prep）を通す。デコード不能／壊れた画像は fail-open で生
        バイトのまま書き、ComfyUI 側のエラーに委ねる。動画・音声など非画像は
        そのまま書く。
        """
        from ull_image_prep import ImagePrepError, looks_like_image, normalize_to_png_bytes

        input_dir = os.path.join(COMFY_DIR, "input")
        os.makedirs(input_dir, exist_ok=True)
        for filename, data in files:
            payload = data
            if looks_like_image(filename):
                try:
                    payload = normalize_to_png_bytes(
                        data,
                        max_edge=INPUT_IMG_MAX_EDGE,
                        min_edge=INPUT_IMG_MIN_EDGE,
                        multiple=INPUT_IMG_MULTIPLE,
                        bg=(255, 255, 255),
                    )
                    print(
                        f"[inputs] normalized {filename}: {len(data)} -> {len(payload)} bytes",
                        flush=True,
                    )
                except ImagePrepError as exc:
                    print(f"[inputs] normalize skipped for {filename}: {exc!r}", flush=True)
                except Exception as exc:  # noqa: BLE001
                    print(f"[inputs] normalize error for {filename} (writing raw): {exc!r}", flush=True)
            with open(os.path.join(input_dir, filename), "wb") as f:
                f.write(payload)

    def _run_workflow(self, workflow, files, output_node_id=None, skip_torch_compile=False, poll_deadline_s=550):
        """
        files: list of (filename, bytes) referenced by the workflow's loader
        nodes. output_node_id: if given, that node's output in ComfyUI's
        /history response is read first — falls back to a generic scan
        (across all nodes) if it's unset, absent, or doesn't resolve to an
        actual file, so an admin-mistyped id never breaks generation.
        skip_torch_compile: caller opts this job out of the _inject_torch_compile
        pass — for graphs where CUDA graphs / model offload conflict with it
        (CLAUDE.md §1: 本番反映前に実生成での検証を必須).
        """
        import uuid

        import requests

        self._write_inputs(files)

        # PyTorch 最適化標準（CLAUDE.md §1）: fail-open。詳細は _inject_torch_compile。
        if not skip_torch_compile:
            workflow = _inject_torch_compile(workflow)

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

        deadline = time.time() + poll_deadline_s
        while time.time() < deadline:
            hist = requests.get(f"http://127.0.0.1:8188/history/{prompt_id}", timeout=30).json()
            if prompt_id in hist:
                entry = hist[prompt_id]
                status = entry.get("status", {})
                outputs = entry.get("outputs", {})

                # 2026-09-15 実障害: ここが status を一切見ず outputs 追跡失敗時に
                # 「output/ ディレクトリで一番新しいファイル」へフォールバックして
                # いたため、途中のノードが例外で落ちても「たまたま output/ に
                # 残っていた別ファイル（例: 音声結合前の映像のみのmp4）」を成功
                # として返してしまっていた（VHS_VideoCombineが音声テンソルの
                # cuda->cpu変換漏れでクラッシュ、映像は書き出し済みだったケース
                # — 下の VideoHelperSuite パッチ参照）。ComfyUI の history
                # エントリは ExecutionStatus（status_str: 'success'|'error'）を
                # 持つので、'error' ならここで即座に失敗として扱う（output/ の
                # スキャンは一切行わない — 中途半端な成果物を成功扱いしない）。
                if status.get("status_str") == "error":
                    raise RuntimeError(
                        f"ComfyUI prompt execution failed.\n"
                        f"status: {json.dumps(status, ensure_ascii=False)}\n"
                        f"outputs so far: {json.dumps(outputs, ensure_ascii=False)}"
                    )

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
    def probe_node_schema(self, class_types: list) -> dict:
        """デバッグ用: ComfyUI を起動するだけで実際にワークフローは実行せず、
        指定した class_type の /object_info を取得して返す（2026-09-13、
        MiniMaxH3ImageToVideo の width/height が宣言通り効いていない実障害の
        原因調査用 — 起動コストのみで済むので実行に比べ大幅に安い）。"""
        import requests

        self._ensure_comfy_running(BLACKWELL_EXEC_CONFIG)
        out: dict = {}
        for ct in class_types:
            try:
                r = requests.get(f"http://127.0.0.1:8188/object_info/{ct}", timeout=10)
                out[ct] = r.json().get(ct) if r.ok else f"HTTP {r.status_code}"
            except Exception as exc:  # noqa: BLE001
                out[ct] = f"ERROR: {exc}"
        return out

    @modal.method()
    def probe_object_info_search(self, substrings: list) -> dict:
        """デバッグ用: ComfyUI 起動のみ・実行なしで /object_info 全体を取得し、
        class_type 名に指定した部分文字列（大小無視）を含むものだけ返す
        （2026-09-14、image-to-3D 検証用 — TRELLIS.2 のネイティブノードの
        正確なクラス名が事前に分からないため、個別 class_type 指定の
        probe_node_schema ではなく全件検索する必要がある）。"""
        import requests

        self._ensure_comfy_running(BLACKWELL_EXEC_CONFIG)
        try:
            r = requests.get("http://127.0.0.1:8188/object_info", timeout=30)
            if not r.ok:
                return {"ok": False, "error": f"HTTP {r.status_code}"}
            all_nodes = r.json()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

        lowered = [s.lower() for s in substrings]
        matches = {
            name: schema
            for name, schema in all_nodes.items()
            if any(s in name.lower() for s in lowered)
        }
        return {"ok": True, "count": len(matches), "matches": matches}

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
        skip_torch_compile: bool = False,
        poll_deadline_s: int = 550,
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

        def _now_iso() -> str:
            return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        if is_async:
            # started_at feeds the "推定待機時間" average (completed_at -
            # started_at) the Studio queue monitor shows.
            _supabase_patch_job(job_id, {"status": "processing", "started_at": _now_iso()})

        # ライブ「Active VRAM」バッジ用の背景サンプラー（async パスのみ）。
        # _run_workflow は 1 本のブロッキング ComfyUI 実行なので per-step の
        # フックが無い → 別スレッドで ~8s 毎に実効 VRAM を generation_jobs.
        # metadata.vram_used_gb へ PATCH する（cinematic の行は metadata を
        # 他に使っていないので丸ごと上書きで可）。model_downloads の
        # _poll_progress と同じ daemon スレッド方式。
        _vram_stop = None
        _vram_thread = None
        if is_async:
            import threading

            _vram_stop = threading.Event()

            def _poll_vram():
                while not _vram_stop.wait(8):
                    gb = _current_effective_vram_gb()
                    if gb is not None:
                        _supabase_patch_job(job_id, {"metadata": {"vram_used_gb": gb}})

            _vram_thread = threading.Thread(target=_poll_vram, name="cinematic-vram", daemon=True)
            _vram_thread.start()

        try:
            self._ensure_comfy_running(exec_config)
            workflow = json.loads(workflow_json)
            files = [(name, base64.b64decode(b64)) for name, b64 in files_b64.items()]
            result_bytes, filename = self._run_workflow(
                workflow,
                files,
                output_node_id=output_node_id or None,
                skip_torch_compile=skip_torch_compile,
                poll_deadline_s=poll_deadline_s,
            )
        except Exception as exc:
            if _vram_stop is not None:
                _vram_stop.set()
            self._append_log("failed", time.time() - started, error=str(exc)[:500])
            if is_async:
                _supabase_patch_job(
                    job_id,
                    {"status": "failed", "error_message": str(exc)[:2000], "completed_at": _now_iso()},
                )
                _refund_credits(user_id, credits_cost)
                _clear_active_job(active_job_id)
            raise
        if _vram_stop is not None:
            _vram_stop.set()
        self._append_log("success", time.time() - started, filename=filename)
        if save_to_volume:
            self._save_output_to_volume(filename, result_bytes)
        output_path = self._save_output_temp(filename, result_bytes)
        result_base64 = base64.b64encode(result_bytes).decode("ascii")
        _vram_used_gb = _current_effective_vram_gb()
        result = {
            "filename": filename,
            "result_base64": result_base64,
            "gpu_tier": GPU_TIER,
            "output_path": output_path,
            "vram_used_gb": _vram_used_gb,
        }
        if is_async:
            # director-results バケットへアップロードし公開URLを永続化する
            # （CLAUDE.md §6）。旧実装は video_url に base64 を直接埋め込む
            # だけで Storage に一切残さなかった（"videos are never durably
            # stored server-side" という当時のコメントは、廃止済みの旧
            # CinematicVideoTab.tsx が持っていた「サーバーに保存されずブラウザ
            # を閉じると消滅する」という注意書きに合わせた名残で、現行の
            # DirectorStudioTab.tsx にはその注意書き自体がもう無い）。
            # Multi-Angle/超解像と同じ「アップロード失敗時のみ data URI に
            # フォールバック」方式へ統一（2026-09-17）。
            if _vram_thread is not None:
                _vram_thread.join(timeout=3)
            uploaded_url = _upload_director_video(user_id, job_id, result_bytes)
            _completed_fields = {
                "status": "completed",
                "video_url": uploaded_url or f"data:video/mp4;base64,{result_base64}",
                "completed_at": _now_iso(),
            }
            if _vram_used_gb is not None:
                _completed_fields["metadata"] = {"vram_used_gb": _vram_used_gb}
            _supabase_patch_job(job_id, _completed_fields)
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
        item.get("skip_torch_compile", False),
        item.get("poll_deadline_s", 550),
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
        # Fresh snapshot first — otherwise a warm container can keep reporting
        # a file (and its bytes) that another container already deleted +
        # committed, so the admin capacity total never drops.
        _reload_volume("admin-list")
        files = []
        # De-dupe by physical inode — the HF hub cache symlinks every blob from
        # snapshots/, and the comfy layout hardlinks some weights; os.stat()
        # follows both, so a naive walk counts the same bytes 2-3x and inflates
        # the admin capacity total. First path to an inode carries the real
        # size; later aliases report 0, keeping the summed list accurate.
        seen_inodes: set = set()
        for root, dirs, filenames in os.walk(MODELS_DIR):
            dirs.sort()  # blobs/ before snapshots/
            for name in filenames:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, MODELS_DIR).replace(os.sep, "/")
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                key = (st.st_dev, st.st_ino)
                dup = bool(st.st_ino) and key in seen_inodes
                if st.st_ino:
                    seen_inodes.add(key)
                files.append(
                    {
                        "path": rel,
                        "size_bytes": 0 if dup else st.st_size,
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
        import shutil

        rel_path = item["file_path"]
        base = os.path.normpath(MODELS_DIR)
        full = os.path.normpath(os.path.join(base, rel_path))
        if not full.startswith(base + os.sep) or full == base:
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


def _cinematic_safe_dimensions(raw_w: float, raw_h: float, target_megapixels: float) -> tuple:
    """Python port of cinematicPricing.ts's cinematicSafeDimensions/floorTo16.
    2026-09-13: root cause confirmed by reading comfy_extras/nodes_minimax_h3.py
    directly — _empty_av_latent does plain `// 16` (no +1 offset), so
    patchify just needs width/height to be multiples of 32 (round, matching
    that file's own adapt_canvas helper), not the "≡16 (mod 32)" this
    function originally (incorrectly) assumed."""
    def snap_to_32(n: float) -> int:
        return max(32, round(n / 32) * 32)

    aspect = max(1.0, raw_w) / max(1.0, raw_h)
    target_pixels = target_megapixels * 1_000_000
    h = math.sqrt(target_pixels / aspect)
    w = h * aspect
    return snap_to_32(w), snap_to_32(h)


def _cinematic_workflow(
    duration_s: float, reference_image_name: str, allow_compile: bool = True,
    megapixels: float = 0.262144, raw_w: float = 1.0, raw_h: float = 1.0,
    steps: int = 4, use_turbo_lora: bool = True, prompt: str = "",
    use_vdn: bool = False, vdn_checkpoint: str = "stage-b-step-2000",
    use_sparse_attn: bool = False, vdn_turbo: bool = False,
) -> dict:
    """Python port of src/lib/cinematicWorkflow.ts's WORKFLOW_TEMPLATE +
    buildCinematicWorkflow (speed mode: steps=4, useTurboLora=True,
    megapixels=0.262144 / 512 baseEdge) — used only for cinematic_smoke below
    to empirically test MiniMax H3's real duration ceiling on THIS pinned
    ComfyUI version, independent of the 2026-09-09 postmortem's claim (which
    may be stale — see [[cinematic-video-tab]]).

    2026-09-13: root cause found by reading comfy_extras/nodes_minimax_h3.py
    (v0.33.3) directly: _empty_av_latent does plain `height // 16` /
    `width // 16` (no +1 offset). patchify just needs that to be even, i.e.
    width/height must be multiples of 32 (the node's own widgets declare
    step=32). Earlier "≡16 (mod 32)" theory and the "explicitly resize
    first_frame" detour were both wrong turns chasing the same underlying
    bug (a bad rounding formula) — first_frame can stay wired to the raw
    "114" LoadImage output as-is, since the node internally stretch-resizes
    it ("disabled" crop) to match width/height itself.
    """
    width, height = _cinematic_safe_dimensions(raw_w, raw_h, megapixels)
    workflow = {
        # 2026-09-13: core "SaveVideo" -> ComfyUI-VideoHelperSuite の
        # VHS_VideoCombine に差し替え（v0.35.1 アップグレードに伴う対応、
        # CLAUDE.md §1 参照）。images/audio を直接受け取れるため 105:91
        # (CreateVideo) 経由は不要になった。
        "92": {
            "inputs": {"images": ["105:10", 0], "audio": ["105:23", 0], "frame_rate": 24,
                       "loop_count": 0, "filename_prefix": "cinematic_smoke",
                       "format": "video/h264-mp4", "pingpong": False, "save_output": True},
            "class_type": "VHS_VideoCombine", "_meta": {"title": "Video Combine"},
        },
        "114": {
            "inputs": {"image": reference_image_name},
            "class_type": "LoadImage", "_meta": {"title": "Load Image"},
        },
        "105:11": {"inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}, "class_type": "VAELoader",
                   "_meta": {"title": "Load VAE"}},
        "105:24": {"inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}, "class_type": "VAELoader",
                   "_meta": {"title": "Load VAE"}},
        "105:23": {"inputs": {"samples": ["105:14", 0], "vae": ["105:24", 0]}, "class_type": "VAEDecodeAudio",
                   "_meta": {"title": "VAE Decode Audio"}},
        "105:10": {"inputs": {"samples": ["105:14", 0], "vae": ["105:11", 0]}, "class_type": "VAEDecode",
                   "_meta": {"title": "VAE Decode"}},
        "105:17": {"inputs": {"sampler_name": "euler"}, "class_type": "KSamplerSelect",
                   "_meta": {"title": "KSamplerSelect"}},
        "105:9": {"inputs": {"scheduler": "beta", "steps": steps, "denoise": 1, "model": ["105:121", 0]},
                  "class_type": "BasicScheduler", "_meta": {"title": "BasicScheduler"}},
        "105:14": {"inputs": {"noise": ["105:15", 0], "guider": ["105:16", 0], "sampler": ["105:17", 0],
                               "sigmas": ["105:9", 0], "latent_image": ["105:104", 1]},
                   "class_type": "SamplerCustomAdvanced", "_meta": {"title": "SamplerCustomAdvanced"}},
        "105:16": {"inputs": {"model": ["105:121", 0], "conditioning": ["105:104", 0]}, "class_type": "BasicGuider",
                   "_meta": {"title": "Basic Guider"}},
        "105:6": {"inputs": {"unet_name": "minimax_h3_fl2va_bf16.safetensors", "weight_dtype": "default"},
                  "class_type": "UNETLoader", "_meta": {"title": "Load Diffusion Model"}},
        "105:13": {"inputs": {"clip_name": "qwen3vl_32b_minimax_h3_bf16.safetensors", "type": "minimax",
                               "device": "default"}, "class_type": "CLIPLoader", "_meta": {"title": "Load CLIP"}},
        "105:15": {"inputs": {"noise_seed": int(time.time() * 1000) % (2**32)}, "class_type": "RandomNoise",
                   "_meta": {"title": "RandomNoise"}},
        "105:104": {
            "inputs": {"prompt": prompt or (
                                  "Cinematic scene starting exactly from <Image 1>. Preserve the subject's "
                                  "appearance, clothing, and the original background exactly as shown. A slow, "
                                  "smooth camera push-in with subtle natural motion in the subject and "
                                  "environment (gentle breathing, hair and fabric moving softly, ambient light "
                                  "shifting), soft cinematic color grading, shallow depth of field. Calm, "
                                  "atmospheric ambient sound matching the scene, no dialogue."),
                       "width": width, "height": height, "length": ["105:107", 1],
                       "clip": ["105:13", 0], "vae": ["105:11", 0], "first_frame": ["114", 0]},
            "class_type": "MiniMaxH3ImageToVideo", "_meta": {"title": "Image to Video"},
        },
        "105:107": {
            "inputs": {"expression": "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17",
                       "values.a": ["105:111", 0]},
            "class_type": "ComfyMathExpression", "_meta": {"title": "Math Expression"},
        },
        "105:111": {"inputs": {"value": duration_s}, "class_type": "PrimitiveFloat",
                    "_meta": {"title": "Float (duration)"}},
        "105:121": {"inputs": {"reuse_threshold": 0.3, "start_percent": 0.2, "end_percent": 0.9, "verbose": False,
                                "model": ["105:124", 0]}, "class_type": "EasyCache", "_meta": {"title": "EasyCache"}},
        "105:124": {"inputs": {"sage_attention": "auto", "allow_compile": allow_compile,
                                "model": ["105:131", 0] if (use_vdn and use_sparse_attn)
                                else (["105:130", 0] if use_vdn
                                else (["105:125", 0] if use_turbo_lora else ["105:6", 0]))},
                    "class_type": "PathchSageAttentionKJ", "_meta": {"title": "Patch Sage Attention KJ"}},
        "105:125": {"inputs": {"lora_name": "minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors",
                                "strength_model": 1, "model": ["105:6", 0]},
                    "class_type": "LoraLoaderModelOnly", "_meta": {"title": "Load LoRA"}},
    }
    if use_vdn:
        # VDN-H3 (github.com/Saganaki22/ComfyUI-VDN-H3, Apache-2.0; adapter
        # weights github.com/OpenVDN/vdn-minimax-h3, Apache-2.0) — 2026-09-13
        # 導入検証。apply_turbo_adapter=False は50ステップ非蒸留チェックポイント
        # (stage-b-step-2000)を使う設定。ノードの検証コードは
        # blocks[].attn.qkv_proj の構造とVDNチェックポイントの重み形状一致
        # のみをチェックし量子化の有無を問わないため、BF16フルモデル
        # (minimax_h3_fl2va_bf16.safetensors)にそのまま適用できる（実装
        # ソース読解で確認済み）。lora_mode="bypass" が既定(非破壊・低VRAM
        # オーバーヘッド) — B300のフルVRAMを活かすBF16常駐方針と合致する。
        workflow["105:130"] = {
            "inputs": {
                "model": ["105:6", 0],
                "vdn_checkpoint": vdn_checkpoint,
                "apply_turbo_adapter": vdn_turbo,
                "strength": 1.0,
                "lora_mode": "bypass",
                "branch_weights": "auto",
                "retain_buffers": "auto",
                "attention_backend": "grouped",
                "verbose": True,
            },
            "class_type": "ApplyVDNH3", "_meta": {"title": "Apply VDN-H3 (MiniMax-H3 Hybrid Attention)"},
        }
        if use_sparse_attn:
            # ComfyUI core BlockSparseAttention（comfy_extras/nodes_sparse_attention.py、
            # v0.35.0で追加）— 2026-09-13、VDN-H3の上にさらに重ねられるか検証。
            # sol-attn は学習不要・専用重み不要（sla/vsaは専用LoRA/チェックポイント
            # が必要なため除外）。VDN-H3はQKV射影へのLoRA的差分、こちらはAttention
            # 計算自体の疎化と別レイヤーの最適化なので理論上は直交するはずだが、
            # 実装コードを読んだだけでは併用時の相互作用を断定できないため実機で検証する。
            workflow["105:131"] = {
                "inputs": {
                    "model": ["105:130", 0],
                    "selection": "sol-attn",
                    "selection.tau": 1.3,
                    "start_percent": 0.2,
                    "end_percent": 1.0,
                    "dense_blocks": "",
                    "min_tokens": 12288,
                    "extra_tokens": 256,
                    "sink_conditioning": "exact_kv_and_rows",
                    "verbose": True,
                },
                "class_type": "BlockSparseAttention", "_meta": {"title": "Model Sparse Attention"},
            }
    return workflow


@app.local_entrypoint()
def trellis2_smoke(image_path: str = "", workflow_path: str = "", poll_deadline_s: int = 1200):
    """modal run modal_wan_animate_blackwell.py::trellis2_smoke

    ComfyUI Native TRELLIS.2の実機テスト（2026-09-14）。ComfyUI公式テンプレート
    （Comfy-Org/workflow_templates の3d_pixal3d_trellis2_image_to_model.json）
    からPixal3D分岐を除去しBF16化した単体TRELLIS.2グラフを実行し、.glbを
    出力する。GPU課金あり（setup_trellis2で重み取得済みが前提）。"""
    ref_path = image_path or "D:/web/46FF6DBB-FCAC-4CE3-BC71-82705E47926D.png"
    wf_path = workflow_path or "D:/web/trellis2_api_final.json"
    with open(ref_path, "rb") as f:
        image_b64 = base64.b64encode(f.read()).decode("ascii")
    with open(wf_path, encoding="utf-8") as f:
        workflow_json = f.read()

    started = time.time()
    result = WanAnimateBlackwell().run_custom_workflow.remote(
        workflow_json,
        {"ull_ref.png": image_b64},
        None,  # exec_config: default (BLACKWELL_EXEC_CONFIG)
        False,  # save_to_volume
        "322",  # output_node_id: Save3DAdvanced
        None, None, 0, None,  # job_id, user_id, credits_cost, active_job_id
        True,  # skip_torch_compile — no diffusion-model loader-swap heuristic needed here
        poll_deadline_s,
    )
    elapsed = time.time() - started
    out_path = f"D:/web/trellis2_result_{result['filename']}"
    with open(out_path, "wb") as f:
        f.write(base64.b64decode(result["result_base64"]))
    print(
        f"[trellis2_smoke] OK elapsed={elapsed:.1f}s vram={result.get('vram_used_gb')}GB "
        f"-> {out_path}"
    )


@app.local_entrypoint()
def pixal3d_smoke(image_path: str = "", workflow_path: str = "", poll_deadline_s: int = 1200):
    """modal run modal_wan_animate_blackwell.py::pixal3d_smoke

    Pixal3Dの社内品質確認テスト（2026-09-14、本番採用ではない — CLAUDE.md §5
    によりライセンス未確定のため保留中）。同じ参照画像・同じ後段メッシュ
    パイプラインでTRELLIS.2とPixal3Dを比較する。GPU課金あり
    （setup_pixal3dで重み取得済みが前提）。"""
    ref_path = image_path or "D:/web/46FF6DBB-FCAC-4CE3-BC71-82705E47926D.png"
    wf_path = workflow_path or "D:/web/pixal3d_api_final.json"
    with open(ref_path, "rb") as f:
        image_b64 = base64.b64encode(f.read()).decode("ascii")
    with open(wf_path, encoding="utf-8") as f:
        workflow_json = f.read()

    started = time.time()
    result = WanAnimateBlackwell().run_custom_workflow.remote(
        workflow_json,
        {"ull_ref.png": image_b64},
        None, False, "322",
        None, None, 0, None,
        True, poll_deadline_s,
    )
    elapsed = time.time() - started
    out_path = f"D:/web/pixal3d_result_{result['filename']}"
    with open(out_path, "wb") as f:
        f.write(base64.b64decode(result["result_base64"]))
    print(
        f"[pixal3d_smoke] OK elapsed={elapsed:.1f}s vram={result.get('vram_used_gb')}GB "
        f"-> {out_path}"
    )


@app.local_entrypoint()
def probe_trellis2_nodes():
    """modal run modal_wan_animate_blackwell.py::probe_trellis2_nodes

    GPU起動のみ・ワークフロー実行なしで、ピン止め中のComfyUI v0.35.1に
    TRELLIS.2ネイティブノード（comfy_extras/nodes_trellis2.py）が実際に
    存在するか、正確なclass_type名と入出力スキーマを確認する
    （2026-09-14、image-to-3D機能の実機検証の第一歩）。"""
    result = WanAnimateBlackwell().probe_object_info_search.remote(["trellis"])
    if not result.get("ok"):
        print(f"[probe_trellis2_nodes] FAILED: {result.get('error')}")
        return
    print(f"[probe_trellis2_nodes] found {result['count']} matching node(s):")
    for name in result["matches"]:
        print(f"  - {name}")
    print(json.dumps(result["matches"], ensure_ascii=False, indent=2))


@app.local_entrypoint()
def probe_node_search(terms: str = "trellis,glb,voxel,mesh,gltf,clip_vision,clipvision"):
    """modal run modal_wan_animate_blackwell.py::probe_node_search --terms trellis,glb

    GPU起動のみ・ワークフロー実行なしで、カンマ区切りの部分文字列に一致する
    class_type を /object_info 全体から検索する汎用プローブ（2026-09-14）。"""
    subs = [t.strip() for t in terms.split(",") if t.strip()]
    result = WanAnimateBlackwell().probe_object_info_search.remote(subs)
    if not result.get("ok"):
        print(f"[probe_node_search] FAILED: {result.get('error')}")
        return
    print(f"[probe_node_search] found {result['count']} matching node(s):")
    for name in result["matches"]:
        print(f"  - {name}")


@app.local_entrypoint()
def probe_minimax_schema():
    """modal run modal_wan_animate_blackwell.py::probe_minimax_schema

    GPU起動のみ・ワークフロー実行なしで MiniMaxH3ImageToVideo / ImageScale の
    実際の /object_info を取得する（2026-09-13 デバッグ用）。"""
    result = WanAnimateBlackwell().probe_node_schema.remote(["MiniMaxH3ImageToVideo", "ImageScale"])
    print(json.dumps(result, ensure_ascii=False, indent=2))


@app.function(image=image, gpu="B300", timeout=180)
def probe_vdn_h3_import() -> dict:
    """VDN-H3(Saganaki22/ComfyUI-VDN-H3)がピン止め中のComfyUI v0.33.3に
    importできるかだけを確認する（2026-09-13、VDN-H3導入可否調査）。

    2026-09-13: 当初CPU専用(gpu=なし)で試したが、ComfyUI本体の
    comfy.model_management がimport時点で無条件にtorch.cuda.current_device()
    を呼ぶ設計のため、GPUドライバ無しでは RuntimeError: Found no NVIDIA driver
    で止まることが実機で判明（VDN-H3固有の問題ではない）。そのためGPU起動は
    必須だが、ワークフロー実行・モデルロードは一切せずimportのみ確認する
    （フル生成に比べて課金は最小限）。"""
    import subprocess
    import sys as _sys
    import traceback

    dest = f"{COMFY_DIR}/custom_nodes/ComfyUI-VDN-H3"
    clone = subprocess.run(
        ["git", "clone", "--depth", "1", "https://github.com/Saganaki22/ComfyUI-VDN-H3.git", dest],
        capture_output=True, text=True, timeout=60,
    )
    if clone.returncode != 0:
        return {"ok": False, "stage": "git clone", "stderr": clone.stderr}

    _sys.path.insert(0, COMFY_DIR)
    _sys.path.insert(0, dest)  # vdn_h3/ is a subpackage of the cloned repo root
    try:
        from vdn_h3.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

        return {
            "ok": True,
            "node_classes": list(NODE_CLASS_MAPPINGS.keys()),
            "display_names": list(NODE_DISPLAY_NAME_MAPPINGS.values()),
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False, "stage": "import",
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc(),
        }


@app.local_entrypoint()
def probe_v0351_nodes():
    """modal run modal_wan_animate_blackwell.py::probe_v0351_nodes

    GPU起動のみ・ワークフロー実行なしで、ComfyUI v0.35.1アップグレード後に
    必要なノード（VHS_VideoCombine, BlockSparseAttention,
    MiniMaxH3ImageToVideo, ApplyVDNH3）が揃っているか確認する（2026-09-13）。"""
    result = WanAnimateBlackwell().probe_node_schema.remote(
        ["VHS_VideoCombine", "BlockSparseAttention", "MiniMaxH3ImageToVideo", "ApplyVDNH3"]
    )
    for name, schema in result.items():
        ok = isinstance(schema, dict) and "input" in schema
        print(f"[probe_v0351_nodes] {name}: {'OK' if ok else 'MISSING/ERROR -> ' + str(schema)[:200]}")


@app.local_entrypoint()
def probe_vdn_advanced_schema():
    """modal run modal_wan_animate_blackwell.py::probe_vdn_advanced_schema

    GPU起動のみ・ワークフロー実行なしで ApplyVDNH3Advanced の実際の
    /object_info を取得する（2026-09-13、fast_kernels 検証用）。"""
    result = WanAnimateBlackwell().probe_node_schema.remote(["ApplyVDNH3Advanced"])
    print(json.dumps(result, ensure_ascii=False, indent=2))


@app.local_entrypoint()
def probe_vdn_h3():
    """modal run modal_wan_animate_blackwell.py::probe_vdn_h3

    CPU専用プローブ。GPU課金なし。"""
    result = probe_vdn_h3_import.remote()
    if result["ok"]:
        print(f"[probe_vdn_h3] OK node_classes={result['node_classes']} display_names={result['display_names']}")
    else:
        print(f"[probe_vdn_h3] FAILED at {result['stage']}:")
        print(result.get("stderr") or result.get("traceback") or result.get("error"))


@app.function(image=image, volumes={MODELS_DIR: vol}, timeout=120)
def install_vdn_h3_node() -> dict:
    """VDN-H3ノードを(ephemeralな使い捨てクローンではなく) Volume 側の
    custom_nodes/ へ永続インストールする（2026-09-13）。ModalStorageBlackwell.
    _install_node と同じ仕組み・同じ格納場所を使うので、次回以降のコンテナ
    起動時に WanAnimateBlackwell.setup() が自動でシンボリックリンクする。
    CPU専用・GPU課金なし。"""
    import subprocess

    dest = os.path.join(MODELS_DIR, CUSTOM_NODES_SUBDIR, "ComfyUI-VDN-H3")
    if os.path.exists(dest):
        return {"ok": True, "already_installed": True}
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    clone = subprocess.run(
        ["git", "clone", "--depth", "1", "https://github.com/Saganaki22/ComfyUI-VDN-H3.git", dest],
        capture_output=True, text=True, timeout=60,
    )
    if clone.returncode != 0:
        return {"ok": False, "stderr": clone.stderr}
    vol.commit()
    return {"ok": True, "already_installed": False}


@app.function(image=image, volumes={MODELS_DIR: vol}, timeout=1200)
def download_vdn_checkpoint(stage: str = "stage-b-step-2000") -> dict:
    """OpenVDN/vdn-minimax-h3からVDNブランチの重みだけを狙ってダウンロードする
    （2026-09-13）。Modal Volumeが既に~939GB/1TBに迫っているため（[[modal-volume-
    storage-1tb-limit]]）、snapshot_downloadのallow_patternsでリポジトリ全体
    ではなく指定stageディレクトリのみに絞る。既定は50ステップ非蒸留版・bf16
    （stage-b-step-2000、約4.3GB）— 4ステップターボLoRAで学んだ「蒸留版は
    プロンプト再現度を犠牲にする」教訓([[cinematic-video-tab]]系の投稿参照)
    により、品質検証にはこちらを使う。CPU専用・GPU課金なし。"""
    from huggingface_hub import snapshot_download

    dest_dir = os.path.join(MODELS_DIR, "vdn")
    os.makedirs(dest_dir, exist_ok=True)
    snapshot_download(
        repo_id="OpenVDN/vdn-minimax-h3",
        local_dir=dest_dir,
        allow_patterns=[f"{stage}/*"],
    )
    vol.commit()
    stage_dir = os.path.join(dest_dir, stage)
    files = os.listdir(stage_dir) if os.path.isdir(stage_dir) else []
    return {"ok": True, "stage_dir": stage_dir, "files": files}


@app.function(image=image, volumes={MODELS_DIR: vol}, timeout=2400)
def download_trellis2_weights() -> dict:
    """ComfyUI Native TRELLIS.2（comfy_extras/nodes_trellis2.py、v0.35.1で
    存在確認済み — nvdiffrast/nvdiffrec不使用でCLAUDE.md §5準拠）の重みを
    CPU専用でVolumeへ落とす（2026-09-14、image-to-3D機能の実機検証）。
    Comfy-Org/TRELLIS.2 のリポジトリ内フォルダ構成
    （clip_vision/・diffusion_models/・vae/）がComfyUIのfolder_paths.py規約と
    一致しているため、local_dir=MODELS_DIR に直接展開できる。BF16フル精度版
    のみ取得（int8_convrot版は量子化のためCLAUDE.md §1既定に反し取得しない）。
    背景除去（RemoveBackground/LoadBackgroundRemovalModel）用のBiRefNetは
    別リポジトリ（Comfy-Org/BiRefNet）。CPU専用・GPU課金なし。"""
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id="Comfy-Org/TRELLIS.2",
        local_dir=MODELS_DIR,
        allow_patterns=[
            "clip_vision/dino_v3_vit_l.safetensors",
            "diffusion_models/trellis_2_bf16.safetensors",
            "vae/trellis_2_shape_vae_bf16.safetensors",
            "vae/trellis_2_texture_vae_bf16.safetensors",
        ],
    )
    snapshot_download(
        repo_id="Comfy-Org/BiRefNet",
        local_dir=MODELS_DIR,
        allow_patterns=["background_removal/birefnet.safetensors"],
    )
    vol.commit()

    staged = {}
    for sub, fname in [
        ("clip_vision", "dino_v3_vit_l.safetensors"),
        ("diffusion_models", "trellis_2_bf16.safetensors"),
        ("vae", "trellis_2_shape_vae_bf16.safetensors"),
        ("vae", "trellis_2_texture_vae_bf16.safetensors"),
        ("background_removal", "birefnet.safetensors"),
    ]:
        p = os.path.join(MODELS_DIR, sub, fname)
        staged[f"{sub}/{fname}"] = os.path.getsize(p) if os.path.isfile(p) else None
    return {"ok": all(v for v in staged.values()), "staged": staged}


@app.function(image=image, volumes={MODELS_DIR: vol}, timeout=2400)
def download_pixal3d_weights() -> dict:
    """Pixal3D（社内品質確認限定 — ライセンス未確定・TencentARC/Pixal3D
    Issue #33 未回答、CLAUDE.md §5により本番採用は保留）の重みをCPU専用で
    取得する（2026-09-14）。bf16版は既知のシェイプ不一致クラッシュ
    （Comfy-Org/ComfyUI Issue #16056）があるため、動作するint8_convrot版を
    使う — CLAUDE.md §1のBF16既定からの一時的な逸脱だが、社内品質確認限定・
    bf16に動く代替が無いことをホストに開示済み。VAE（trellis_2_shape/
    texture_vae）はTRELLIS.2と共有・取得済み。CPU専用・GPU課金なし。"""
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id="Comfy-Org/Pixal3D",
        local_dir=MODELS_DIR,
        allow_patterns=[
            "clip_vision/dino_v3_L_naf_fp32.safetensors",
            "diffusion_models/pixal3d_int8_convrot.safetensors",
        ],
    )
    snapshot_download(
        repo_id="Comfy-Org/MoGe",
        local_dir=MODELS_DIR,
        allow_patterns=["geometry_estimation/moge_2_vitl_normal_fp16.safetensors"],
    )
    vol.commit()

    staged = {}
    for sub, fname in [
        ("clip_vision", "dino_v3_L_naf_fp32.safetensors"),
        ("diffusion_models", "pixal3d_int8_convrot.safetensors"),
        ("geometry_estimation", "moge_2_vitl_normal_fp16.safetensors"),
    ]:
        p = os.path.join(MODELS_DIR, sub, fname)
        staged[f"{sub}/{fname}"] = os.path.getsize(p) if os.path.isfile(p) else None
    return {"ok": all(v for v in staged.values()), "staged": staged}


@app.local_entrypoint()
def setup_pixal3d():
    """modal run modal_wan_animate_blackwell.py::setup_pixal3d

    Pixal3D（社内品質確認限定）の重みダウンロードのみ。CPU専用・GPU課金なし。"""
    result = download_pixal3d_weights.remote()
    print(f"[setup_pixal3d] {json.dumps(result, ensure_ascii=False, indent=2)}")


@app.local_entrypoint()
def setup_trellis2():
    """modal run modal_wan_animate_blackwell.py::setup_trellis2

    TRELLIS.2 + BiRefNet の重みダウンロードのみ（CPU専用・GPU課金なし）。"""
    result = download_trellis2_weights.remote()
    print(f"[setup_trellis2] {json.dumps(result, ensure_ascii=False, indent=2)}")


@app.local_entrypoint()
def setup_vdn_h3():
    """modal run modal_wan_animate_blackwell.py::setup_vdn_h3

    VDN-H3ノードのインストール + 50ステップ非蒸留版チェックポイントの
    ダウンロードを両方まとめて行う。CPU専用・GPU課金なし。"""
    node_result = install_vdn_h3_node.remote()
    print(f"[setup_vdn_h3] node install: {node_result}")
    ckpt_result = download_vdn_checkpoint.remote()
    print(f"[setup_vdn_h3] checkpoint download: {ckpt_result}")


@app.local_entrypoint()
def cinematic_smoke(
    duration_s: float = 15.0, image_path: str = "", allow_compile: bool = True,
    skip_torch_compile: bool = False, megapixels: float = 0.262144,
    steps: int = 4, use_turbo_lora: bool = True, prompt: str = "",
    poll_deadline_s: int = 1500, modal_timeout_s: int = 1800,
    use_vdn: bool = False, vdn_checkpoint: str = "stage-b-step-2000",
    use_sparse_attn: bool = False, vdn_turbo: bool = False,
    force_width: int = 0, force_height: int = 0, seed: int = 0,
):
    """modal run modal_wan_animate_blackwell.py::cinematic_smoke --duration-s 15 --skip-torch-compile

    実測用: 2026-09-09 postmortem（[[cinematic-video-tab]]）が「MiniMax H3は
    15秒(362フレーム)でクラッシュする」とした主張を、現在ピン止め中の
    ComfyUI v0.33.3 に対して再検証する。--duration-s を振って実際の安全な
    上限を実測する。2026-09-13 実測: 15秒で torch.compile(Dynamo)の
    patchify reshape が shape mismatch でクラッシュ（33x33 latentが16x2
    パッチに割り切れない）。PathchSageAttentionKJ の allow_compile=False では
    直らなかった — 実際にモデルを包んでいるのは _inject_torch_compile が
    自動注入する "torch_compile_std"（TorchCompileModel、CLAUDE.md §1）の方
    なので、run_custom_workflow の skip_torch_compile 引数で切り分ける。
    GPU課金あり。"""
    ref_path = image_path or os.environ.get(
        "CINEMATIC_TEST_IMAGE",
        "C:/Users/t-num/AppData/Local/Temp/claude/D--web/13c90d9c-d409-402f-8ce5-328f30a09797/scratchpad/cinematic_test.png",
    )
    with open(ref_path, "rb") as f:
        image_b64 = base64.b64encode(f.read()).decode("ascii")
    image_name = os.path.basename(ref_path)

    # 実画像の生の寸法を読む（cinematicSafeDimensions と同じロジックで
    # width/height を計算するため — 正方形でないアスペクト比の実障害
    # （2026-09-13, Cinematic Director）を再現・検証する）。
    from PIL import Image as _PILImage

    with _PILImage.open(ref_path) as _im:
        raw_w, raw_h = _im.size

    workflow = _cinematic_workflow(
        duration_s, image_name, allow_compile=allow_compile, megapixels=megapixels,
        raw_w=raw_w, raw_h=raw_h, steps=steps, use_turbo_lora=use_turbo_lora, prompt=prompt,
        use_vdn=use_vdn, vdn_checkpoint=vdn_checkpoint, use_sparse_attn=use_sparse_attn,
        vdn_turbo=vdn_turbo,
    )
    if force_width and force_height:
        # BF16 vs INT8(ローカル) の同一条件比較用（2026-09-13）: 参照画像の
        # アスペクト比から自動計算する代わりに、両側で完全に同じ解像度を
        # 強制する。32の倍数であることはホスト側で確認済み前提。
        workflow["105:104"]["inputs"]["width"] = force_width
        workflow["105:104"]["inputs"]["height"] = force_height
    if seed:
        workflow["105:15"]["inputs"]["noise_seed"] = seed
    workflow_json = json.dumps(workflow)

    print(
        f"[cinematic_smoke] duration_s={duration_s} image={ref_path} "
        f"skip_torch_compile={skip_torch_compile} megapixels={megapixels}"
    )
    started = time.time()
    try:
        worker_cls = WanAnimateBlackwell.with_options(timeout=modal_timeout_s)
        result = worker_cls().run_custom_workflow.remote(
            workflow_json,
            {image_name: image_b64},
            None,
            False,
            None,
            None,
            None,
            0,
            None,
            skip_torch_compile,
            poll_deadline_s,
        )
    except Exception as exc:  # noqa: BLE001
        elapsed = time.time() - started
        print(f"[cinematic_smoke] FAILED after {elapsed:.1f}s: {type(exc).__name__}: {exc}")
        raise
    elapsed = time.time() - started

    out_path = pathlib.Path(f"cinematic_smoke_{int(duration_s)}s.mp4")
    out_path.write_bytes(base64.b64decode(result["result_base64"]))
    print(
        f"[cinematic_smoke] OK duration_s={duration_s} elapsed={elapsed:.1f}s "
        f"vram={result.get('vram_used_gb')}GB -> {out_path.resolve()} ({out_path.stat().st_size} bytes)"
    )
