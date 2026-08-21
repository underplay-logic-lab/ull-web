"""
Wan Animate 2 on Modal — GPU inference service backed by a persistent Volume.

Clones ComfyUI's master branch (targeting the v0.31.0+ native Wan Animate 2
support) fresh at image-build time, installs a couple of supporting custom
node packs, and downloads the Wan 2.1 / Wan Animate 2 model weights into a
Modal Volume on first run so subsequent cold starts skip the download.

Usage:
  modal run scripts/modal_wan_animate.py
    - ensures models are present in the volume, then submits a one-off test
      generation using the same local reference image / pose video / API
      workflow JSON that scripts/test-wan-animate.ts uses against RunPod.

  modal deploy scripts/modal_wan_animate.py
    - publishes the FastAPI POST endpoint for external use.

Env overrides (mirrors scripts/test-wan-animate.ts):
  WAN_WORKFLOW_PATH, WAN_REFERENCE_IMAGE_PATH, WAN_POSE_VIDEO_PATH
"""

import base64
import hmac
import json
import os
import pathlib
import time

import fastapi
import modal

app = modal.App("ull-wan-animate")

MODELS_DIR = "/models"
COMFY_DIR = "/root/comfy/ComfyUI"

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libgl1-mesa-glx", "libglib2.0-0", "wget")
    .pip_install(
        "torch",
        "torchvision",
        "torchaudio",
        "comfy-cli",
        "websockets",
        "requests",
        "aiohttp",
        "fastapi[standard]",
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


@app.cls(
    image=image,
    gpu="L40S",  # swap to "A100-80GB" if L40S availability/VRAM is insufficient
    timeout=600,
    scaledown_window=10,
    volumes={MODELS_DIR: vol},
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
class WanAnimate:
    @modal.enter()
    def setup(self):
        import shutil
        import subprocess

        # Point ComfyUI's model folders at the persistent volume instead of
        # the (ephemeral, per-container) image filesystem.
        for sub in ("diffusion_models", "text_encoders", "vae", "clip_vision", "loras"):
            src = os.path.join(MODELS_DIR, sub)
            dst = os.path.join(COMFY_DIR, "models", sub)
            os.makedirs(src, exist_ok=True)
            if os.path.islink(dst):
                os.remove(dst)
            elif os.path.exists(dst):
                shutil.rmtree(dst)
            os.symlink(src, dst)

        self._proc = subprocess.Popen(
            ["python", "main.py", "--listen", "0.0.0.0", "--port", "8188"],
            cwd=COMFY_DIR,
        )
        self._wait_for_server()

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

    def _run_workflow(self, workflow, reference_image_bytes, reference_image_name, pose_video_bytes, pose_video_name):
        import uuid

        import requests

        input_dir = os.path.join(COMFY_DIR, "input")
        os.makedirs(input_dir, exist_ok=True)
        with open(os.path.join(input_dir, reference_image_name), "wb") as f:
            f.write(reference_image_bytes)
        with open(os.path.join(input_dir, pose_video_name), "wb") as f:
            f.write(pose_video_bytes)

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
        resp.raise_for_status()
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

                for node_output in outputs.values():
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

    @modal.method()
    def generate_video(
        self,
        workflow_json: str,
        reference_image_b64: str,
        reference_image_name: str,
        pose_video_b64: str,
        pose_video_name: str,
    ) -> dict:
        workflow = json.loads(workflow_json)
        video_bytes, filename = self._run_workflow(
            workflow,
            base64.b64decode(reference_image_b64),
            reference_image_name,
            base64.b64decode(pose_video_b64),
            pose_video_name,
        )
        return {"filename": filename, "video_base64": base64.b64encode(video_bytes).decode("ascii")}

    @modal.fastapi_endpoint(method="POST")
    def generate(self, item: dict, request: fastapi.Request):
        expected = os.environ.get("MODAL_AUTH_TOKEN")
        if not expected:
            raise fastapi.HTTPException(status_code=500, detail="Server auth is not configured.")

        provided = request.headers.get("x-modal-secret") or request.headers.get(
            "authorization", ""
        ).removeprefix("Bearer ").strip()

        if not provided or not hmac.compare_digest(provided, expected):
            raise fastapi.HTTPException(status_code=401, detail="Unauthorized")

        return self.generate_video.local(
            item["workflow_json"],
            item["reference_image_b64"],
            item["reference_image_name"],
            item["pose_video_b64"],
            item["pose_video_name"],
        )


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
