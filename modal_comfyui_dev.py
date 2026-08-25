"""
ComfyUI dev GUI on Modal — a cheap, disposable web server for poking at
workflows/nodes/models by hand (node wiring, patch nodes like EasyCache /
SageAttention, quick sanity tests) against the same persistent Volume
(ull-wan-models) production uses, without spinning up a paid B300/L40S GPU
just to open the ComfyUI UI.

Deliberately skips the from-source SageAttention build that
scripts/modal_wan_animate.py does for its production GPU tiers: that CUDA
toolkit + compile step targets Ada/Blackwell (TORCH_CUDA_ARCH_LIST
"8.9;10.0") and wouldn't even run on a T4 (Turing, sm_75) — and it's slow,
which is the opposite of what a quick dev loop wants. ComfyUI's built-in
PyTorch attention is used instead. This file is standalone and never
touches the production app/deployment in scripts/modal_wan_animate.py.

Usage:
  modal serve modal_comfyui_dev.py
    - starts the ComfyUI web server on a T4, prints its HTTPS URL (e.g.
      https://xxxx--ull-comfyui-dev-comfyui-server-dev.modal.run) — open it
      in a browser to use the real ComfyUI GUI. Ctrl+C tears the container
      down.
    - NOT `modal run`: the Modal CLI's `run` subcommand explicitly excludes
      web-endpoint functions (@modal.web_server / @modal.asgi_app / etc.) —
      import_and_filter() in modal/cli/run.py hardcodes
      accept_webhook=False, so `modal run modal_comfyui_dev.py` fails with
      "has no functions or local entrypoints" even though the function is
      registered. `modal serve` is Modal's actual ephemeral-web-endpoint
      command (ephemeral App for the life of the command, temporary URL,
      Ctrl+C to tear down) — see https://modal.com/docs/guide/webhooks.
    - the GPU also self-terminates after TIMEOUT_SECONDS regardless, as a
      safety valve against a forgotten/disconnected session racking up
      charges.

Env override:
  COMFYUI_DEV_GPU — GPU type to request (default: T4)
"""

import os
import subprocess
import time
import urllib.request

import modal

app = modal.App("ull-comfyui-dev")

COMFY_DIR = "/root/comfy/ComfyUI"

# A *separate* mount point from ComfyUI's own models/ dir — Modal refuses to
# mount a Volume onto a path that isn't empty at container start, and
# COMFY_DIR/models already has content from the `git clone` in the image
# build below (this is exactly why the previous revision, which mounted the
# Volume directly at COMFY_DIR/models, crashed every container instantly
# with "cannot mount volume on non-empty path" — never actually reaching
# ComfyUI's own startup code, despite that failure surfacing to the browser
# as a generic 500). Mirrors scripts/modal_wan_animate.py's MODELS_DIR +
# per-subfolder symlink approach for the same reason.
VOLUME_MOUNT_DIR = "/models"

# Mirrors MODEL_SUBFOLDERS in scripts/modal_wan_animate.py.
MODEL_SUBFOLDERS = ("diffusion_models", "text_encoders", "vae", "clip_vision", "loras", "checkpoints")
CUSTOM_NODES_SUBDIR = "custom_nodes"
COMFYUI_PORT = 8188
COMFYUI_LOG_PATH = "/tmp/comfyui.log"

DEFAULT_GPU = "T4"
TIMEOUT_SECONDS = 1800  # 30 min safety valve — auto-shuts-down the GPU rather than risking a forgotten session.
READY_TIMEOUT_SECONDS = 240  # Comfortably under startup_timeout below, leaving Modal margin to notice readiness too.

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libgl1-mesa-glx", "libglib2.0-0", "wget")
    .pip_install(
        "torch",
        "torchvision",
        "torchaudio",
        extra_index_url="https://download.pytorch.org/whl/cu130",
    )
    .pip_install("comfy-cli", "websockets", "requests", "aiohttp", "fastapi[standard]", "huggingface_hub")
    .run_commands(
        f"git clone https://github.com/comfyanonymous/ComfyUI.git {COMFY_DIR}",
        # Same pinned release as scripts/modal_wan_animate.py, so nodes
        # tested here behave identically once promoted to production.
        f"cd {COMFY_DIR} && git fetch --tags && git checkout v0.33.3",
        f"cd {COMFY_DIR} && pip install -r requirements.txt",
    )
    .run_commands(
        f"git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git"
        f" {COMFY_DIR}/custom_nodes/ComfyUI-VideoHelperSuite",
        f"git clone https://github.com/IAMCCS/IAMCCS-nodes.git"
        f" {COMFY_DIR}/custom_nodes/IAMCCS-nodes || echo 'IAMCCS-nodes clone failed, continuing without it'",
    )
)


