"""
LoRA Studio worker on Modal — one generic training backend for all three
LoRA Studio modes (fully manual / semi-auto / fully auto).

The mode isn't a parameter here: it's expressed entirely through what the
caller fills in.
  - fully auto   -> captions: [] (Qwen3.8-27B captions everything)
  - semi-auto    -> captions: [...] with some blanks (Qwen fills the gaps)
  - fully manual -> captions: [...] complete, and/or training_config
                    .custom_yaml_override with a raw ai-toolkit job YAML

Everything runs against the persistent Volume (ull-wan-models) mounted at
/models, so the finished LoRA lands in /models/loras/ ready for the next
generation.

Pre-staged resources (Volume: ull-wan-models):
  VLM              /models/LLM/Qwen3.8-27B-abliterated
  MiniMax H3 UNet  /models/diffusion_models/minimax_h3_fl2va_bf16.safetensors
  CLIP             /models/clip/qwen3vl_32b_minimax_h3_bf16.safetensors
  VAE              /models/vae/minimax_h3_video_vae_fp16.safetensors
  Output           /models/loras/

Deploy / run:
  modal deploy modal_lora_worker.py
    - publishes the POST dispatcher (train_lora_dispatch) the Next.js
      /api/studio/lora/train route calls, which .spawn()s train_lora_job.

  modal run modal_lora_worker.py --data-dir ./imgs --lora-name yukipas_h3
    - local one-shot: ships a folder of images straight into train_lora_job.

Env overrides:
  LORA_WORKER_GPU   pin a single GPU instead of the H100 -> A100-80GB list
  AI_TOOLKIT_REF    ai-toolkit git ref (default: main)
"""

import base64
import hmac
import os
import pathlib
import re
import shutil
import subprocess
import threading
import time

import fastapi
import modal

app = modal.App("ull-lora-worker")

MODELS_DIR = "/models"
DATASET_DIR = "/root/dataset"
OUTPUT_DIR = "/root/output"
AI_TOOLKIT_DIR = "/root/ai-toolkit"

VLM_PATH = f"{MODELS_DIR}/LLM/Qwen3.8-27B-abliterated"
LORA_OUTPUT_DIR = f"{MODELS_DIR}/loras"

_GPU_ENV = os.environ.get("LORA_WORKER_GPU", "").strip()
GPU_REQUEST = _GPU_ENV if _GPU_ENV else ["H100", "A100-80GB"]
AI_TOOLKIT_REF = os.environ.get("AI_TOOLKIT_REF", "main")

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

# target_model -> ai-toolkit arch + explicit single-file component paths on
# the Volume. minimax_h3 is fully wired; flux_dev / wan2_1 use the
# conventional ai-toolkit arch names and best-guess Volume paths — override
# per run with training_config.custom_yaml_override if a checkpoint lives
# somewhere else.
TARGET_MODELS: dict[str, dict] = {
    "minimax_h3": {
        "arch": "minimax_h3",
        "unet": f"{MODELS_DIR}/diffusion_models/minimax_h3_fl2va_bf16.safetensors",
        "text_encoder": f"{MODELS_DIR}/clip/qwen3vl_32b_minimax_h3_bf16.safetensors",
        "vae": f"{MODELS_DIR}/vae/minimax_h3_video_vae_fp16.safetensors",
    },
    "flux_dev": {
        "arch": "flux",
        "unet": f"{MODELS_DIR}/diffusion_models/flux1-dev.safetensors",
        "text_encoder": None,
        "vae": f"{MODELS_DIR}/vae/ae.safetensors",
    },
    "wan2_1": {
        "arch": "wan21",
        "unet": f"{MODELS_DIR}/diffusion_models/wan2.1_t2v_14b_bf16.safetensors",
        "text_encoder": f"{MODELS_DIR}/text_encoders/umt5_xxl_fp16.safetensors",
        "vae": f"{MODELS_DIR}/vae/wan_2.1_vae.safetensors",
    },
}

DEFAULT_TRAINING_CONFIG = {
    "rank": 32,
    "alpha": 32,
    "learning_rate": 1e-4,
    "steps": 2000,
    "optimizer": "adamw8bit",
}

