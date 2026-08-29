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
  LORA_WORKER_GPU   pin a single GPU tier (default: H100, no fallback)
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
# Captioned datasets are persisted here on the Volume, keyed by dataset_id,
# so a re-run of the same set skips the VLM pass entirely (0s).
PERSIST_ROOT = f"{MODELS_DIR}/datasets"
AI_TOOLKIT_DIR = "/root/ai-toolkit"
SHIM_DIR = "/root/aitk_shims"

# Auto-imported by CPython's `site` at interpreter startup (including the
# `python run.py` subprocess), because SHIM_DIR is on PYTHONPATH. Makes
# torch.library.custom_op / register_fake non-fatal: ai-toolkit's
# toolkit/util/convrot_quant.py registers an NVFP4 quant op at import time
# and that can throw on some torch builds — BF16 LoRA training never needs
# it, so a failed registration must not crash the whole process.
_USERCUSTOMIZE = '''\
try:
    import torch, torch.library as _tl

    def _wrap(orig):
        def _outer(*a, **k):
            try:
                dec = orig(*a, **k)
            except Exception as e:
                print("[aitk-shim] torch.library." + orig.__name__ + " skipped: " + repr(e))
                return lambda fn: fn
            def _inner(fn):
                try:
                    return dec(fn)
                except Exception as e:
                    print("[aitk-shim] " + orig.__name__ + " decoration skipped: " + repr(e))
                    return fn
            return _inner
        return _outer

    for _name in ("custom_op", "register_fake", "register_kernel", "impl", "register_autograd"):
        _fn = getattr(_tl, _name, None)
        if callable(_fn):
            setattr(_tl, _name, _wrap(_fn))
except Exception as _e:
    print("[aitk-shim] torch.library patch skipped: " + repr(_e))
'''

# sitecustomize is imported by `site` even earlier than usercustomize, before
# ai-toolkit's `import torchao` on config_modules.py line 11. If torchao is
# missing or its quant_primitives can't load (register_fake incompatibility
# with torch 2.5.1), swap in a MagicMock so BF16 training keeps going.
_SITECUSTOMIZE = '''\
try:
    import sys
    import torch
    try:
        import torchao  # noqa: F401
        import torchao.quantization.quant_primitives  # noqa: F401
    except Exception as _ao_exc:
        print("[aitk-shim] torchao unavailable, installing MagicMock stub: " + repr(_ao_exc))
        from unittest.mock import MagicMock
        mock_ao = MagicMock()
        mock_ao.quantization.quant_primitives._DTYPE_TO_BIT_WIDTH = {
            torch.float32: 32, torch.float16: 16, torch.bfloat16: 16,
            torch.int8: 8, torch.uint8: 8, torch.int16: 16,
            torch.int32: 32, torch.int64: 64,
        }
        sys.modules["torchao"] = mock_ao
        sys.modules["torchao.quantization"] = mock_ao.quantization
        sys.modules["torchao.quantization.quant_primitives"] = mock_ao.quantization.quant_primitives
except Exception as _e:
    print("[aitk-shim] sitecustomize torchao stub skipped: " + repr(_e))
'''

VLM_PATH = f"{MODELS_DIR}/LLM/Qwen3.8-27B-abliterated"
LORA_OUTPUT_DIR = f"{MODELS_DIR}/loras"

# Fixed to a single high-end GPU — NO cross-tier fallback. High-bandwidth /
# large-VRAM is a hard requirement (27B VLM captioning + full-precision
# training), so a job that can't get an H100 within the pending window is
# retried on the SAME spec and, failing that, cancelled + fully refunded
# rather than downgraded. `LORA_WORKER_GPU` may pin a different single tier.
GPU_REQUEST = os.environ.get("LORA_WORKER_GPU", "").strip() or "H100"
AI_TOOLKIT_REF = os.environ.get("AI_TOOLKIT_REF", "main")

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