def _link_model_folders():
    """Symlinks each Volume model subfolder into ComfyUI's models/ dir —
    mirrors _WanAnimateBase.setup() in scripts/modal_wan_animate.py. Each
    subfolder is handled independently so one bad symlink (a stale file
    where a dir should be, odd permissions, whatever) can't take the rest
    down with it — that's the whole point of a Volume mounted separately
    from ComfyUI's own models/ dir, not merged into it."""
    import shutil

    for sub in MODEL_SUBFOLDERS:
        try:
            src = os.path.join(VOLUME_MOUNT_DIR, sub)
            dst = os.path.join(COMFY_DIR, "models", sub)
            os.makedirs(src, exist_ok=True)
            if os.path.islink(dst):
                os.remove(dst)
            elif os.path.isdir(dst):
                shutil.rmtree(dst)
            elif os.path.exists(dst):
                os.remove(dst)
            os.symlink(src, dst)
        except Exception as exc:  # noqa: BLE001 — one bad folder must not block ComfyUI from starting at all
            print(f"[comfyui-dev] failed to link model folder {sub!r}: {exc} — continuing without it.")


def _link_custom_nodes():
    """
    Symlinks admin-installed custom nodes (scripts/modal_wan_animate.py's
    ModalStorage.install_node writes them under the Volume's custom_nodes/
    folder) into ComfyUI's own custom_nodes/ dir, one at a time and each
    wrapped in its own try/except — a custom node that doesn't actually
    work on a T4 (e.g. a compiled extension built for a different GPU
    architecture) must only fail to load itself, never crash ComfyUI's
    entire startup and take the whole dev server down with it.
    """
    volume_nodes_dir = os.path.join(VOLUME_MOUNT_DIR, CUSTOM_NODES_SUBDIR)
    target_dir = os.path.join(COMFY_DIR, "custom_nodes")
    if not os.path.isdir(volume_nodes_dir):
        return
    for name in os.listdir(volume_nodes_dir):
        try:
            src = os.path.join(volume_nodes_dir, name)
            if not os.path.isdir(src):
                continue
            dst = os.path.join(target_dir, name)
            if os.path.islink(dst):
                os.remove(dst)
            elif os.path.exists(dst):
                continue  # an image-baked dir with this name wins
            os.symlink(src, dst)
        except Exception as exc:  # noqa: BLE001 — see docstring
            print(f"[comfyui-dev] failed to link custom node {name!r}: {exc} — skipping it.")


def _wait_until_ready(proc: subprocess.Popen, timeout: float) -> None:
    """
    Polls ComfyUI's own /system_stats endpoint until it responds, so the
    web_server only starts routing traffic once ComfyUI is actually up
    (rather than relying solely on the TCP port being open, which can
    accept connections slightly before the app behind it is ready). Also
    watches the subprocess itself: if it has already exited — a crash
    during custom-node import, for instance — this raises immediately with
    the captured log tail instead of waiting out the full timeout and
    surfacing nothing but a generic port-never-opened failure.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(
                f"ComfyUI exited early (code {proc.returncode}) before becoming ready. "
                f"Last output:\n{_tail_log()}"
            )
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_PORT}/system_stats", timeout=2)
            return
        except Exception:
            time.sleep(1)
    raise RuntimeError(f"ComfyUI did not become ready within {timeout}s. Last output:\n{_tail_log()}")


def _tail_log(max_chars: int = 4000) -> str:
    try:
        with open(COMFYUI_LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
            return f.read()[-max_chars:]
    except OSError:
        return "(no log captured)"


@app.function(
    image=image,
    gpu=os.environ.get("COMFYUI_DEV_GPU", DEFAULT_GPU),
    timeout=TIMEOUT_SECONDS,
    volumes={VOLUME_MOUNT_DIR: vol},
)
@modal.web_server(port=COMFYUI_PORT, startup_timeout=300)
def comfyui_server():
    _link_model_folders()
    _link_custom_nodes()

    # ComfyUI's stdout/stderr is captured to a file (rather than left to
    # inherit the parent's, which @modal.web_server doesn't reliably
    # surface once this function has returned) so a crash's traceback is
    # always available — both printed here via _tail_log() into this
    # function's own logs (visible in the Modal dashboard) on failure, and
    # left on disk for `modal shell`/exec-style debugging.
    log_file = open(COMFYUI_LOG_PATH, "w")
    proc = subprocess.Popen(
        [
            "python",
            "main.py",
            "--listen",
            "0.0.0.0",
            "--port",
            str(COMFYUI_PORT),
            # T4 has 16GB VRAM — --highvram (keep everything resident) risks
            # OOM on larger workflows; --dont-upcast-attention avoids the
            # fp32 attention upcast ComfyUI defaults to, which meaningfully
            # helps on VRAM-constrained cards like this one.
            "--dont-upcast-attention",
        ],
        cwd=COMFY_DIR,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )

    _wait_until_ready(proc, READY_TIMEOUT_SECONDS)
    print("[comfyui-dev] ComfyUI is up and responding on :8188.")