# Framing/composition tags and part-detail tags are kept in strictly
# separate groups so the LoRA learns appearance independently of crop.
CAPTION_INSTRUCTION = (
    "You are tagging one training image of a single subject. Output ONE line "
    "of comma-separated lowercase tags, no sentences, in this exact order and "
    "with the groups kept strictly separate:\n"
    "1) the literal trigger token '{trigger}'.\n"
    "2) FRAMING (exactly one, composition only): one of 'head close-up', "
    "'upper body', 'lower body and boots', 'full-body standing view'.\n"
    "3) PART FEATURES (appearance only, never mention crop/zoom/framing): "
    "hair colour and style, eye colour, and each distinctive accessory or "
    "costume detail as its own short tag.\n"
    "4) SCENE: background and lighting, each as its own tag.\n"
    "Never repeat the framing idea inside the part or scene tags. Output only "
    "the tag line."
)

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libgl1-mesa-glx", "libglib2.0-0", "wget")
    .pip_install(
        "torch==2.5.1",
        "torchvision==0.20.1",
        extra_index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        "transformers>=4.49.0",
        "accelerate>=1.2.0",
        "qwen-vl-utils",
        "Pillow",
        "sentencepiece",
        "einops",
        "safetensors",
        "requests",
        "diffusers>=0.32.0",
        "peft>=0.14.0",
        "bitsandbytes",
        "pyyaml",
        "omegaconf",
        "oyaml",
        "albumentations",
        "opencv-python-headless",
        "prodigyopt",
        "lycoris-lora",
        "toml",
    )
    .run_commands(
        f"git clone https://github.com/ostris/ai-toolkit.git {AI_TOOLKIT_DIR}",
        f"cd {AI_TOOLKIT_DIR} && git checkout {AI_TOOLKIT_REF} && git submodule update --init --recursive",
        f"cd {AI_TOOLKIT_DIR} && pip install -r requirements.txt || echo 'ai-toolkit requirements.txt partial install, continuing'",
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1", "PYTHONUNBUFFERED": "1"})
)


# ---------------------------------------------------------------------------
# Auth + Supabase best-effort helpers (mirrors modal_wan_animate_blackwell.py)
# ---------------------------------------------------------------------------
def _authorize(request: fastapi.Request) -> None:
    expected = os.environ.get("MODAL_AUTH_TOKEN")
    if not expected:
        raise fastapi.HTTPException(status_code=500, detail="Server auth is not configured.")
    provided = request.headers.get("x-modal-secret") or request.headers.get(
        "authorization", ""
    ).removeprefix("Bearer ").strip()
    if not provided or not hmac.compare_digest(provided, expected):
        raise fastapi.HTTPException(status_code=401, detail="Unauthorized")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _supabase_request(method: str, path: str, **kwargs):
    import requests

    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        print("[lora-worker] Supabase env not configured, skipping request.")
        return None
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    return requests.request(method, f"{supabase_url}{path}", headers=headers, timeout=10, **kwargs)


def _patch_job(job_id: str, fields: dict) -> None:
    if not job_id:
        return
    try:
        _supabase_request(
            "PATCH",
            "/rest/v1/generation_jobs",
            params={"id": f"eq.{job_id}"},
            json={**fields, "updated_at": _now_iso()},
            headers={"Prefer": "return=minimal"},
        )
    except Exception as exc:  # noqa: BLE001 — best-effort, never propagate
        print(f"[lora-worker] failed to update job {job_id}: {exc}")


