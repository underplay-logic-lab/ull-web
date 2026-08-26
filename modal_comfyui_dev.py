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

import hmac
import os
import subprocess
import threading
import time
import urllib.request

import fastapi
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
READY_POLL_INTERVAL_SECONDS = 1
READY_TIMEOUT_SECONDS = 60

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)

# Out-of-band control channel for the admin "🛑 終了" button: Modal exposes
# no public API to force-stop a container from outside, so instead a running
# comfyui_server container watches this Dict itself (see _watch_for_stop)
# and self-terminates the moment a newer stop request appears — the control
# endpoint below never touches the container directly, it just leaves a
# note.
control_dict = modal.Dict.from_name("ull-comfyui-dev-control", create_if_missing=True)
STOP_REQUESTED_AT_KEY = "stop_requested_at"
HEARTBEAT_AT_KEY = "heartbeat_at"
RUNNING_SINCE_KEY = "running_since"
# Written only once _wait_until_ready() actually succeeds (see
# comfyui_server()) — HEARTBEAT_AT_KEY/RUNNING_SINCE_KEY alone can't tell
# "the container function has started" from "ComfyUI is done booting and
# actually serving HTTP", since the heartbeat thread starts before the
# ComfyUI subprocess is even spawned. The admin's launch-loading page polls
# this (via control()'s "status" action's "ready" field) instead of hitting
# the public ComfyUI URL directly, because Modal's own edge can return a
# real (non-2xx) HTTP response — not just refuse the connection — while a
# container is still cold, which a client-side fetch can't tell apart from
# success once page navigation (not fetch) is involved.
READY_AT_KEY = "ready_at"
STOP_POLL_INTERVAL_SECONDS = 3
# How stale a heartbeat can be before the admin "状態確認" check considers
# the container gone — comfortably more than one poll interval so a single
# slow tick doesn't read as "stopped".
HEARTBEAT_STALE_AFTER_SECONDS = 12

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
    # ComfyUI-Manager — baked into the image (not installed via the admin's
    # Volume-based custom-node installer) so it's always present the moment
    # this dev server comes up. _link_custom_nodes()'s "an image-baked dir
    # with this name wins" check (see below) means this real directory is
    # never replaced even if the Volume also happens to have a
    # custom_nodes/ComfyUI-Manager from that installer.
    .run_commands(
        "git clone --depth 1 https://github.com/ltdrdata/ComfyUI-Manager.git"
        f" {COMFY_DIR}/custom_nodes/ComfyUI-Manager",
        f"pip install --no-cache-dir -r {COMFY_DIR}/custom_nodes/ComfyUI-Manager/requirements.txt",
    )
)


def _authorize(request: fastapi.Request) -> None:
    """Shared bearer-token check — same shape as _authorize in
    scripts/modal_wan_animate.py, and reuses the same MODAL_AUTH_TOKEN
    secret/env var so the Next.js side needs no new secret to call this."""
    expected = os.environ.get("MODAL_AUTH_TOKEN")
    if not expected:
        raise fastapi.HTTPException(status_code=500, detail="Server auth is not configured.")

    provided = request.headers.get("x-modal-secret") or request.headers.get(
        "authorization", ""
    ).removeprefix("Bearer ").strip()

    if not provided or not hmac.compare_digest(provided, expected):
        raise fastapi.HTTPException(status_code=401, detail="Unauthorized")


def _watch_for_stop(started_at: float) -> None:
    """
    Background daemon thread started from comfyui_server(): every
    STOP_POLL_INTERVAL_SECONDS, (1) writes a heartbeat to control_dict so
    the admin "状態確認" check can tell a live container from a stopped one
    (see control()'s "status" action), and (2) hard-exits this container
    the instant a stop request newer than *this* container's own start time
    shows up. `requested_at > started_at` is what keeps a stop request from
    also killing a fresh container that happens to start after it — a new
    container's started_at is always later than any stop request already on
    file, so it never matches an old one.
    """
    control_dict[RUNNING_SINCE_KEY] = started_at
    while True:
        try:
            control_dict[HEARTBEAT_AT_KEY] = time.time()
            requested_at = control_dict.get(STOP_REQUESTED_AT_KEY)
            if isinstance(requested_at, (int, float)) and requested_at > started_at:
                print("[comfyui-dev] stop requested — shutting down.")
                os._exit(0)
        except Exception as exc:  # noqa: BLE001 — a control-channel hiccup must never crash ComfyUI itself
            print(f"[comfyui-dev] stop-watcher error (ignored): {exc}")
        time.sleep(STOP_POLL_INTERVAL_SECONDS)


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
            time.sleep(READY_POLL_INTERVAL_SECONDS)
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
@modal.web_server(port=COMFYUI_PORT, startup_timeout=300, requires_proxy_auth=False)
def comfyui_server():
    _link_model_folders()
    _link_custom_nodes()

    # Lets the admin "🛑 終了" button (POST to the control() endpoint below)
    # end this container immediately instead of waiting out TIMEOUT_SECONDS.
    threading.Thread(target=_watch_for_stop, args=(time.time(),), daemon=True).start()

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
    control_dict[READY_AT_KEY] = time.time()
    print(f"[INFO] ComfyUI server is fully ready on port {COMFYUI_PORT}.")


# GPU-less and cheap (no `gpu=` set) — this is a tiny control-plane endpoint,
# not the dev server itself. The admin "🛑 終了" button POSTs
# {"action": "stop"} here; comfyui_server()'s background thread picks the
# request up from control_dict within STOP_POLL_INTERVAL_SECONDS. The
# "状態確認" status check POSTs {"action": "status"} to read the same
# container's heartbeat back out.
@app.function(image=image, timeout=30, secrets=[modal.Secret.from_name("wan-animate-auth")])
@modal.fastapi_endpoint(method="POST")
def control(item: dict, request: fastapi.Request):
    _authorize(request)
    action = item.get("action")
    if action == "stop":
        control_dict[STOP_REQUESTED_AT_KEY] = time.time()
        return {"ok": True, "stop_requested": True}
    if action == "status":
        now = time.time()
        heartbeat_at = control_dict.get(HEARTBEAT_AT_KEY)
        running_since = control_dict.get(RUNNING_SINCE_KEY)
        ready_at = control_dict.get(READY_AT_KEY)
        is_running = isinstance(heartbeat_at, (int, float)) and (now - heartbeat_at) < HEARTBEAT_STALE_AFTER_SECONDS
        # ready_at >= running_since guards against a stale readiness flag
        # left over from a previous container generation reading as "ready"
        # for a fresh one that hasn't finished booting yet — same
        # started_at-comparison pattern _watch_for_stop uses for stop
        # requests above.
        is_ready = (
            is_running
            and isinstance(ready_at, (int, float))
            and isinstance(running_since, (int, float))
            and ready_at >= running_since
        )
        return {
            "running": is_running,
            "running_since": running_since if is_running else None,
            "ready": is_ready,
        }
    raise fastapi.HTTPException(status_code=400, detail=f"Unknown action: {action!r}")