# Preset target_model -> ai-toolkit arch + a name_or_path (a single-file
# checkpoint on the Volume when we host it, otherwise a HuggingFace repo id
# ai-toolkit resolves at load time). Anything not listed here can still be
# trained via target_model="custom" + custom_model_id + base_architecture,
# or via training_config.custom_yaml_override. Mirrors src/lib/loraModels.ts.
TARGET_MODELS: dict[str, dict] = {
    # --- video ---
    "minimax_h3": {
        "arch": "minimax_h3",
        "unet": f"{MODELS_DIR}/diffusion_models/minimax_h3_fl2va_bf16.safetensors",
        "text_encoder": f"{MODELS_DIR}/clip/qwen3vl_32b_minimax_h3_bf16.safetensors",
        "vae": f"{MODELS_DIR}/vae/minimax_h3_video_vae_fp16.safetensors",
    },
    "wan2_1_14b": {
        "arch": "wan21",
        "unet": f"{MODELS_DIR}/diffusion_models/wan2.1_t2v_14b_bf16.safetensors",
        "text_encoder": f"{MODELS_DIR}/text_encoders/umt5_xxl_fp16.safetensors",
        "vae": f"{MODELS_DIR}/vae/wan_2.1_vae.safetensors",
    },
    "wan2_1_1_3b": {"arch": "wan21", "unet": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers"},
    "hunyuan_video": {"arch": "hunyuan", "unet": "hunyuanvideo-community/HunyuanVideo"},
    "cogvideox_5b": {"arch": "cogvideox", "unet": "THUDM/CogVideoX-5b"},
    "ltx_video": {"arch": "cogvideox", "unet": "Lightricks/LTX-Video"},
    # --- photo / general ---
    "flux_schnell": {
        "arch": "flux",
        "unet": f"{MODELS_DIR}/diffusion_models/flux1-schnell.safetensors",
        "vae": f"{MODELS_DIR}/vae/ae.safetensors",
    },
    "sdxl_10": {"arch": "sdxl", "unet": "stabilityai/stable-diffusion-xl-base-1.0"},
    "sd35_large": {"arch": "sd3", "unet": "stabilityai/stable-diffusion-3.5-large"},
    "sd35_medium": {"arch": "sd3", "unet": "stabilityai/stable-diffusion-3.5-medium"},
    "pixart_sigma": {"arch": "sdxl", "unet": "PixArt-alpha/PixArt-Sigma-XL-2-1024-MS"},
    # --- anime / illustration ---
    "pony_v6_xl": {"arch": "sdxl", "unet": "LyliaEngine/Pony_Diffusion_V6_XL"},
    "illustrious_xl": {"arch": "sdxl", "unet": "OnomaAIResearch/Illustrious-xl-early-release-v0"},
    "animagine_xl_31": {"arch": "sdxl", "unet": "cagliostrolab/animagine-xl-3.1"},
    "sd15": {"arch": "sd15", "unet": "stable-diffusion-v1-5/stable-diffusion-v1-5"},
}

# FLUX.1 [dev] is blocked outright (non-commercial licence). Matches
# "flux dev", "flux-dev", "FLUX.1-dev", "black-forest-labs/FLUX.1-dev", ...
_FLUX_DEV_RE = re.compile(r"flux[\s._-]*(?:1[\s._-]*)?dev\b", re.IGNORECASE)


def _is_blocked_model(value: str) -> bool:
    return bool(value) and (_FLUX_DEV_RE.search(value) is not None or value.strip().lower() == "flux_dev")

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

# Build-time patch: wrap the eager FP4/NVFP4 quant modules' bodies in a
# try/except so ANY import-time failure (torch.library.custom_op /
# torchao _make_prim register_fake AttributeError / a missing torchao) is
# swallowed and replaced with no-op placeholders. BF16 LoRA training never
# touches these. base64'd to keep it out of shell-quoting range.
_QUANT_PATCH = '''\
import pathlib, sys

root = pathlib.Path(sys.argv[1])
FILES = (
    "toolkit/util/comfy_quant_import.py",
    "toolkit/util/convrot_quant.py",
    "toolkit/util/nvfp4_quant.py",
)
FALLBACK = (
    "except Exception as _quant_exc:\\n"
    "    import warnings as _w\\n"
    "    _w.warn('ai-toolkit quant module disabled: ' + repr(_quant_exc))\\n"
    "    def _quant_noop(*_a, **_k):\\n"
    "        return None\\n"
    "    def import_comfy_quantized_layers(*_a, **_k):\\n"
    "        return None\\n"
    "    def __getattr__(_name):\\n"
    "        return _quant_noop\\n"
)
for rel in FILES:
    p = root / rel
    if not p.is_file():
        print("[image] quant patch: not present:", rel)
        continue
    src = p.read_text()
    if src.lstrip().startswith("try:"):
        print("[image] quant patch: already wrapped:", rel)
        continue
    body = "".join(("    " + ln) if ln.strip() else ln for ln in src.splitlines(keepends=True))
    p.write_text("try:\\n" + body + "\\n" + FALLBACK)
    print("[image] quant patch: wrapped", rel)
'''

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "git", "ffmpeg", "libgl1-mesa-glx", "libglib2.0-0", "wget",
        # A real C/C++ + ninja toolchain for any JIT/quant kernel build path.
        "build-essential", "ninja-build",
    )
    .pip_install(
        # The CUDA-12.4 torch trio, pinned and installed together so nothing
        # downstream can drag in a mismatched build. torchaudio is required —
        # ai-toolkit imports it unconditionally at startup.
        "torch==2.5.1",
        "torchvision==0.20.1",
        "torchaudio==2.5.1",
        "triton==3.1.0",
        extra_index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install("ninja")
    .pip_install(
        "transformers>=4.49.0",
        "accelerate>=1.2.0",
        "qwen-vl-utils",
        "Pillow",
        "sentencepiece",
        "einops",
        "safetensors",
        "requests",
        "scipy",
        "ftfy",
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
    # torchao is a hard import in ai-toolkit (toolkit/config_modules.py). Pin
    # the torch-2.5-era release and skip its deps so it can't pull a
    # different torch. If it still can't import at runtime, the sitecustomize
    # MagicMock stub below takes over.
    .run_commands(
        "pip install --no-deps torchao==0.7.0",
    )
    .run_commands(
        f"git clone https://github.com/ostris/ai-toolkit.git {AI_TOOLKIT_DIR}",
        f"cd {AI_TOOLKIT_DIR} && git checkout {AI_TOOLKIT_REF} && git submodule update --init --recursive",
        f"cd {AI_TOOLKIT_DIR} && pip install -r requirements.txt || echo 'ai-toolkit requirements.txt partial install, continuing'",
        # re-assert torch + torchao pins in case ai-toolkit's requirements
        # bumped one (all --no-deps so none can drag the others).
        "pip install --no-deps torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 "
        "--extra-index-url https://download.pytorch.org/whl/cu124",
        "pip install --no-deps torchao==0.7.0",
        # site/user-customize shims, auto-imported by `site` in the `python
        # run.py` subprocess because SHIM_DIR is on PYTHONPATH:
        #   sitecustomize.py — MagicMock torchao fallback (runs first)
        #   usercustomize.py — torch.library.custom_op / register_fake no-op
        f"mkdir -p {SHIM_DIR}",
        "python -c \"import base64,pathlib; "
        f"pathlib.Path('{SHIM_DIR}/sitecustomize.py')"
        f".write_bytes(base64.b64decode('{base64.b64encode(_SITECUSTOMIZE.encode()).decode()}'))\"",
        "python -c \"import base64,pathlib; "
        f"pathlib.Path('{SHIM_DIR}/usercustomize.py')"
        f".write_bytes(base64.b64decode('{base64.b64encode(_USERCUSTOMIZE.encode()).decode()}'))\"",
        # belt-and-suspenders: also wrap the quant module bodies in try/except.
        "python -c \"import base64,pathlib; "
        f"pathlib.Path('/tmp/_quant_patch.py')"
        f".write_bytes(base64.b64decode('{base64.b64encode(_QUANT_PATCH.encode()).decode()}'))\"",
        f"python /tmp/_quant_patch.py {AI_TOOLKIT_DIR}",
        # verify the stub chain resolves torchao.quantization.quant_primitives
        f"PYTHONPATH={SHIM_DIR} python -c \""
        "import torchao.quantization.quant_primitives as q; "
        "print('[image] torchao.quantization.quant_primitives OK, _DTYPE_TO_BIT_WIDTH:', "
        "hasattr(q, '_DTYPE_TO_BIT_WIDTH'))\"",
    )
    .env(
        {
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            "PYTHONUNBUFFERED": "1",
            "PYTHONPATH": SHIM_DIR,
        }
    )
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


def _download_storage_object(bucket: str, key: str) -> bytes:
    """Fetches one object out of a (private) Supabase Storage bucket with the
    service-role key — bypasses Storage RLS."""
    import requests

    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured")
    if ".." in key:
        raise ValueError(f"illegal storage key: {key!r}")
    res = requests.get(
        f"{supabase_url}/storage/v1/object/{bucket}/{key.lstrip('/')}",
        headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
        timeout=60,
    )
    if res.status_code != 200:
        raise RuntimeError(f"storage download failed ({res.status_code}) for {bucket}/{key}: {res.text[:300]}")
    return res.content


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

    # Physically cut HuggingFace Hub network access — the checkpoint lives on
    # the Volume, and any from_pretrained() Hub round-trip (metadata refresh,
    # revision check) is what was hanging Stage 1 for 5+ minutes.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    import torch
    from PIL import Image
    from transformers import AutoProcessor

    instruction = CAPTION_INSTRUCTION.format(trigger=trigger)
    print(f"[stage1] captioning {len(todo)}/{len(image_paths)} images with the VLM at {VLM_PATH}", flush=True)

    # Single-GPU direct load — device_map="auto" runs a memory-profiling pass
    # that stalls badly when weights are streamed off a network volume.
    _device = "cuda" if torch.cuda.is_available() else "cpu"

    model = None
    errors = []
    for loader in ("image-text-to-text", "qwen2_5_vl", "auto"):
        try:
            print(f"[Qwen Load] Starting model load via {loader}...", flush=True)
            _t0 = time.time()
            if loader == "image-text-to-text":
                from transformers import AutoModelForImageTextToText

                model = AutoModelForImageTextToText.from_pretrained(
                    VLM_PATH,
                    torch_dtype=torch.bfloat16,
                    device_map=_device,
                    attn_implementation="sdpa",
                    local_files_only=True,
                )
            elif loader == "qwen2_5_vl":
                from transformers import Qwen2_5_VLForConditionalGeneration

                model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
                    VLM_PATH,
                    torch_dtype=torch.bfloat16,
                    device_map=_device,
                    attn_implementation="sdpa",
                    local_files_only=True,
                )
            else:
                from transformers import AutoModelForCausalLM

                model = AutoModelForCausalLM.from_pretrained(
                    VLM_PATH,
                    torch_dtype=torch.bfloat16,
                    device_map=_device,
                    trust_remote_code=True,
                    local_files_only=True,
                )
            print(f"[Qwen Load] Model loaded successfully in {time.time() - _t0:.1f} seconds (via {loader})", flush=True)
            break
        except Exception as exc:  # noqa: BLE001 — try the next loader
            print(f"[Qwen Load] {loader} failed after {time.time() - _t0:.1f}s: {exc}", flush=True)
            errors.append(f"{loader}: {exc}")
    if model is None:
        raise RuntimeError("could not load the VLM:\n" + "\n".join(errors))

    print("[Qwen Load] Starting processor/tokenizer load...", flush=True)
    _tp = time.time()
    processor = AutoProcessor.from_pretrained(VLM_PATH, trust_remote_code=True, local_files_only=True)
    if getattr(processor, "tokenizer", None) is not None:
        processor.tokenizer.padding_side = "left"
    print(f"[Qwen Load] Processor loaded in {time.time() - _tp:.1f} seconds", flush=True)

    # Offline mode was only needed for the Qwen load — clear it so Stage 2
    # (ai-toolkit) can still resolve HF-hosted preset checkpoints.
    os.environ.pop("HF_HUB_OFFLINE", None)
    os.environ.pop("TRANSFORMERS_OFFLINE", None)
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
    lora_name: str,
    trigger: str,
    target_model: str,
    tc: dict,
    override,
    custom_model_id: str = "",
    base_architecture: str = "",
    resolution: int = 768,
) -> pathlib.Path:
    """Manual override (raw YAML string or a dict) wins outright; otherwise
    a standard job YAML is assembled from `tc` + either the preset registry
    or, for target_model=="custom", the caller's model id + architecture
    (universal loader — any HF repo id or Volume path)."""
    import yaml

    config_path = pathlib.Path(AI_TOOLKIT_DIR) / f"config_{lora_name}.yaml"

    if override:
        if isinstance(override, str):
            config_path.write_text(override, encoding="utf-8")
        else:
            config_path.write_text(yaml.safe_dump(override, sort_keys=False), encoding="utf-8")
        print(f"[stage2] using caller-supplied custom_yaml_override -> {config_path}")
        return config_path

    if target_model == "custom":
        if not custom_model_id or not base_architecture:
            raise ValueError("target_model='custom' requires custom_model_id and base_architecture")
        if _is_blocked_model(custom_model_id):
            raise ValueError("FLUX.1 [dev] is blocked (non-commercial licence)")
        path = custom_model_id
        # A bare filename resolves against the Volume; an "owner/name" HF repo
        # id, an absolute path, or a URL is passed through untouched.
        if "/" not in path and not path.startswith("http"):
            path = f"{MODELS_DIR}/{path}"
        target = {"arch": base_architecture, "unet": path}
        print(f"[stage2] universal loader: arch={base_architecture} model={path}")
    else:
        if _is_blocked_model(target_model):
            raise ValueError("FLUX.1 [dev] is blocked (non-commercial licence)")
        target = TARGET_MODELS.get(target_model)
        if not target:
            raise ValueError(
                f"unknown target_model {target_model!r} and no custom_yaml_override — "
                f"known: {', '.join(TARGET_MODELS)}, or use target_model='custom'"
            )

    rank = int(tc.get("rank", DEFAULT_TRAINING_CONFIG["rank"]))
    alpha = int(tc.get("alpha", DEFAULT_TRAINING_CONFIG["alpha"]))
    lr = float(tc.get("learning_rate", DEFAULT_TRAINING_CONFIG["learning_rate"]))
    steps = int(tc.get("steps", DEFAULT_TRAINING_CONFIG["steps"]))
    optimizer = str(tc.get("optimizer", DEFAULT_TRAINING_CONFIG["optimizer"]))
    save_every = max(100, steps // 4)
    res = resolution if resolution in (512, 768, 1024) else 768

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
                            "resolution": [res],
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
                        "width": res,
                        "height": res,
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
    print(f"[stage2] wrote ai-toolkit config -> {config_path} ({steps} steps, rank {rank}/{alpha}, {res}px)")
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
    # Explicitly online for the trainer — it may pull HF-hosted preset
    # checkpoints even if the caption step flipped the process offline.
    child_env = {k: v for k, v in os.environ.items() if k not in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")}
    try:
        with open(log_path, "w", encoding="utf-8") as log_file:
            proc = subprocess.run(
                ["python", "run.py", str(config_path)],
                cwd=AI_TOOLKIT_DIR,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                check=False,
                env=child_env,
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


def _derive_dataset_id(params: dict) -> str:
    """dataset_id keys the persisted-caption cache on the Volume. Prefer the
    caller's value; otherwise take the 2nd segment of the first storage key
    ("<user_id>/<dataset_id>/<file>"). Sanitised to a safe path segment."""
    raw = str(params.get("dataset_id") or "").strip()
    if not raw:
        for key in params.get("storage_paths") or []:
            parts = str(key).strip("/").split("/")
            if len(parts) >= 2:
                raw = parts[1]
                break
    raw = re.sub(r"[^A-Za-z0-9._-]", "", raw)
    return raw[:64]


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
    custom_model_id = str(params.get("custom_model_id") or "").strip()
    base_architecture = str(params.get("base_architecture") or "").strip()
    resolution = int(params.get("resolution") or 768)
    tc = dict(params.get("training_config") or {})
    override = tc.get("custom_yaml_override")

    if _is_blocked_model(target_model) or _is_blocked_model(custom_model_id):
        raise ValueError("FLUX.1 [dev] is blocked in LoRA Studio (non-commercial licence)")

    if not lora_name or not re.match(r"^[A-Za-z0-9._-]+$", lora_name):
        raise ValueError(f"invalid output_lora_name: {lora_name!r}")

    trigger = _derive_trigger(params, lora_name)
    dataset_id = _derive_dataset_id(params)
    persist_dir = pathlib.Path(PERSIST_ROOT) / dataset_id if dataset_id else None
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
        storage_paths = params.get("storage_paths") or []
        if storage_paths:
            # Primary path: the browser uploaded the images to Supabase
            # Storage and only their object keys were forwarded here, so the
            # Next.js request never hit Vercel's 4.5 MB body cap. Pull them
            # back with the service-role key (bypasses Storage RLS).
            bucket = str(params.get("storage_bucket") or "lora_datasets")
            for i, key in enumerate(storage_paths):
                data = _download_storage_object(bucket, str(key))
                ext = os.path.splitext(str(key))[1] or ".png"
                dest = dataset / f"{i:04d}{ext}"
                dest.write_bytes(data)
                image_paths.append(dest)
        else:
            for i, item in enumerate(params.get("images") or []):
                if isinstance(item, str):
                    item = {"path": item}
                if item.get("path"):
                    src = pathlib.Path(item["path"])
                    if not src.is_absolute():
                        src = pathlib.Path(MODELS_DIR) / item["path"]
                    if not src.exists():
                        raise FileNotFoundError(f"image path not on Volume: {src}")
                    dest = dataset / f"{i:04d}_{src.name}"
                    shutil.copy2(src, dest)
                else:
                    name = os.path.basename(item.get("filename") or "img.png")
                    dest = dataset / f"{i:04d}_{name}"
                    dest.write_bytes(base64.b64decode(item["data"]))
                image_paths.append(dest)
        image_paths.sort()  # the 4-digit prefix keeps this in caption order
        if not image_paths:
            raise ValueError("no images supplied")
        print(f"[train] staged {len(image_paths)} images for '{lora_name}' (target={target_model})")

        # --- Stage 1: captions ----------------------------------------------
        # 1) caller-supplied captions -> <image>.txt.
        # 2) if this dataset_id was captioned before, restore the persisted
        #    .txt from the Volume (/models/datasets/<id>/) by index.
        # 3) if every image now has a non-empty .txt, skip the Qwen pass (0s)
        #    and go straight to training.
        supplied = list(params.get("captions") or [])
        for idx, path in enumerate(image_paths):
            cap = (supplied[idx] if idx < len(supplied) else "") or ""
            if cap.strip():
                path.with_suffix(".txt").write_text(cap.strip(), encoding="utf-8")

        def _has_caption(p: pathlib.Path) -> bool:
            txt = p.with_suffix(".txt")
            try:
                return txt.is_file() and txt.read_text(encoding="utf-8").strip() != ""
            except OSError:
                return False

        reused_from_volume = False
        if persist_dir and persist_dir.is_dir():
            cached = [persist_dir / f"{i:04d}.txt" for i in range(len(image_paths))]
            if all(c.is_file() and c.read_text(encoding="utf-8").strip() for c in cached):
                for i, p in enumerate(image_paths):
                    p.with_suffix(".txt").write_text(
                        cached[i].read_text(encoding="utf-8").strip(), encoding="utf-8"
                    )
                reused_from_volume = True
                print(f"[train] reused {len(cached)} persisted captions from {persist_dir} — Stage 1 skipped (0s)")

        if all(_has_caption(p) for p in image_paths):
            msg = "captions restored from cache (0s)" if reused_from_volume else "captions ready (skipped auto-caption)"
            print(f"[train] every image has a caption — skipping the Qwen pass ({msg})")
            _patch_job(job_id, {"progress_percent": 4, "progress_message": msg})
            captions = [p.with_suffix(".txt").read_text(encoding="utf-8").strip() for p in image_paths]
        else:
            _patch_job(job_id, {"progress_percent": 3, "progress_message": "captioning dataset"})
            captions = _caption_missing(image_paths, supplied, trigger)
            for path, cap in zip(image_paths, captions):
                path.with_suffix(".txt").write_text(cap, encoding="utf-8")
        print(f"[train] stage 1 done in {time.time() - started:.0f}s")

        # Persist images + captions to the Volume so the next run of this
        # dataset_id skips Stage 1 entirely.
        if persist_dir and not reused_from_volume:
            try:
                persist_dir.mkdir(parents=True, exist_ok=True)
                for i, p in enumerate(image_paths):
                    shutil.copy2(p, persist_dir / f"{i:04d}{p.suffix or '.png'}")
                    shutil.copy2(p.with_suffix(".txt"), persist_dir / f"{i:04d}.txt")
                vol.commit()
                print(f"[train] persisted {len(image_paths)} image+caption pairs to {persist_dir}")
            except Exception as exc:  # noqa: BLE001 — caching is best-effort
                print(f"[train] caption persist skipped: {exc}")

        # --- Stage 2: ai-toolkit -----------------------------------------
        pathlib.Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)
        config_path = _build_config(
            lora_name, trigger, target_model, tc, override, custom_model_id, base_architecture, resolution
        )
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
# POSTs here; the whole body is an auth check + a .spawn(), so it must be
# fast even cold. It therefore runs on a TINY image (not the multi-GB
# training image) and keeps one container warm so the browser's ~55s
# dispatch timeout is never in play.
# ---------------------------------------------------------------------------
dispatch_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]")


@app.function(
    image=dispatch_image,
    timeout=60,
    min_containers=1,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="POST")
def train_lora_dispatch(item: dict, request: fastapi.Request):
    _authorize(request)
    if not item.get("output_lora_name"):
        raise fastapi.HTTPException(status_code=400, detail="output_lora_name is required")
    call = train_lora_job.spawn(item)
    return {"ok": True, "spawned": True, "modal_call_id": call.object_id, "job_id": item.get("job_id")}


# Physically cancels a spawned training FunctionCall so a pending-timeout
# refund never leaves a zombie job on Modal's queue. Best-effort — a call
# that's already done / gone / invalid just reports cancelled:false.
# Accepts either {"call_id": ...} or {"modal_call_id": ...}. Warm + tiny
# image so it answers instantly.
def _cancel_function_call(call_id: str) -> dict:
    call_id = str(call_id or "").strip()
    if not call_id:
        return {"success": False, "error": "No call_id provided"}
    try:
        fc = modal.FunctionCall.from_id(call_id)
        fc.cancel(terminate_containers=True)
        return {"success": True, "call_id": call_id}
    except Exception as exc:  # noqa: BLE001 — already gone / invalid id is fine
        return {"success": False, "call_id": call_id, "error": str(exc)}


@app.function(
    image=dispatch_image,
    timeout=30,
    min_containers=1,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="POST")
def cancel_lora_job(data: dict, request: fastapi.Request):
    _authorize(request)
    return _cancel_function_call(data.get("call_id") or data.get("modal_call_id") or "")


# Back-compat alias for the earlier endpoint name.
@app.function(
    image=dispatch_image,
    timeout=30,
    min_containers=1,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="POST")
def train_lora_cancel(item: dict, request: fastapi.Request):
    _authorize(request)
    res = _cancel_function_call(item.get("modal_call_id") or item.get("call_id") or "")
    return {"ok": True, "cancelled": bool(res.get("success")), **res}


# ---------------------------------------------------------------------------
# Local one-shot CLI
# ---------------------------------------------------------------------------
@app.local_entrypoint()
def main(
    data_dir: str,
    lora_name: str,
    target_model: str = "minimax_h3",
    custom_model_id: str = "",
    base_architecture: str = "",
    trigger_word: str = "",
    steps: int = 2000,
    rank: int = 32,
    alpha: int = 32,
    learning_rate: float = 1e-4,
    optimizer: str = "adamw8bit",
    resolution: int = 768,
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

    print(f"[main] {len(images)} images ({total / 1024**2:.1f} MB) -> Modal ({GPU_REQUEST}), target={target_model}")

    result = train_lora_job.remote(
        {
            "images": images,
            "captions": [],
            "target_model": target_model,
            "custom_model_id": custom_model_id,
            "base_architecture": base_architecture,
            "resolution": resolution,
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