def _refund_credits(user_id: str, amount: int) -> None:
    if not user_id or not amount or amount <= 0:
        return
    try:
        res = _supabase_request(
            "GET", "/rest/v1/profiles", params={"id": f"eq.{user_id}", "select": "credits"}
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
    except Exception as exc:  # noqa: BLE001 — best-effort
        print(f"[lora-worker] failed to refund {amount} credits to {user_id}: {exc}")


# ---------------------------------------------------------------------------
# Stage 1 — Qwen3.8-27B captioning (only for images missing a caption)
# ---------------------------------------------------------------------------
def _caption_missing(image_paths: list[pathlib.Path], captions: list[str], trigger: str) -> list[str]:
    """Returns a full caption list aligned to image_paths — supplied entries
    are kept verbatim, blanks/missing entries are filled by the VLM."""
    filled = list(captions) + [""] * max(0, len(image_paths) - len(captions))
    todo = [i for i, cap in enumerate(filled[: len(image_paths)]) if not (cap or "").strip()]
    if not todo:
        print("[stage1] every image already has a caption — skipping the VLM")
        return filled[: len(image_paths)]

    import torch
    from PIL import Image
    from transformers import AutoProcessor

    instruction = CAPTION_INSTRUCTION.format(trigger=trigger)
    print(f"[stage1] captioning {len(todo)}/{len(image_paths)} images with the VLM at {VLM_PATH}")

    model = None
    errors = []
    for loader in ("image-text-to-text", "qwen2_5_vl", "auto"):
        try:
            if loader == "image-text-to-text":
                from transformers import AutoModelForImageTextToText

                model = AutoModelForImageTextToText.from_pretrained(
                    VLM_PATH, torch_dtype=torch.bfloat16, device_map="auto", attn_implementation="sdpa"
                )
            elif loader == "qwen2_5_vl":
                from transformers import Qwen2_5_VLForConditionalGeneration

                model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
                    VLM_PATH, torch_dtype=torch.bfloat16, device_map="auto", attn_implementation="sdpa"
                )
            else:
                from transformers import AutoModelForCausalLM

                model = AutoModelForCausalLM.from_pretrained(
                    VLM_PATH, torch_dtype=torch.bfloat16, device_map="auto", trust_remote_code=True
                )
            print(f"[stage1] loaded VLM via {loader}")
            break
        except Exception as exc:  # noqa: BLE001 — try the next loader
            errors.append(f"{loader}: {exc}")
    if model is None:
        raise RuntimeError("could not load the VLM:\n" + "\n".join(errors))

    processor = AutoProcessor.from_pretrained(VLM_PATH, trust_remote_code=True)
    if getattr(processor, "tokenizer", None) is not None:
        processor.tokenizer.padding_side = "left"
    try:
        from qwen_vl_utils import process_vision_info
    except Exception:  # noqa: BLE001
        process_vision_info = None

    def _clean(raw: str) -> str:
        line = " ".join(raw.strip().splitlines()).strip().strip('"')
        line = ", ".join(t.strip() for t in line.split(",") if t.strip())
        if not line.lower().startswith(trigger.lower()):
            line = f"{trigger}, {line}"
        return line

    batch_size = int(os.environ.get("CAPTION_BATCH", "8"))
    for start in range(0, len(todo), batch_size):
        idx_chunk = todo[start : start + batch_size]
        texts, images = [], []
        for i in idx_chunk:
            img_path = image_paths[i]
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "image": f"file://{img_path}"},
                        {"type": "text", "text": instruction},
                    ],
                }
            ]
            texts.append(processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True))
            if process_vision_info is not None:
                got, _ = process_vision_info(messages)
                images.append(got[0] if got else Image.open(img_path).convert("RGB"))
            else:
                images.append(Image.open(img_path).convert("RGB"))

        inputs = processor(text=texts, images=images, padding=True, return_tensors="pt").to(model.device)
        with torch.inference_mode():
            generated = model.generate(**inputs, max_new_tokens=200, do_sample=False)
        trimmed = generated[:, inputs["input_ids"].shape[1] :]
        decoded = processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)
        for i, raw in zip(idx_chunk, decoded):
            filled[i] = _clean(raw)
            print(f"[stage1] {image_paths[i].name}: {filled[i][:120]}")

    del model
    torch.cuda.empty_cache()
    return filled[: len(image_paths)]


# ---------------------------------------------------------------------------
# Stage 2 — ai-toolkit config + run
# ---------------------------------------------------------------------------
def _build_config(
    lora_name: str, trigger: str, target_model: str, tc: dict, override
) -> pathlib.Path:
    """Manual override (raw YAML string or a dict) wins outright; otherwise
    a standard job YAML is assembled from `tc` + the target model registry."""
    import yaml

    config_path = pathlib.Path(AI_TOOLKIT_DIR) / f"config_{lora_name}.yaml"

    if override:
        if isinstance(override, str):
            config_path.write_text(override, encoding="utf-8")
        else:
            config_path.write_text(yaml.safe_dump(override, sort_keys=False), encoding="utf-8")
        print(f"[stage2] using caller-supplied custom_yaml_override -> {config_path}")
        return config_path

    target = TARGET_MODELS.get(target_model)
    if not target:
        raise ValueError(
            f"unknown target_model {target_model!r} and no custom_yaml_override — "
            f"known: {', '.join(TARGET_MODELS)}"
        )

    rank = int(tc.get("rank", DEFAULT_TRAINING_CONFIG["rank"]))
    alpha = int(tc.get("alpha", DEFAULT_TRAINING_CONFIG["alpha"]))
    lr = float(tc.get("learning_rate", DEFAULT_TRAINING_CONFIG["learning_rate"]))
    steps = int(tc.get("steps", DEFAULT_TRAINING_CONFIG["steps"]))
    optimizer = str(tc.get("optimizer", DEFAULT_TRAINING_CONFIG["optimizer"]))
    save_every = max(100, steps // 4)

    model_block = {"name_or_path": target["unet"], "arch": target["arch"], "quantize": False}
    if target.get("text_encoder"):
        model_block["text_encoder_path"] = target["text_encoder"]
    if target.get("vae"):
        model_block["vae_path"] = target["vae"]

    config = {
        "job": "extension",
        "config": {
            "name": lora_name,
            "process": [
                {
                    "type": "sd_trainer",
                    "training_folder": OUTPUT_DIR,
                    "device": "cuda:0",
                    "trigger_word": trigger,
                    "network": {"type": "lora", "linear": rank, "linear_alpha": alpha},
                    "save": {
                        "dtype": "bf16",
                        "save_every": save_every,
                        "max_step_saves_to_keep": 6,
                        "push_to_hub": False,
                    },
                    "datasets": [
                        {
                            "folder_path": DATASET_DIR,
                            "caption_ext": "txt",
                            "caption_dropout_rate": 0.05,
                            "shuffle_tokens": False,
                            "cache_latents_to_disk": True,
                            "resolution": [512, 768, 1024],
                        }
                    ],
                    "train": {
                        "batch_size": 1,
                        "steps": steps,
                        "gradient_accumulation_steps": 1,
                        "train_unet": True,
                        "train_text_encoder": False,
                        "gradient_checkpointing": True,
                        "noise_scheduler": "flowmatch",
                        "optimizer": optimizer,
                        "lr": lr,
                        "dtype": "bf16",
                    },
                    "model": model_block,
                    "sample": {
                        "sampler": "flowmatch",
                        "sample_every": save_every,
                        "width": 768,
                        "height": 768,
                        "prompts": [f"{trigger}, full-body standing view, studio lighting"],
                        "neg": "",
                        "seed": 42,
                        "walk_seed": True,
                        "guidance_scale": 4.0,
                        "sample_steps": 20,
                    },
                }
            ],
        },
        "meta": {"name": lora_name, "version": "1.0"},
    }
    config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    print(f"[stage2] wrote ai-toolkit config -> {config_path} ({steps} steps, rank {rank}/{alpha})")
    return config_path


_STEP_RE = re.compile(r"(\d+)\s*/\s*(\d+)")


def _run_ai_toolkit_with_progress(config_path: pathlib.Path, job_id: str, total_steps: int) -> None:
    """Runs `python run.py <config>` and, on a side thread, tails its output
    for a `<step>/<total>` marker and PATCHes generation_jobs.progress_percent
    / progress_message (with an ETA) every ~15s."""
    log_path = pathlib.Path("/root/ai_toolkit_run.log")
    stop = threading.Event()

    def _monitor():
        started = time.time()
        while not stop.wait(15):
            try:
                text = log_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            matches = _STEP_RE.findall(text)
            step = 0
            for a, b in reversed(matches):
                if int(b) == total_steps:
                    step = int(a)
                    break
            if step <= 0:
                continue
            elapsed = time.time() - started
            per_step = elapsed / step
            remaining = max(0, total_steps - step)
            eta_min = round(per_step * remaining / 60, 1)
            pct = min(99, int(step / total_steps * 100))
            _patch_job(
                job_id,
                {
                    "progress_percent": pct,
                    "progress_message": f"training {step}/{total_steps} steps ・ ETA ~{eta_min} min",
                },
            )

    mon = threading.Thread(target=_monitor, daemon=True)
    mon.start()
    try:
        with open(log_path, "w", encoding="utf-8") as log_file:
            proc = subprocess.run(
                ["python", "run.py", str(config_path)],
                cwd=AI_TOOLKIT_DIR,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                check=False,
            )
    finally:
        stop.set()
        mon.join(timeout=2)

    if proc.returncode != 0:
        tail = ""
        try:
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-3000:]
        except OSError:
            pass
        raise RuntimeError(f"ai-toolkit run.py exited {proc.returncode}. Tail:\n{tail}")


def _collect_final_lora(lora_name: str) -> pathlib.Path:
    job_dir = pathlib.Path(OUTPUT_DIR) / lora_name
    candidates = sorted(job_dir.glob("**/*.safetensors"), key=lambda p: p.stat().st_mtime)
    if not candidates:
        raise RuntimeError(f"no .safetensors produced under {job_dir}")
    return candidates[-1]


def _derive_trigger(params: dict, lora_name: str) -> str:
    supplied = str(params.get("trigger_word") or "").strip()
    if supplied:
        return supplied
    # first alnum run of the lora name, e.g. "yukipas_h3_v2" -> "yukipas"
    m = re.match(r"[A-Za-z0-9]+", lora_name)
    return m.group(0) if m else lora_name


# ---------------------------------------------------------------------------
# The spawnable training job
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    gpu=GPU_REQUEST,
    volumes={MODELS_DIR: vol},
    timeout=3 * 60 * 60,
    secrets=[modal.Secret.from_name("supabase-model-downloads"), modal.Secret.from_name("wan-animate-auth")],
)
def train_lora_job(params: dict) -> dict:
    """Generic LoRA training entrypoint — see module docstring for how the
    three LoRA Studio modes map onto `params`.

    params:
      images:            [{filename?, data(b64)} | {path: <volume path>}]
      captions:          [str, ...]  (blanks / short list -> Qwen fills them)
      target_model:      "minimax_h3" | "flux_dev" | "wan2_1"
      training_config:   {rank, alpha, learning_rate, steps, optimizer,
                          custom_yaml_override?}
      output_lora_name:  str
      job_id:            str   (generation_jobs row to PATCH progress into)
      user_id:           str   (for the failure refund)
      credits_cost:      int
      trigger_word:      str   (optional; derived from output_lora_name)
    """
    job_id = str(params.get("job_id") or "")
    user_id = str(params.get("user_id") or "")
    credits_cost = int(params.get("credits_cost") or 0)
    lora_name = str(params.get("output_lora_name") or "").strip()
    target_model = str(params.get("target_model") or "minimax_h3")
    tc = dict(params.get("training_config") or {})
    override = tc.get("custom_yaml_override")

    if not lora_name or not re.match(r"^[A-Za-z0-9._-]+$", lora_name):
        raise ValueError(f"invalid output_lora_name: {lora_name!r}")

    trigger = _derive_trigger(params, lora_name)
    started = time.time()

    try:
        _patch_job(job_id, {"status": "processing", "started_at": _now_iso(), "progress_percent": 1,
                            "progress_message": "preparing dataset"})

        # --- materialise the dataset -------------------------------------
        dataset = pathlib.Path(DATASET_DIR)
        if dataset.exists():
            shutil.rmtree(dataset)
        dataset.mkdir(parents=True)

        image_paths: list[pathlib.Path] = []
        for i, item in enumerate(params.get("images") or []):
            if isinstance(item, str):
                item = {"path": item}
            if item.get("path"):
                src = pathlib.Path(item["path"])
                if not src.is_absolute():
                    src = pathlib.Path(MODELS_DIR) / item["path"]
                if not src.exists():
                    raise FileNotFoundError(f"image path not on Volume: {src}")
                dest = dataset / src.name
                shutil.copy2(src, dest)
            else:
                name = os.path.basename(item.get("filename") or f"img_{i:04d}.png")
                dest = dataset / name
                dest.write_bytes(base64.b64decode(item["data"]))
            image_paths.append(dest)
        image_paths.sort()
        if not image_paths:
            raise ValueError("no images supplied")
        print(f"[train] staged {len(image_paths)} images for '{lora_name}' (target={target_model})")

        # --- Stage 1: captions ----------------------------------------------
        _patch_job(job_id, {"progress_percent": 3, "progress_message": "captioning dataset"})
        captions = _caption_missing(image_paths, list(params.get("captions") or []), trigger)
        for path, cap in zip(image_paths, captions):
            path.with_suffix(".txt").write_text(cap, encoding="utf-8")
        print(f"[train] stage 1 done in {time.time() - started:.0f}s")

        # --- Stage 2: ai-toolkit -----------------------------------------
        pathlib.Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)
        config_path = _build_config(lora_name, trigger, target_model, tc, override)
        total_steps = int(tc.get("steps", DEFAULT_TRAINING_CONFIG["steps"])) if not override else 0
        _patch_job(job_id, {"progress_percent": 5, "progress_message": "starting training"})
        stage2 = time.time()
        _run_ai_toolkit_with_progress(config_path, job_id, total_steps or 2000)
        print(f"[train] stage 2 done in {time.time() - stage2:.0f}s")

        # --- publish ---------------------------------------------------------
        final_lora = _collect_final_lora(lora_name)
        os.makedirs(LORA_OUTPUT_DIR, exist_ok=True)
        dest_path = pathlib.Path(LORA_OUTPUT_DIR) / f"{lora_name}.safetensors"
        shutil.copy2(final_lora, dest_path)
        vol.commit()
        size_mb = dest_path.stat().st_size / 1024**2
        print(f"[train] committed LoRA -> {dest_path} ({size_mb:.1f} MB)")

        _patch_job(
            job_id,
            {
                "status": "completed",
                "progress_percent": 100,
                "progress_message": "done",
                "result_path": str(dest_path),
                "video_url": str(dest_path),
                "completed_at": _now_iso(),
            },
        )
        return {
            "lora_path": str(dest_path),
            "lora_filename": dest_path.name,
            "size_bytes": dest_path.stat().st_size,
            "num_images": len(image_paths),
            "target_model": target_model,
            "trigger_word": trigger,
            "total_seconds": round(time.time() - started, 1),
            "sample_captions": captions[:5],
        }
    except Exception as exc:  # report + refund, then re-raise
        print(f"[train] FAILED: {exc}")
        _patch_job(
            job_id,
            {"status": "failed", "error_message": str(exc)[:2000], "completed_at": _now_iso()},
        )
        _refund_credits(user_id, credits_cost)
        raise


# ---------------------------------------------------------------------------
# GPU-less dispatcher endpoint — the Next.js /api/studio/lora/train route
# POSTs here; the whole body is an auth check + a .spawn() so it returns in
# well under a second regardless of GPU availability.
# ---------------------------------------------------------------------------
@app.function(image=image, timeout=30, secrets=[modal.Secret.from_name("wan-animate-auth")])
@modal.fastapi_endpoint(method="POST")
def train_lora_dispatch(item: dict, request: fastapi.Request):
    _authorize(request)
    if not item.get("output_lora_name"):
        raise fastapi.HTTPException(status_code=400, detail="output_lora_name is required")
    call = train_lora_job.spawn(item)
    return {"ok": True, "spawned": True, "modal_call_id": call.object_id, "job_id": item.get("job_id")}


# ---------------------------------------------------------------------------
# Local one-shot CLI
# ---------------------------------------------------------------------------
@app.local_entrypoint()
def main(
    data_dir: str,
    lora_name: str,
    target_model: str = "minimax_h3",
    trigger_word: str = "",
    steps: int = 2000,
    rank: int = 32,
    alpha: int = 32,
    learning_rate: float = 1e-4,
    optimizer: str = "adamw8bit",
):
    """modal run modal_lora_worker.py --data-dir <dir> --lora-name <name>"""
    src = pathlib.Path(data_dir).expanduser()
    if not src.is_dir():
        raise SystemExit(f"--data-dir is not a directory: {src}")

    images, total = [], 0
    for path in sorted(src.iterdir()):
        if path.suffix.lower() not in IMAGE_EXTS or not path.is_file():
            continue
        raw = path.read_bytes()
        total += len(raw)
        images.append({"filename": path.name, "data": base64.b64encode(raw).decode("ascii")})
    if not images:
        raise SystemExit(f"no images in {src}")
    if total > 1_500_000_000:
        raise SystemExit(f"dataset is {total / 1024**2:.0f} MB — downscale it first")

    gpu_label = GPU_REQUEST if isinstance(GPU_REQUEST, str) else " -> ".join(GPU_REQUEST)
    print(f"[main] {len(images)} images ({total / 1024**2:.1f} MB) -> Modal ({gpu_label}), target={target_model}")

    result = train_lora_job.remote(
        {
            "images": images,
            "captions": [],
            "target_model": target_model,
            "training_config": {
                "rank": rank,
                "alpha": alpha,
                "learning_rate": learning_rate,
                "steps": steps,
                "optimizer": optimizer,
            },
            "output_lora_name": lora_name,
            "trigger_word": trigger_word,
            "job_id": "",
            "user_id": "",
            "credits_cost": 0,
        }
    )
    print(f"\n[main] ✅ {result['lora_path']} ({result['size_bytes'] / 1024**2:.1f} MB)")
    print(f"[main] {result['num_images']} images, {result['total_seconds']}s, trigger={result['trigger_word']}")
    for cap in result["sample_captions"]:
        print(f"       - {cap}")
