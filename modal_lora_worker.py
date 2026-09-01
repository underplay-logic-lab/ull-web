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
  LORA_WORKER_GPU   pin a single GPU tier (default: ["b300", "b200"] fallback list)
  AI_TOOLKIT_REF    ai-toolkit git ref (default: main)
"""

import base64
import collections
import copy
import hashlib
import hmac
import os
import pathlib
import queue
import re
import shutil
import subprocess
import threading
import time
import zipfile

import fastapi
import modal

app = modal.App("ull-lora-worker")

MODELS_DIR = "/models"
DATASET_DIR = "/root/dataset"
# Fallback default only. Real runs write into a per-job subdir of
# PERSIST_OUTPUT_ROOT (below) — see _job_output_dir() — so ai-toolkit's
# intermediate .safetensors land straight on the mounted Volume and a
# periodic vol.commit() keeps them alive even if the container is SIGKILLed
# mid-training. The checkpoint collectors take the same dir as an argument.
OUTPUT_DIR = "/root/ai-toolkit/output"
# Per-job ai-toolkit output, on the Volume: PERSIST_OUTPUT_ROOT/<run_key>/.
PERSIST_OUTPUT_ROOT = f"{MODELS_DIR}/outputs"
# Captioned datasets are persisted here on the Volume, keyed by dataset_id,
# so a re-run of the same set skips the VLM pass entirely (0s).
PERSIST_ROOT = f"{MODELS_DIR}/datasets"
# Persistent HF / torch caches ON the Volume. ensure_model_cached_cpu()
# pre-fills these on a cheap CPU container so a B300 ($0.31/s) never idles
# on a HuggingFace download; train_lora_job points HF_HOME / TORCH_HOME here
# and loads everything from local disk in 0s.
HF_CACHE_DIR = f"{MODELS_DIR}/training/hf_cache"
TORCH_CACHE_DIR = f"{MODELS_DIR}/training/torch_cache"
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

# Runtime-injected (no image rebuild needed): torchao 0.7.0 predates the
# quant_api config classes ai-toolkit/toolkit/util/quantize.py imports
# (Float8WeightOnlyConfig, etc.) — ImportError at `python run.py` startup
# even though torchao itself imports fine. Written to /root/sitecustomize.py
# and put ahead of SHIM_DIR on PYTHONPATH for the run.py subprocess, so it
# loads before the build-time SHIM_DIR/sitecustomize.py; it re-runs that
# same torchao-missing fallback itself so both failure modes stay covered.
_RUNTIME_QUANT_SHIM = '''\
try:
    import sys
    import torch
    try:
        import torchao
        import torchao.quantization
        import torchao.quantization.quant_api as qa

        # quant_api classes ai-toolkit expects but 0.7.0 doesn't have —
        # alias from torchao.quantization / torchao, else a placeholder
        # class (BF16 training never instantiates these, only imports them).
        for attr in (
            "Float8WeightOnlyConfig",
            "UIntXWeightOnlyConfig",
            "Int8WeightOnlyConfig",
            "Int4WeightOnlyConfig",
            "quantize_",
            "AOBaseConfig",
        ):
            if not hasattr(qa, attr):
                val = getattr(
                    torchao.quantization,
                    attr,
                    getattr(torchao, attr, type(attr, (object,), {})),
                )
                setattr(qa, attr, val)

        import torchao.quantization.quant_primitives as qp
        if not hasattr(qp, "_DTYPE_TO_BIT_WIDTH"):
            qp._DTYPE_TO_BIT_WIDTH = {
                torch.float32: 32, torch.float16: 16, torch.bfloat16: 16,
                torch.int8: 8, torch.uint8: 8, torch.int16: 16,
                torch.int32: 32, torch.int64: 64,
            }
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
    print("[aitk-shim] runtime quant_api shim skipped: " + repr(_e))

# toolkit/util/convrot_quant.py's get_convrot_quantizer() references
# ConvRotInt8Quantizer at CALL time — if the conditional import that's meant
# to define it fails with its own local try/except ImportError: pass, the
# module still imports cleanly (so the build-time _QUANT_PATCH file-wrap,
# which only guards import-time exceptions, sees nothing to catch) and the
# NameError only surfaces later when a caller actually invokes the
# function. Patch the module's namespace directly once it's importable.
try:
    import toolkit.util.convrot_quant as _crq
    if not hasattr(_crq, "ConvRotInt8Quantizer"):
        _candidates = [
            getattr(_crq, _name) for _name in dir(_crq)
            if "Quantizer" in _name
            and ("8" in _name or "Int8" in _name or "ConvRot" in _name)
            and isinstance(getattr(_crq, _name), type)
        ]
        if _candidates:
            _crq.ConvRotInt8Quantizer = _candidates[0]
        else:
            # BF16 LoRA training never needs real INT8 conv rotation —
            # a passthrough keeps get_convrot_quantizer() callable.
            class _DummyConvRotInt8Quantizer:
                def __init__(self, *args, **kwargs):
                    self.rot_size = kwargs.get("rot_size", 256)
                def __call__(self, *args, **kwargs):
                    return args[0] if args else None
            _crq.ConvRotInt8Quantizer = _DummyConvRotInt8Quantizer
except Exception as _crq_exc:
    print("[aitk-shim] convrot_quant shim skipped: " + repr(_crq_exc))

# toolkit/util/quantize.py's dequantize_ostris_to_linear() calls
# child.ostris_quantizer.dequantize_folded(child) — a method the aliased/
# dummy ConvRotInt8Quantizer above (and possibly other real Quantizer
# classes on older/mismatched ai-toolkit revisions) doesn't define. BF16
# training holds unquantized weights, so a plain passthrough-to-bf16 is
# always a safe answer regardless of what the caller expected back.
def _universal_dequantize_folded(self, module):
    for _m_name in ("dequantize", "dequantize_weight", "_dequantize", "_dequantize_weight", "dequantize_convrot8"):
        if _m_name != "dequantize_folded" and hasattr(self, _m_name):
            try:
                _res = getattr(self, _m_name)(module)
                if isinstance(_res, torch.Tensor):
                    return _res
            except Exception:
                pass

    try:
        import toolkit.util.convrot_quant as _crq_mod
        for _fn_name in ("dequantize_convrot8", "dequantize_int8", "dequantize_weight"):
            _fn = getattr(_crq_mod, _fn_name, None)
            if _fn is None:
                continue
            try:
                _res = _fn(module)
                if isinstance(_res, torch.Tensor):
                    return _res
            except Exception:
                pass
    except Exception:
        pass

    # Guaranteed-Tensor fallback: weight * scale in BF16, or a zero Tensor
    # of the right shape as an absolute last resort — never None.
    w = getattr(module, "weight", None)
    if not isinstance(w, torch.Tensor):
        for _attr in ("qweight", "weight_int8", "w"):
            _cand = getattr(module, _attr, None)
            if isinstance(_cand, torch.Tensor):
                w = _cand
                break

    if isinstance(w, torch.Tensor):
        scale = getattr(module, "scale", None)
        if scale is None:
            scale = getattr(module, "weight_scale", None)
        if scale is None:
            scale = getattr(module, "scales", None)
        w_float = w.to(torch.float32)
        if scale is not None:
            if isinstance(scale, torch.Tensor):
                scale = scale.to(w.device, dtype=torch.float32)
            w_float = w_float * scale
        return w_float.to(torch.bfloat16)

    out_f = getattr(module, "out_features", 2688)
    in_f = getattr(module, "in_features", 2688)
    device = w.device if (w is not None and hasattr(w, "device")) else "cpu"
    return torch.zeros((out_f, in_f), dtype=torch.bfloat16, device=device)

try:
    import toolkit.util.convrot_quant as _crq2
    if hasattr(_crq2, "ConvRotInt8Quantizer"):
        _crq2.ConvRotInt8Quantizer.dequantize_folded = _universal_dequantize_folded
    for _cls_name in dir(_crq2):
        _target_cls = getattr(_crq2, _cls_name)
        if isinstance(_target_cls, type) and "Quantizer" in _cls_name and not hasattr(_target_cls, "dequantize_folded"):
            _target_cls.dequantize_folded = _universal_dequantize_folded
except Exception as _dqf_exc:
    print("[aitk-shim] dequantize_folded bind failed: " + repr(_dqf_exc))
'''

VLM_PATH = f"{MODELS_DIR}/LLM/Qwen3.8-27B-abliterated"
LORA_OUTPUT_DIR = f"{MODELS_DIR}/loras"

# Blackwell-generation, huge-VRAM tiers (b300: 275GB, b200: ~180GB HBM3e) —
# comfortably fits Stage 1 (27B VLM, ~52GB) and Stage 2 (MiniMax H3, ~27GB)
# resident together with headroom to spare, which is what the earlier
# Stage1->Stage2 OOM on H100 (80GB) was actually about.
# b300's reduction ops (.prod()/.sum(), hit by Qwen's image_grid_thw.prod(-1)
# on every real job) used to throw "invalid value for --gpu-architecture
# (-arch)" under the old debian_slim+cu128/torch==2.7.0/Python 3.11 image —
# torch's cu128 build had no sm_103 (Blackwell Ultra / B300's actual
# capability) entry in its JIT arch table, matmul (cuBLAS, not JIT) worked
# fine while reductions (TensorIterator JIT) didn't. Confirmed fixed after
# moving to nvidia/cuda:13.0.0-devel-ubuntu24.04 + Python 3.13 + cu130 torch
# (matmul/prod/sum all verified on real B300 hardware) — torch's named_arches
# table gained an explicit 10.3 entry for cu130 builds. `LORA_WORKER_GPU`
# still pins a single tier when set.
GPU_REQUEST = os.environ.get("LORA_WORKER_GPU", "").strip() or ["b300", "b200"]
AI_TOOLKIT_REF = os.environ.get("AI_TOOLKIT_REF", "main")

# --- GPU-cost defence / watchdogs ----------------------------------------
# The container timeout is 12h; the only earlier stops are:
#   PREP  — a TRUE deadlock: no stdout/stderr/tqdm output AT ALL for
#           LORA_PREP_SILENCE_S. Multi-resolution latent caching
#           (512/768/1024/1280) legitimately runs well past 25m while
#           emitting progress the whole time, so there is NO cumulative
#           prep limit — only the silence watchdog. Any output line resets
#           it (see last_output in _run_ai_toolkit_with_progress).
#   COST  — after LORA_COST_MIN_STEP real steps, a trimmed moving average of
#           s/it projects total wall time; if it would cost more real GPU
#           money than the paid credits cover at a 30% margin
#           (_credit_covered_seconds), graceful stop + 100% refund +
#           salvageable partial checkpoints.
# Checkpoint I/O (`Saving at step` / `Saved checkpoint`) grants a grace
# window so a long disk sync never looks like a stall.
# LORA_SAFETY_LIMIT_S is only a fallback ceiling for credits_cost == 0.
LORA_PREP_SILENCE_S = int(os.environ.get("LORA_PREP_SILENCE_S", str(20 * 60)))
LORA_COST_MIN_STEP = int(os.environ.get("LORA_COST_MIN_STEP", "50"))
LORA_CKPT_IO_GRACE_S = int(os.environ.get("LORA_CKPT_IO_GRACE_S", str(5 * 60)))
LORA_SAFETY_LIMIT_S = int(os.environ.get("LORA_SAFETY_LIMIT_S", str(5 * 60 * 60)))
# Stage 1 (Qwen caption) dynamic budget: 30s/image, min 10 min.
LORA_CAPTION_S_PER_IMG = int(os.environ.get("LORA_CAPTION_S_PER_IMG", "30"))
LORA_CAPTION_MIN_S = int(os.environ.get("LORA_CAPTION_MIN_S", str(10 * 60)))

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
    "Never repeat the framing idea inside the part or scene tags.\n"
    "Directly output the final comma-separated tags starting with the trigger "
    "word. Do NOT output any thinking, reasoning, or preamble (no 'I need "
    "to...', no 'The instructions...', no '<think>')."
)

# CoT lead-ins the abliterated Qwen emits instead of a caption — stripped
# whenever they land at the very start of the (post-trigger) text.
_COT_PREFIX_RE = re.compile(
    r"^(?:i\s+need\s+to|i\s+should|i\s+will|i'?ll|i\s+am\s+going\s+to|"
    r"the\s+instructions?\b|the\s+user\s+(?:wants?|is\s+asking)|"
    r"let\s+me|here\s+is|here'?s|sure\b|certainly\b|okay\b|ok\b|"
    r"looking\s+at\s+(?:the\s+)?image[:,]?|first,\s*|based\s+on\s+the\b|"
    r"to\s+describe\b)\s*.*?(?:\.\s+|:\s+|\n|$)",
    re.IGNORECASE | re.DOTALL,
)


def _looks_like_cot(text: str) -> bool:
    """True if `text` still reads as reasoning rather than a caption."""
    return bool(_COT_PREFIX_RE.match(text.strip()))


# Anywhere-in-string signatures of a caption that still carries the VLM's
# own instructions / reasoning — used to reject a poisoned Volume cache.
_CAPTION_CONTAMINATION_RE = re.compile(
    r"(?i)\b(?:i\s+need\s+to\s+describe|i\s+should\s+describe|i\s+will\s+describe|"
    r"the\s+instructions?|the\s+user\s+(?:wants?|is\s+asking)|let\s+me\s+describe|"
    r"single[-\s]line\s+english\s+caption|caption\s+this\s+image|"
    r"starting\s+with\s+['\"]|as\s+an\s+ai|i(?:'m|\s+am)\s+sorry|i\s+cannot)\b"
)


def _caption_is_contaminated(text: str) -> bool:
    """A cached/generated caption that still carries the VLM's own
    instructions or chain-of-thought (see the yukipas CoT-leak incident)."""
    return bool(_CAPTION_CONTAMINATION_RE.search(text or ""))


def _sanitize_caption(raw_text: str, trigger: str) -> str:
    """Strip any chain-of-thought / preamble the VLM leaked and return a
    single-line caption that begins with the trigger word.

    The abliterated Qwen routinely emits its scratch-work ("I need to
    describe the pose...", "The instructions (in Japanese) require...")
    instead of, or ahead of, the real caption — sometimes using up the
    whole token budget. Extraction rules, in order:
      1. if there's a </think>, keep only what follows the last one;
      2. anchor on a trigger word at the START of a line (that's the real
         caption) — only fall back to the LAST occurrence, since a trigger
         mid-sentence is almost always inside the model's quoted instructions;
      3. drop a CoT sentence sitting right after the trigger;
      4. if nothing survives, return the trigger token alone.
    """
    text = (raw_text or "").strip()
    tq = re.escape(trigger)

    # 1. reasoning-model scratch-work
    if "</think>" in text.lower():
        text = re.split(r"(?i)</think>", text)[-1].strip()
    text = re.sub(r"(?is)<think\b.*?</think>", "", text).strip()
    text = re.sub(r"(?is)<think\b.*$", "", text).strip()
    text = re.sub(r"(?i)</?think\b[^>]*>", "", text).strip()

    # 2. anchor on the trigger word
    m = re.search(rf"(?im)^[\s\"'>*_.\-]*{tq}\b", text)
    if m:
        text = text[m.start():]
    else:
        idx = text.lower().rfind(trigger.lower())
        text = text[idx:] if idx != -1 else f"{trigger}, {text}"

    # strip the leading trigger token + any quote/punct glue after it
    text = re.sub(rf"(?i)^[\s\"'>*_.\-]*{tq}\b[\s\"'.,:;）)]*", "", text).strip()

    # 3. peel CoT sentences that trail right after the trigger
    for _ in range(4):
        stripped = _COT_PREFIX_RE.sub("", text, count=1).strip()
        if stripped == text:
            break
        text = stripped

    # 4. one line, no dangling punctuation
    text = " ".join(text.split()).strip(" \"'.,:;-—()")

    if len(text) < 3 or len(text.split()) < 2 or _looks_like_cot(text):
        return trigger
    return f"{trigger}, {text}"

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
    # Aligned with modal_wan_animate_blackwell.py's proven Blackwell setup:
    # NVIDIA's own CUDA 13.0 "devel" image (nvcc + full toolkit present, no
    # apt CUDA bolt-on needed) + Python 3.13, rather than debian_slim +
    # cu128. That file's TORCH_CUDA_ARCH_LIST comment documents torch's own
    # named_arches table gaining an explicit '10.3' (Blackwell Ultra / B300)
    # entry for cu130 builds — the gap that made B300's TensorIterator JIT
    # reduction path throw "invalid value for --gpu-architecture" on cu128.
    modal.Image.from_registry(
        "nvidia/cuda:13.0.0-devel-ubuntu24.04",
        add_python="3.13",
    )
    .apt_install(
        # libgl1-mesa-glx was dropped from Ubuntu 24.04 (noble) — libgl1
        # replaces it there (see modal_wan_animate_blackwell.py).
        "git", "ffmpeg", "libgl1", "libglib2.0-0", "wget",
        # A real C/C++ + ninja toolchain for any JIT/quant kernel build path.
        "build-essential", "ninja-build",
        # ai-toolkit's requirements.txt hard-pins scipy==1.12.0, which has no
        # cp313 (Python 3.13) prebuilt wheel and falls back to a from-source
        # meson build — which needs a Fortran compiler pip can't provide.
        # Without gfortran, that one package's metadata-generation failure
        # takes the ENTIRE `pip install -r requirements.txt` down with it
        # (pip resolves the whole file as one transaction), silently
        # skipping everything listed after it (peft, huggingface_hub,
        # optimum-quanto, gradio, librosa, matplotlib, torchcodec, ...).
        "gfortran",
    )
    .env(
        {
            "CUDA_HOME": "/usr/local/cuda",
            "PATH": "/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "LD_LIBRARY_PATH": "/usr/local/cuda/lib64",
            # 10.0 = Blackwell (B200/B300), 10.3 = Blackwell Ultra (B300's
            # actual reported capability) — matches torch's own named_arches
            # table for cu130 builds. Deliberately NOT setting
            # CUDA_FORCE_PTX_JIT: confirmed on cu128 that forcing PTX JIT
            # makes the driver refuse working native cubin kernels — that
            # was the actual "no kernel image" cause, not a fix for it.
            "TORCH_CUDA_ARCH_LIST": "10.0;10.3;12.0;10.0+PTX",
            # add_python's Python 3.13 build is compiled with clang, whose
            # CXX=clang++/CC=clang setuptools/distutils would otherwise pick
            # up by default — build-essential only provides real gcc/g++.
            "CC": "gcc",
            "CXX": "g++",
        }
    )
    .pip_install(
        # No version pin here (mirrors modal_wan_animate_blackwell.py) — the
        # cu130 index doesn't publish every torch release for every Python
        # ABI, so pinning risks asking for a torch/torchvision/torchaudio
        # combo that doesn't exist for cp313; letting pip resolve whatever
        # it actually has for 3.13 is safer than a stale hard pin. torchaudio
        # is required — ai-toolkit imports it unconditionally at startup.
        "torch",
        "torchvision",
        "torchaudio",
        extra_index_url="https://download.pytorch.org/whl/cu130",
    )
    .pip_install("ninja")
    .pip_install("modal", "grpclib")
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
    # torchao is a hard import in ai-toolkit (toolkit/config_modules.py) —
    # left to ai-toolkit's own requirements.txt to pull whatever version it
    # wants (unlike the old cu128 setup, no hard pin here): a torch-2.5-era
    # torchao==0.7.0 pinned against this cu130/newer-torch build would be a
    # worse native-extension ABI mismatch than letting requirements.txt pick
    # a torchao released alongside a torch this new. If it still can't
    # import cleanly (or is missing quant_api classes ai-toolkit expects) at
    # runtime, the sitecustomize MagicMock stub / _RUNTIME_QUANT_SHIM
    # aliasing below takes over regardless of which version landed.
    .run_commands(
        f"git clone https://github.com/ostris/ai-toolkit.git {AI_TOOLKIT_DIR}",
        f"cd {AI_TOOLKIT_DIR} && git checkout {AI_TOOLKIT_REF} && git submodule update --init --recursive",
        # ai-toolkit hard-pins scipy==1.12.0, which has no cp313 (Python
        # 3.13) prebuilt wheel and forces a from-source meson build needing
        # a Fortran compiler + OpenBLAS + pkg-config — a much deeper
        # dependency chain than this image wants to chase. The earlier
        # pip_install block above already installed an unpinned scipy
        # (resolves to a real cp313 wheel, e.g. 1.18.1) that satisfies
        # ai-toolkit's actual usage just fine, so relax the pin here instead
        # of building the old version from source. Applied to every
        # requirements*.txt ai-toolkit ships with, since which file
        # actually declares scipy varies by revision.
        f"cd {AI_TOOLKIT_DIR} && sed -i -E 's/^scipy==[0-9.]+/scipy/' requirements*.txt 2>/dev/null || true",
        f"cd {AI_TOOLKIT_DIR} && pip install -r requirements.txt || echo 'ai-toolkit requirements.txt partial install, continuing'",
        "echo '[image] torch/torchao state right after ai-toolkit requirements.txt:'",
        "pip show torch torchao | grep -E '^(Name|Version|Location)'",
        # re-assert the torch trio in case ai-toolkit's requirements swapped
        # it for a non-cu130 build (all --no-deps so nothing drags the
        # others in) — torchao is deliberately NOT re-asserted here, so
        # whatever ai-toolkit's requirements.txt picked stays put.
        # --force-reinstall: `pip install pkg` is a no-op if any build of
        # pkg is already installed, so if requirements.txt pulled a plain
        # PyPI CPU wheel under the same torch package name, a bare re-pin
        # here would silently do nothing — force it to actually re-fetch cu130.
        "pip install --no-deps --force-reinstall torch torchvision torchaudio "
        "--extra-index-url https://download.pytorch.org/whl/cu130",
        "echo '[image] torch state after force-reinstalling cu130:'",
        "pip show torch | grep -E '^(Name|Version|Location)'",
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
            # Load the base model from the persistent Volume cache that
            # ensure_model_cached_cpu() pre-filled — no HuggingFace round-trip
            # on the GPU. (NOT forcing HF_HUB_OFFLINE, so a cache miss still
            # falls back to an on-GPU download rather than a hard failure.)
            "HF_HOME": HF_CACHE_DIR,
            "HUGGINGFACE_HUB_CACHE": f"{HF_CACHE_DIR}/hub",
            "TORCH_HOME": TORCH_CACHE_DIR,
            "PYTHONUNBUFFERED": "1",
            "PYTHONPATH": SHIM_DIR,
            # Deliberately NOT setting CUDA_FORCE_PTX_JIT / TORCH_CUDA_ARCH_LIST.
            # Confirmed by direct probe: torch==2.7.0+cu128's arch_list already
            # includes sm_100 (native cubin, ships with both B200 sm_100 and
            # B300 sm_103 confirmed working via forward-compat) — forcing PTX
            # JIT made the driver refuse those working native kernels and was
            # the actual cause of "no kernel image is available", not a fix
            # for it. Do not re-add these without re-verifying on real HW.
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


def _current_effective_vram_gb():
    """Device-global effective VRAM in use, in GB — just the one number, no
    total / denominator and no GPU model name (the client renders it as a
    spoiler-free 'Active VRAM' badge). None when CUDA isn't available."""
    try:
        import torch

        if torch.cuda.is_available():
            free_b, total_b = torch.cuda.mem_get_info()
            return round((total_b - free_b) / (1024**3), 1)
    except Exception:  # noqa: BLE001 — telemetry only, never fatal
        pass
    return None


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


class InfraError(RuntimeError):
    """A transient infrastructure failure (network / Storage / GPU-side), as
    opposed to a caller config error. Refunded even for raw-YAML jobs."""


class SafetyLimitError(RuntimeError):
    """The run was deliberately stopped early by the system to protect real
    GPU cost — either the prep phase deadlocked ("prep"), or the measured
    projected wall time would cost more than the paid credits cover at a 30%
    margin ("cost"). Partial checkpoints are committed + salvageable, and the
    credits are 100% refunded (it's the system's call, not a config crash)."""

    def __init__(self, message: str, *, kind: str = "cost", refund: bool = True):
        super().__init__(message)
        self.kind = kind
        self.refund = refund


def _credit_covered_seconds(credits_cost: int) -> int:
    """Max GPU seconds the paid credits cover at a >=30% gross margin.

      revenue_jpy  = credits_cost * 1.66      (cheapest subscription unit price)
      max_cost_jpy = revenue_jpy * 0.70       (keep 30% margin)
      B300         = 1125 JPY/h -> 0.3125 JPY/s
      -> seconds   = max_cost_jpy / 0.3125    (≈ credits_cost * 3.72)

    Floored at 1800s (30 min) so a cheap job still gets a fair shot; capped
    just under the 12h container timeout so we always stop gracefully first.
    """
    revenue_jpy = max(0, credits_cost) * 1.66
    max_cost_jpy = revenue_jpy * 0.70
    b300_jpy_per_sec = 1125 / 3600
    secs = max_cost_jpy / b300_jpy_per_sec if b300_jpy_per_sec else 0.0
    return int(max(1800, min(secs, 12 * 60 * 60 - 20 * 60)))


def _download_storage_object(bucket: str, key: str, attempts: int = 4) -> bytes:
    """Fetches one object out of a (private) Supabase Storage bucket with the
    service-role key — bypasses Storage RLS. Retries transient network /
    5xx failures with backoff: a single slow read must not sink a whole
    (multi-thousand-credit) training job."""
    import requests

    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured")
    if ".." in key:
        raise ValueError(f"illegal storage key: {key!r}")

    url = f"{supabase_url}/storage/v1/object/{bucket}/{key.lstrip('/')}"
    headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
    last_exc: Exception | None = None
    for i in range(attempts):
        try:
            res = requests.get(url, headers=headers, timeout=(10, 120))
            if res.status_code == 200:
                return res.content
            # 5xx / 429 are worth retrying; a 4xx (missing object, bad key) is not.
            if res.status_code < 500 and res.status_code != 429:
                raise RuntimeError(
                    f"storage download failed ({res.status_code}) for {bucket}/{key}: {res.text[:300]}"
                )
            last_exc = RuntimeError(f"storage {res.status_code} for {bucket}/{key}: {res.text[:200]}")
        except requests.exceptions.RequestException as exc:
            last_exc = exc
        if i < attempts - 1:
            wait = min(2 ** i, 8)
            print(f"[storage] {key} attempt {i + 1}/{attempts} failed ({last_exc}); retry in {wait}s", flush=True)
            time.sleep(wait)
    raise InfraError(f"storage download for {bucket}/{key} failed after {attempts} attempts: {last_exc}")


# Signatures of a transient NETWORK / storage failure (ours) that aborts a
# run early — as opposed to a config error or an over-scoped job that just
# runs out of GPU time. Deliberately NARROW: OOM / CUDA faults / the 12h
# container timeout are the caller's config responsibility, NOT refunded for
# raw-YAML jobs (a full 12h GPU burn can't be given back for free).
_INFRA_MSG_RE = re.compile(
    r"(read timed out|connect timed out|connection (?:reset|aborted|error|refused)|"
    r"connectionpool|max retries exceeded|failed to establish a new connection|"
    r"temporarily unavailable|name or service not known|"
    r"no space left on device|502 bad gateway|\b50[234]\b)",
    re.IGNORECASE,
)


def _is_infra_error(exc: BaseException) -> bool:
    """True only for transient network/storage failures — see _INFRA_MSG_RE."""
    if isinstance(exc, (InfraError, ConnectionError)):
        return True
    name = type(exc).__name__
    if name in ("ConnectionError", "Timeout", "ReadTimeout", "ConnectTimeout", "ChunkedEncodingError"):
        return True
    if "requests.exceptions" in str(type(exc).__module__) and "timed out" in str(exc).lower():
        return True
    return bool(_INFRA_MSG_RE.search(str(exc)))


def _patch_job(job_id: str, fields: dict) -> None:
    if not job_id:
        return

    def _send(payload: dict):
        return _supabase_request(
            "PATCH",
            "/rest/v1/generation_jobs",
            params={"id": f"eq.{job_id}"},
            json={**payload, "updated_at": _now_iso()},
            headers={"Prefer": "return=minimal"},
        )

    try:
        res = _send(fields)
        # If this deploy is ahead of the DB (no `metadata` column yet), the
        # whole PATCH 4xxs — retry without it so progress_* still lands.
        if res is not None and res.status_code >= 400 and "metadata" in fields:
            body = (res.text or "").lower()
            if "metadata" in body or "schema cache" in body or "column" in body:
                slim = {k: v for k, v in fields.items() if k != "metadata"}
                if slim:
                    _send(slim)
                print(f"[lora-worker] job {job_id}: 'metadata' column absent — patched without it")
    except Exception as exc:  # noqa: BLE001 — best-effort, never propagate
        print(f"[lora-worker] failed to update job {job_id}: {exc}")


def _claim_job(job_id: str, fields: dict) -> bool:
    """Conditional 'queued' -> 'processing' claim. Returns True only if THIS
    call flipped the row — i.e. the client's pending-failover hasn't already
    cancelled / superseded it. A returned [] means 0 rows matched (row is no
    longer 'queued'), so the worker must abort without touching the GPU."""
    if not job_id:
        return True
    try:
        res = _supabase_request(
            "PATCH",
            "/rest/v1/generation_jobs",
            params={"id": f"eq.{job_id}", "status": "eq.queued"},
            json={**fields, "updated_at": _now_iso()},
            headers={"Prefer": "return=representation"},
        )
        if res is None:
            return True  # Supabase not configured — local CLI path
        rows = res.json()
        return bool(rows)
    except Exception as exc:  # noqa: BLE001
        print(f"[lora-worker] job claim check failed for {job_id} (continuing): {exc}")
        return True


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
def _caption_missing(
    image_paths: list[pathlib.Path],
    captions: list[str],
    trigger: str,
    caption_prompt: str = "",
    budget_s: float | None = None,
) -> list[str]:
    """Returns a full caption list aligned to image_paths — supplied entries
    are kept verbatim, blanks/missing entries are filled by the VLM.

    caption_prompt: the user's own instruction for the VLM (from the LoRA
    Studio "AIキャプション生成プロンプト" presets / free-text box). Applied
    to the Qwen chat messages verbatim. Empty -> the default character prompt.

    budget_s: soft wall-clock budget for the whole Stage 1 (model load +
    every batch). When it's blown, the remaining images get the trigger word
    alone and training proceeds — never fail the job over a slow VLM.
    """
    _stage1_start = time.time()
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

    if caption_prompt and caption_prompt.strip():
        # The user's instruction — the LoRA Studio presets are in Japanese,
        # free-text may be either language. Wrap it so Qwen always emits a
        # single-line ENGLISH caption regardless of the instruction's
        # language, with the trigger token pinned to the front.
        instruction = caption_prompt.strip()
        if "{trigger}" in instruction:
            instruction = instruction.format(trigger=trigger)
        system_instruction = f"""You are an expert AI dataset captioner for LoRA training.
Follow the user's instructions (provided in Japanese or English) and generate a single-line, highly detailed English description of the image.

[User Instructions]
{instruction}

[Formatting Rules]
- Output language: English only.
- Format: A single line without linebreaks.
- Trigger word placement: Start the caption with '{trigger}', followed by a comma and the description.
- CRITICAL: Directly output the final comma-separated description starting with the trigger word. Do NOT output any thinking, reasoning, or preamble (no 'I need to...', no 'The instructions...', no '<think>'). Your entire response must be the caption itself and nothing else.
"""
        instruction = system_instruction
        print(f"[stage1] wrapped caller caption prompt in English-output template ({len(instruction)} chars)", flush=True)
    else:
        instruction = CAPTION_INSTRUCTION.format(trigger=trigger)
    print(f"[stage1] captioning {len(todo)}/{len(image_paths)} images with the VLM at {VLM_PATH}", flush=True)

    # Single-GPU direct load — device_map="auto" runs a memory-profiling pass
    # that stalls badly when weights are streamed off a network volume.
    _device = "cuda" if torch.cuda.is_available() else "cpu"

    # Qwen3-VL is an image-text-to-text model. Load it with the OFFICIAL
    # AutoModelForImageTextToText and nothing else — no AutoModelForVision2Seq
    # (removed from transformers), no Qwen2_5_VLForConditionalGeneration (wrong
    # architecture family), no text-only AutoModelForCausalLM (folds the vision
    # tower dims into the text hidden_size/num_heads math -> "hidden_size must
    # be divisible by num_heads"). No manual head/dim overrides either — the
    # checkpoint's own config.json (40 attention heads) is authoritative.
    print("[Qwen Load] loading via AutoModelForImageTextToText...", flush=True)
    _t0 = time.time()
    from transformers import AutoModelForImageTextToText

    try:
        model = AutoModelForImageTextToText.from_pretrained(
            VLM_PATH,
            torch_dtype=torch.bfloat16,
            device_map=_device,
            attn_implementation="sdpa",
            local_files_only=True,
        )
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"could not load the VLM at {VLM_PATH}: {exc}") from exc
    print(f"[Qwen Load] Model loaded in {time.time() - _t0:.1f}s", flush=True)

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
        # Strip leaked chain-of-thought / preambles first, then normalise the
        # comma-separated token list.
        line = _sanitize_caption(raw, trigger).strip('"')
        line = ", ".join(t.strip() for t in line.split(",") if t.strip())
        if not line.lower().startswith(trigger.lower()):
            line = f"{trigger}, {line}"
        return line

    batch_size = int(os.environ.get("CAPTION_BATCH", "8"))
    for start in range(0, len(todo), batch_size):
        if budget_s is not None and (time.time() - _stage1_start) > budget_s:
            leftover = todo[start:]
            for i in leftover:
                filled[i] = trigger
            print(
                f"[stage1] caption budget {budget_s:.0f}s exceeded after "
                f"{time.time() - _stage1_start:.0f}s — {len(leftover)} image(s) get the "
                f"trigger word only, continuing to training",
                flush=True,
            )
            break
        idx_chunk = todo[start : start + batch_size]
        texts, images = [], []
        for i in idx_chunk:
            img_path = image_paths[i]
            messages = [
                {"role": "system", "content": instruction},
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "image": f"file://{img_path}"},
                        {"type": "text", "text": "Caption this image following the instructions above."},
                    ],
                },
            ]
            try:
                # Qwen3's chat template can prepend a <think> block; ask it
                # not to. Unknown kwarg on some template versions -> retry
                # without it.
                rendered = processor.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True, enable_thinking=False
                )
            except TypeError:
                rendered = processor.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True
                )
            texts.append(rendered)
            if process_vision_info is not None:
                got, _ = process_vision_info(messages)
                images.append(got[0] if got else Image.open(img_path).convert("RGB"))
            else:
                images.append(Image.open(img_path).convert("RGB"))

        inputs = processor(text=texts, images=images, padding=True, return_tensors="pt").to(model.device)
        with torch.inference_mode():
            generated = model.generate(**inputs, max_new_tokens=350, do_sample=False)
        trimmed = generated[:, inputs["input_ids"].shape[1] :]
        decoded = processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)
        for i, raw in zip(idx_chunk, decoded):
            filled[i] = _clean(raw)
            print(f"[stage1] {image_paths[i].name}: {filled[i][:120]}")

    # Stage 1 is done — get the 27B VLM fully off the GPU before Stage 2.
    del model
    try:
        del processor
    except Exception:
        pass
    try:
        del inputs, generated, trimmed  # noqa: F821 — defined once todo ran
    except Exception:
        pass
    import gc

    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()
    return filled[: len(image_paths)]


# ---------------------------------------------------------------------------
# Stage 2 — ai-toolkit config + run
# ---------------------------------------------------------------------------
H3_LOCAL_UNET = f"{MODELS_DIR}/diffusion_models/minimax_h3_fl2va_bf16.safetensors"


def _cloud_safe_model_block(
    user_model: dict,
    target_model: str,
    custom_model_id: str,
    base_architecture: str,
) -> dict:
    """A `model:` block guaranteed to resolve inside this container.

    Resolution order: the dropdown pick (target_model) -> the first registry
    entry whose arch matches -> target_model='custom' universal loader. If
    none resolve, the user's block is kept but any obviously-local
    name_or_path is dropped so ai-toolkit at least reports a clean error.
    """
    arch = str(user_model.get("arch") or base_architecture or "").strip()

    # arch == "minimax_h3" ALWAYS resolves to the single-file checkpoint on
    # the Volume, with quantize / low_vram hard-off — regardless of the
    # name_or_path / quantize flags the raw YAML carried (those routinely
    # point at a local machine's path or force NVFP4 quant this backend
    # doesn't run for BF16 LoRA training).
    if arch == "minimax_h3":
        h3 = TARGET_MODELS["minimax_h3"]
        return {
            "name_or_path": h3["unet"],
            "arch": "minimax_h3",
            "quantize": False,
            "low_vram": False,
            "text_encoder_path": h3["text_encoder"],
            "vae_path": h3["vae"],
        }

    safe = None
    if target_model and target_model != "custom" and target_model in TARGET_MODELS:
        safe = TARGET_MODELS[target_model]
    if safe is None and arch:
        safe = next((t for t in TARGET_MODELS.values() if t.get("arch") == arch), None)

    if safe is not None:
        block = {
            "name_or_path": safe["unet"],
            "arch": safe["arch"],
            "quantize": False,
            "low_vram": False,
        }
        if safe.get("text_encoder"):
            block["text_encoder_path"] = safe["text_encoder"]
        if safe.get("vae"):
            block["vae_path"] = safe["vae"]
        return block

    if target_model == "custom" and custom_model_id and not _is_blocked_model(custom_model_id):
        path = custom_model_id
        if "/" not in path and not path.startswith("http"):
            path = f"{MODELS_DIR}/{path}"
        return {"name_or_path": path, "arch": (arch or base_architecture or "sdxl"), "quantize": False, "low_vram": False}

    # Unresolvable — keep the user's block but strip a local abs path that
    # would 404 / crash, and never leave arch=minimax_h3 pointing at nothing.
    block = dict(user_model)
    np = str(block.get("name_or_path") or "")
    if arch == "minimax_h3":
        block["name_or_path"] = H3_LOCAL_UNET
        block["quantize"] = False
        block["low_vram"] = False
    elif np.startswith("/") and not np.startswith(MODELS_DIR):
        block.pop("name_or_path", None)
        print(f"[stage2][sanitize] dropped unresolvable local model path: {np}")
    return block


def _sanitize_override_yaml(
    override,
    lora_name: str,
    target_model: str = "",
    custom_model_id: str = "",
    base_architecture: str = "",
    output_dir: str = OUTPUT_DIR,
    trigger: str = "",
) -> str:
    """Force the environment-dependent values in a caller-supplied ai-toolkit
    YAML to the ones that actually exist inside this container:

      1. datasets[0].folder_path   -> DATASET_DIR   ("/root/dataset")
      2. process[0].training_folder-> output_dir (the per-job Volume path)
      3. process[0].device         -> "cuda:0"
      4. process[0].model          -> a cloud-resolvable definition based on
                                       arch / the dropdown pick

    In raw-YAML mode the YAML's own `config.name` and
    `process[0].trigger_word` are authoritative (the UI disables the form
    fields). `config.name` is only filled from `lora_name` when the YAML
    omits it; `trigger` is only injected when the YAML omits trigger_word.

    A raw YAML from the "生YAML" box routinely carries someone else's
    dataset / output dirs and a model.name_or_path that isn't on the Volume
    (for arch=minimax_h3, often nothing — which makes ai-toolkit fall back
    to a 404-ing HuggingFace download).
    """
    import yaml

    if isinstance(override, str):
        try:
            data = yaml.safe_load(override)
        except yaml.YAMLError as e:
            mark = getattr(e, "problem_mark", None) or getattr(e, "context_mark", None)
            where = f" on line {mark.line + 1}, column {mark.column + 1}" if mark else ""
            problem = getattr(e, "problem", None) or str(e).splitlines()[0]
            raise ValueError(
                f"[YAML Syntax Error{where}] {problem}. "
                f"生YAMLの構文を確認してください（該当行の ':' 抜け・インデント崩れなど）。"
            ) from None
    else:
        data = copy.deepcopy(override)
    if not isinstance(data, dict):
        # Unparseable / not a mapping — hand it back untouched, _build_config
        # will still write it and ai-toolkit will report the real error.
        return override if isinstance(override, str) else yaml.safe_dump(override, sort_keys=False)

    processes = (((data.get("config") or {}).get("process")) or [])
    proc = processes[0] if processes and isinstance(processes[0], dict) else None

    # config.name drives ai-toolkit's output subdir; _collect_*_checkpoints()
    # look under <output_dir>/<lora_name>, so the two must agree — but in
    # raw-YAML mode `lora_name` is ALREADY derived from this same config.name
    # (see _override_identity in train_lora_job), so keep the YAML's value and
    # only fall back to lora_name when the YAML has none.
    if isinstance(data.get("config"), dict):
        existing_name = str(data["config"].get("name") or "").strip()
        data["config"]["name"] = existing_name or lora_name

    if proc is not None:
        # The YAML's trigger_word wins; only fill it in when the YAML omits it,
        # so ai-toolkit and the caption pipeline agree on one trigger.
        if trigger and not str(proc.get("trigger_word") or "").strip():
            proc["trigger_word"] = trigger

        user_model = proc.get("model") if isinstance(proc.get("model"), dict) else {}
        proc["model"] = _cloud_safe_model_block(
            user_model, target_model, custom_model_id, base_architecture
        )

        datasets = proc.get("datasets")
        if isinstance(datasets, list) and datasets and isinstance(datasets[0], dict):
            datasets[0]["folder_path"] = DATASET_DIR
        else:
            proc["datasets"] = [
                {
                    "folder_path": DATASET_DIR,
                    "caption_ext": "txt",
                    "cache_latents_to_disk": True,
                    "resolution": [768],
                }
            ]

        # Per-job dir on the Volume — the checkpoint collectors are handed the
        # same path, and a periodic vol.commit() during training keeps the
        # intermediate .safetensors alive through a SIGKILL.
        proc["training_folder"] = output_dir
        proc["device"] = "cuda:0"
        print(
            f"[stage2][sanitize] folder_path/training_folder/device/model forced "
            f"(arch={proc['model'].get('arch')})",
            flush=True,
        )

    return yaml.safe_dump(data, sort_keys=False)


def _build_config(
    lora_name: str,
    trigger: str,
    target_model: str,
    tc: dict,
    override,
    custom_model_id: str = "",
    base_architecture: str = "",
    resolution: int = 768,
    output_dir: str = OUTPUT_DIR,
) -> pathlib.Path:
    """Manual override (raw YAML string or a dict) wins outright; otherwise
    a standard job YAML is assembled from `tc` + either the preset registry
    or, for target_model=="custom", the caller's model id + architecture
    (universal loader — any HF repo id or Volume path)."""
    config_path = pathlib.Path(AI_TOOLKIT_DIR) / f"config_{lora_name}.yaml"

    if override:
        # A hand-written YAML from the "生YAML" box must never be able to run
        # (or silently no-op) a paid job because it points folder_path /
        # training_folder / device / model at a local machine's values.
        # _sanitize_override_yaml force-rewrites all of those to the paths
        # that actually exist inside this container.
        sanitized = _sanitize_override_yaml(
            override, lora_name, target_model, custom_model_id, base_architecture, output_dir, trigger
        )
        config_path.write_text(sanitized, encoding="utf-8")
        print(f"[stage2] wrote sanitized custom_yaml_override -> {config_path}")
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
    # Intermediate checkpoints every 500 steps (or every 25% for short runs),
    # so the user can pick the least over-fit step afterward. Keep them all.
    save_every = min(500, max(100, steps // 4))
    res = resolution if resolution in (512, 768, 1024) else 768

    # low_vram off — the Blackwell tiers (b300/b200) have the headroom to
    # keep everything resident at full speed instead of offloading.
    model_block = {"name_or_path": target["unet"], "arch": target["arch"], "quantize": False, "low_vram": False}
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
                    "training_folder": output_dir,
                    "device": "cuda:0",
                    "trigger_word": trigger,
                    "network": {"type": "lora", "linear": rank, "linear_alpha": alpha},
                    "save": {
                        "dtype": "bf16",
                        "save_every": save_every,
                        "max_step_saves_to_keep": 20,
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


# ai-toolkit / tqdm training progress line, e.g.
#   " 12%|█▏     | 245/3000 [02:14<16:03,  0.55s/it, lr: 1.0e-4 loss: 0.123]"
#   " 12%|█▏     | 245/3000 [02:14<16:03,  1.82it/s, loss: 0.09]"
_TQDM_STEP_RE = re.compile(r"(\d+)\s*/\s*(\d+)\s*\[[^\]]*?([\d.]+)\s*(s/it|it/s)")
_TQDM_LOSS_RE = re.compile(r"loss[:=]\s*([\d.]+(?:[eE][+-]?\d+)?)")

# ai-toolkit's latent-cache tqdm bar (its OWN phase — must NOT be read as a
# training step, or "120/120" caching reads as "Step 120/120" and the bar
# jumps to 95%):
#   "Caching latents to disk:  45%|████▌     | 54/120 [00:12<00:14,  4.35it/s]"
#   "Caching latents:  45%|...| 54/120 ..."
_CACHE_BAR_RE = re.compile(
    r"[Cc]aching\s+latents?(?:\s+to\s+disk)?\s*:?\s*\d+\s*%\s*\|[^|]*\|\s*(\d+)\s*/\s*(\d+)"
)
# Resolution hint around the caching phase — the config echo or a bucket dim:
#   "  resolution: [768]"   "Resolution: 1024"   "Bucket ... (768, 512): 40"
_RES_HINT_RE = re.compile(r"resolution['\"]?\s*[:=]\s*\[?\s*(\d{3,4})", re.IGNORECASE)
_BUCKET_DIM_RE = re.compile(r"\(\s*(\d{3,4})\s*,\s*(\d{3,4})\s*\)\s*:")

# Prep-phase milestone markers (broadly matched — ai-toolkit wording varies).
_MODEL_LOADED_RE = re.compile(
    r"model\s*loaded|loaded\s+(?:the\s+)?model|weights?\s+loaded|finished\s+loading|"
    r"load(?:ing|ed).{0,20}complete|pipeline\s+ready",
    re.IGNORECASE,
)
_CACHE_RE = re.compile(r"cach\w*\s+latents?|latent\s+cache|bucket|preprocess", re.IGNORECASE)
_CKPT_SAVE_RE = re.compile(
    r"saving\s+at\s+step|saved\s+checkpoint|saving\s+checkpoint|saving\s+model|"
    r"writing\s+safetensors",
    re.IGNORECASE,
)


def _trimmed_spi(hist) -> float | None:
    """Trimmed-mean seconds/iteration over the recent ~30-step window — drops
    the fastest & slowest 15% of per-interval samples so an initial JIT stall
    (or a burst of cached-latent fast steps) doesn't skew the projection."""
    xs = list(hist)
    if len(xs) < 5:
        return None
    last_step = xs[-1][1]
    xs = [p for p in xs if last_step - p[1] <= 30] or xs
    ivs: list[float] = []
    for (t0, s0), (t1, s1) in zip(xs, xs[1:]):
        ds = s1 - s0
        if ds > 0:
            ivs.append((t1 - t0) / ds)
    if len(ivs) < 3:
        return None
    ivs.sort()
    k = max(1, int(len(ivs) * 0.15))
    core = ivs[k:-k] if len(ivs) > 2 * k else ivs
    return (sum(core) / len(core)) if core else None


def _fmt_duration(seconds: float | None) -> str:
    if not seconds or seconds < 0:
        return "—"
    s = int(seconds)
    if s < 60:
        return f"{s}秒"
    if s < 3600:
        return f"{s // 60}分{s % 60:02d}秒"
    return f"{s // 3600}時間{(s % 3600) // 60:02d}分"


def _run_ai_toolkit_with_progress(
    config_path: pathlib.Path,
    job_id: str,
    total_steps: int,
    commit_vol: bool = False,
    job_started_ts: float | None = None,
    safety_limit_s: int = LORA_SAFETY_LIMIT_S,
    resolution: int = 0,
) -> None:
    """Runs `python -u run.py <config>`, streaming its merged stdout/stderr
    line-by-line to this container's stdout (-> Modal's live log) while
    parsing tqdm's "<step>/<total> [.. s/it .. loss: ..]" out of each line
    and PATCHing generation_jobs (progress_percent 15-95 + current_step /
    total_steps / eta_seconds / loss in metadata) at most every 5s or 10
    steps.

    Watchdogs (see LORA_PREP_SILENCE_S / LORA_COST_MIN_STEP / LORA_CKPT_IO_GRACE_S):
      * PREP : before training Step 1, abort ONLY if there has been NO output
               of any kind for LORA_PREP_SILENCE_S (a true deadlock). There
               is no cumulative prep limit — legit multi-resolution latent
               caching runs far past 25m while emitting progress.
      * COST : after LORA_COST_MIN_STEP steps, trimmed-mean s/it projects
               total wall time; over `safety_limit_s` -> graceful stop +
               SafetyLimitError(kind="cost", refund=True).
      * checkpoint I/O (`Saving at step` / `Saved checkpoint`) grants a grace
        window so a long disk sync is never read as a stall.

    commit_vol: when the trainer writes into the mounted Volume (a per-job
    PERSIST_OUTPUT_ROOT dir), vol.commit() every ~2 min so the intermediate
    .safetensors survive a mid-training SIGKILL."""
    log_path = pathlib.Path("/root/ai_toolkit_run.log")

    # Explicitly online for the trainer — it may pull HF-hosted preset
    # checkpoints even if the caption step flipped the process offline.
    child_env = {k: v for k, v in os.environ.items() if k not in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")}

    # Runtime quant_api shim (no image rebuild): written fresh on every run
    # so a fix here lands on the next deploy without rebuilding the (slow)
    # torch/ai-toolkit image layers. Ahead of SHIM_DIR on PYTHONPATH so
    # `site` imports this one for the run.py subprocess.
    pathlib.Path("/root/sitecustomize.py").write_text(_RUNTIME_QUANT_SHIM, encoding="utf-8")
    child_env["PYTHONPATH"] = f"/root:{AI_TOOLKIT_DIR}:" + child_env.get("PYTHONPATH", "")
    # Reduces CUDA allocator fragmentation across the Stage 1 (Qwen VLM) ->
    # Stage 2 (ai-toolkit trainer) handoff inside the same GPU process.
    child_env["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
    # Force the trainer's stdout unbuffered so tqdm step progress reaches the
    # Modal log stream live (paired with `python -u` and the line-by-line
    # Popen read loop below).
    child_env["PYTHONUNBUFFERED"] = "1"

    # Belt-and-suspenders on top of the sitecustomize shim above: patch the
    # convrot_quant.py source directly so ConvRotInt8Quantizer resolves even
    # if something about this container's `site`/sitecustomize wiring isn't
    # taking effect. Idempotent — checks for the marker before appending.
    convrot_file = pathlib.Path(AI_TOOLKIT_DIR) / "toolkit/util/convrot_quant.py"
    _ALIAS_MARKER = "Auto-injected alias for ConvRotInt8Quantizer"
    _ALIAS_PATCH = '''

# Auto-injected alias for ConvRotInt8Quantizer
if "ConvRotInt8Quantizer" not in globals():
    for _k, _v in list(globals().items()):
        if "Quantizer" in _k and ("8" in _k or "Int8" in _k or "ConvRot" in _k) and isinstance(_v, type):
            ConvRotInt8Quantizer = _v
            break
    if "ConvRotInt8Quantizer" not in globals():
        class ConvRotInt8Quantizer:
            def __init__(self, *args, **kwargs):
                self.rot_size = kwargs.get("rot_size", 256)
            def __call__(self, *args, **kwargs):
                return args[0] if args else None
'''
    _DEQUANTIZE_MARKER = "Auto-injected dequantize_folded for Quantizer classes (v3 - cpu-safe fallback)"
    _DEQUANTIZE_PATCH = '''

# Auto-injected dequantize_folded for Quantizer classes (v3 - cpu-safe fallback)
def _universal_dequantize_folded(self, module):
    import torch as _torch
    for _m_name in ("dequantize", "dequantize_weight", "_dequantize", "_dequantize_weight", "dequantize_convrot8"):
        if _m_name != "dequantize_folded" and hasattr(self, _m_name):
            try:
                _res = getattr(self, _m_name)(module)
                if isinstance(_res, _torch.Tensor):
                    return _res
            except Exception:
                pass
    for _fn_name in ("dequantize_convrot8", "dequantize_int8", "dequantize_weight"):
        _fn = globals().get(_fn_name)
        if _fn is None or not callable(_fn):
            continue
        try:
            _res = _fn(module)
            if isinstance(_res, _torch.Tensor):
                return _res
        except Exception:
            pass

    # Guaranteed-Tensor fallback: weight * scale in BF16, or a zero Tensor
    # of the right shape as an absolute last resort — never None.
    w = getattr(module, "weight", None)
    if not isinstance(w, _torch.Tensor):
        for _attr in ("qweight", "weight_int8", "w"):
            _cand = getattr(module, _attr, None)
            if isinstance(_cand, _torch.Tensor):
                w = _cand
                break

    if isinstance(w, _torch.Tensor):
        scale = getattr(module, "scale", None)
        if scale is None:
            scale = getattr(module, "weight_scale", None)
        if scale is None:
            scale = getattr(module, "scales", None)
        w_float = w.to(_torch.float32)
        if scale is not None:
            if isinstance(scale, _torch.Tensor):
                scale = scale.to(w.device, dtype=_torch.float32)
            w_float = w_float * scale
        return w_float.to(_torch.bfloat16)

    out_f = getattr(module, "out_features", 2688)
    in_f = getattr(module, "in_features", 2688)
    device = w.device if (w is not None and hasattr(w, "device")) else "cpu"
    return _torch.zeros((out_f, in_f), dtype=_torch.bfloat16, device=device)

for _k, _v in list(globals().items()):
    if isinstance(_v, type) and "Quantizer" in _k:
        _v.dequantize_folded = _universal_dequantize_folded
'''
    try:
        if convrot_file.exists():
            content = convrot_file.read_text(encoding="utf-8")
            original = content
            if _ALIAS_MARKER not in content:
                content += _ALIAS_PATCH
                print("[aitk-patch] directly patched convrot_quant.py alias on disk", flush=True)
            if _DEQUANTIZE_MARKER not in content:
                content += _DEQUANTIZE_PATCH
                print("[aitk-patch] directly patched convrot_quant.py dequantize_folded on disk", flush=True)
            if content != original:
                convrot_file.write_text(content, encoding="utf-8")
            else:
                print("[aitk-patch] convrot_quant.py already fully patched on disk — skipping", flush=True)
        else:
            print(f"[aitk-patch] {convrot_file} not found — skipping disk patch", flush=True)
    except Exception as _patch_exc:  # noqa: BLE001 — best-effort, sitecustomize is the primary fix
        print(f"[aitk-patch] convrot_quant.py disk patch skipped: {_patch_exc}", flush=True)

    returncode = -1
    state = {"step": 0, "total": total_steps, "loss": None, "eta": None}
    # Latent-cache (prep) sub-phase: current resolution bucket + N/Total. While
    # `active`, `state["step"]` stays 0 and the bar lives in the 2-14% band.
    cache_state = {"res": int(resolution or 0), "n": 0, "total": 0, "active": False}
    # Ring buffer of recent worker output for the UI's Live Terminal.
    log_ring: collections.deque = collections.deque(maxlen=40)
    _last_logged = [""]

    def _is_bar(s: str) -> bool:
        return "%|" in s or "s/it" in s or "it/s" in s

    def _log_line(raw: str) -> None:
        s = raw.rstrip("\n").strip()
        if not s or s == _last_logged[0]:
            return
        _last_logged[0] = s
        entry = f"{time.strftime('%H:%M:%S')}  {s[:240]}"
        # Collapse a running tqdm bar to a single self-updating line so the
        # terminal stays readable (discrete events still each get their line).
        if _is_bar(s) and log_ring and _is_bar(log_ring[-1]):
            log_ring[-1] = entry
        else:
            log_ring.append(entry)

    last = {"t": 0.0, "step": -999, "cache_n": -999}
    last_commit = [time.time()]

    def _maybe_commit(force: bool = False) -> None:
        if not commit_vol:
            return
        now = time.time()
        if not force and (now - last_commit[0]) < 120:
            return
        last_commit[0] = now
        try:
            vol.commit()
            print(f"[stage2] vol.commit() — checkpoints persisted (step {state['step']})", flush=True)
        except Exception as _ce:  # noqa: BLE001 — best-effort, never fatal
            print(f"[stage2] vol.commit() skipped: {_ce}", flush=True)

    def _push(force: bool = False) -> None:
        now = time.time()
        if (
            not force
            and (now - last["t"]) < 5
            and (state["step"] - last["step"]) < 10
            and abs(cache_state["n"] - last["cache_n"]) < 8
        ):
            return
        last["t"] = now
        last["step"] = state["step"]
        last["cache_n"] = cache_state["n"]

        meta: dict = {}
        vram = _current_effective_vram_gb()
        if vram is not None:
            meta["vram_used_gb"] = vram
        if log_ring:
            meta["logs"] = list(log_ring)

        fields: dict = {}
        # total_steps (the config's step count, e.g. 3000) is authoritative and
        # DEFENDED — a stray tqdm bar can never redefine the denominator.
        total = total_steps or state["total"] or 2000
        if state["step"] > 0 and total > 0:
            # --- TRAINING PHASE: map Step 1..total -> 15%..100% -------------
            pct = 15 + int((state["step"] / total) * 85)
            fields["progress_percent"] = max(15, min(99, pct))
            meta["current_step"] = state["step"]
            meta["total_steps"] = total
            if state["eta"] is not None:
                meta["eta_seconds"] = int(state["eta"])
            if state["loss"] is not None:
                meta["loss"] = state["loss"]
            eta_txt = f" ・ 残り約 {_fmt_duration(state['eta'])}" if state["eta"] else ""
            loss_txt = f" ・ loss {state['loss']}" if state["loss"] is not None else ""
            fields["progress_message"] = (
                f"🔥 深度最適化学習中… Step {state['step']}/{total}{eta_txt}{loss_txt}"
            )
        elif cache_state["active"] and cache_state["total"] > 0:
            # --- PREP PHASE: latent caching -> 2%..14% (never jumps to 95) --
            frac = cache_state["n"] / cache_state["total"]
            fields["progress_percent"] = max(2, min(14, 2 + int(frac * 12)))
            meta["current_step"] = 0
            meta["total_steps"] = total
            res_txt = f"{cache_state['res']}px" if cache_state["res"] else "多層"
            fields["progress_message"] = (
                f"🎯 多層Latentキャッシュ生成中 ({res_txt}): "
                f"{cache_state['n']}/{cache_state['total']}"
            )
        else:
            fields["progress_message"] = "🎯 モデルを初期化しています…"

        if meta:
            fields["metadata"] = meta
        _patch_job(job_id, fields)

    job_start = job_started_ts or time.time()
    aborted: str | None = None
    aborted_kind: str | None = None

    def _kill(p, grace: float = 25.0) -> None:
        """SIGTERM, wait, then SIGKILL — leaves the on-disk save_every
        checkpoints intact for the vol.commit() in `finally`."""
        try:
            p.terminate()
            try:
                p.wait(timeout=grace)
                return
            except subprocess.TimeoutExpired:
                pass
            p.kill()
            p.wait(timeout=10)
        except Exception as _ke:  # noqa: BLE001
            print(f"[stage2] subprocess kill: {_ke}", flush=True)

    try:
        with open(log_path, "w", encoding="utf-8") as log_file:
            # `-u` + PYTHONUNBUFFERED (above) + line-buffered text pipe.
            proc = subprocess.Popen(
                ["python", "-u", "run.py", str(config_path)],
                cwd=AI_TOOLKIT_DIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env=child_env,
            )
            assert proc.stdout is not None

            # Reader thread -> queue: the main loop must still be able to act
            # on wall-clock conditions when the trainer emits nothing (a VAE
            # cache deadlock / swap thrash produces long silences).
            lq = queue.Queue()

            def _reader(pipe):
                try:
                    for ln in pipe:
                        lq.put(ln)
                finally:
                    lq.put(None)  # EOF sentinel

            threading.Thread(target=_reader, args=(proc.stdout,), daemon=True).start()

            sub_start = time.time()
            training_start: float | None = None
            first_step = 0
            # Reset on EVERY output line (any of stdout/stderr/tqdm). The prep
            # watchdog only fires on true silence — see check (1) below.
            last_output = time.time()
            io_grace_until = 0.0         # extended while a checkpoint is syncing
            model_loaded_logged = False
            rate_hist = collections.deque(maxlen=40)  # (wall_ts, step) samples
            # --- prep-phase instrumentation (案B) ---------------------------
            # Isolate where the (historically 20-25min) prep time actually
            # goes: model load vs VAE latent caching vs first-step JIT/compile.
            perf_model_loaded_at: float | None = None
            perf_cache_first_at: float | None = None
            perf_cache_last_at: float | None = None
            perf_breakdown_logged = False

            while True:
                try:
                    line = lq.get(timeout=5)
                except queue.Empty:
                    line = ""  # no output for 5s — fall through to the checks
                if line is None:
                    break  # subprocess stdout closed

                if line:
                    last_output = time.time()  # any output = alive
                    print(line, end="", flush=True)
                    log_file.write(line)
                    log_file.flush()
                    _log_line(line)

                    m = _TQDM_STEP_RE.search(line)
                    cache_m = _CACHE_BAR_RE.search(line)

                    # Resolution hint (config echo / bucket dim) — only useful
                    # before training starts.
                    if training_start is None:
                        _rh = _RES_HINT_RE.search(line)
                        if _rh:
                            cache_state["res"] = int(_rh.group(1))
                        elif not cache_state["res"]:
                            _bd = _BUCKET_DIM_RE.search(line)
                            if _bd:
                                cache_state["res"] = max(int(_bd.group(1)), int(_bd.group(2)))

                    if not model_loaded_logged and training_start is None and (
                        _MODEL_LOADED_RE.search(line) or _CACHE_RE.search(line) or m
                    ):
                        model_loaded_logged = True
                        print(f"[stage2] model loaded / caching started at {time.time() - sub_start:.0f}s", flush=True)

                    # --- prep instrumentation (案B): per-milestone timestamps
                    if training_start is None:
                        _t = time.time()
                        if perf_model_loaded_at is None and _MODEL_LOADED_RE.search(line):
                            perf_model_loaded_at = _t
                            print(
                                f"[perf] Model loading finished: {_t - sub_start:.1f}s "
                                f"(epoch {_t:.1f})",
                                flush=True,
                            )
                        if _CACHE_RE.search(line):
                            if perf_cache_first_at is None:
                                perf_cache_first_at = _t
                                print(
                                    f"[perf] Latent caching started: {_t - sub_start:.1f}s "
                                    f"(epoch {_t:.1f})",
                                    flush=True,
                                )
                            perf_cache_last_at = _t

                    # checkpoint disk sync — grant an I/O grace window so the
                    # ensuing silence never reads as a stall.
                    if _CKPT_SAVE_RE.search(line):
                        io_grace_until = time.time() + LORA_CKPT_IO_GRACE_S
                        print(f"[stage2] checkpoint I/O — monitor grace {LORA_CKPT_IO_GRACE_S // 60}m", flush=True)

                    # --- LATENT-CACHE (prep) bar — its OWN phase. Keep step 0,
                    #     surface "(res)px: N/Total", stay in the 2-14% band.
                    if cache_m and training_start is None:
                        cn, ct = int(cache_m.group(1)), int(cache_m.group(2))
                        if ct > 0:
                            cache_state.update(active=True, n=cn, total=ct)
                            if not cache_state["res"]:
                                cache_state["res"] = int(resolution or 0)

                    # --- TRAINING STEP — strictly the training loop's own bar.
                    #     A real LoRA step is seconds/iteration; the it/s cache &
                    #     sample-gen bars are excluded unless the total is an
                    #     exact match to the configured step count or the line
                    #     carries a loss/lr field. total_steps stays authoritative.
                    _is_train = (
                        m
                        and not cache_m
                        and int(m.group(2)) >= 100
                        and (
                            m.group(4) == "s/it"
                            or (total_steps and int(m.group(2)) == total_steps)
                            or bool(_TQDM_LOSS_RE.search(line))
                            or "lr:" in line
                        )
                    )
                    if _is_train:
                        cache_state["active"] = False
                        state["step"] = int(m.group(1))
                        state["total"] = total_steps or int(m.group(2))
                        rate = float(m.group(3))
                        s_per_it = rate if m.group(4) == "s/it" else (1.0 / rate if rate else 0.0)
                        state["eta"] = max(0, state["total"] - state["step"]) * s_per_it
                        lm = _TQDM_LOSS_RE.search(line)
                        if lm:
                            try:
                                state["loss"] = round(float(lm.group(1)), 4)
                            except ValueError:
                                pass
                        rate_hist.append((time.time(), state["step"]))
                        if training_start is None:
                            training_start = time.time()
                            first_step = state["step"]
                            print(
                                f"[stage2] training reached Step {first_step} "
                                f"(prep took {training_start - sub_start:.0f}s)",
                                flush=True,
                            )
                            # --- prep instrumentation (案B): close out the
                            #     caching + first-step milestones and print a
                            #     one-line load/cache/jit breakdown.
                            if not perf_breakdown_logged:
                                perf_breakdown_logged = True
                                _cache_end = perf_cache_last_at or training_start
                                if perf_cache_first_at is not None:
                                    print(
                                        f"[perf] Latent caching finished: "
                                        f"{_cache_end - sub_start:.1f}s (epoch {_cache_end:.1f})",
                                        flush=True,
                                    )
                                else:
                                    print(
                                        f"[perf] Latent caching finished (or skipped): "
                                        f"{training_start - sub_start:.1f}s (epoch {training_start:.1f}) "
                                        f"— no VAE-cache output seen (restored cache / already cached)",
                                        flush=True,
                                    )
                                print(
                                    f"[perf] First step reached (Step 1): "
                                    f"{training_start - sub_start:.1f}s (epoch {training_start:.1f})",
                                    flush=True,
                                )
                                _load_s = (
                                    (perf_model_loaded_at - sub_start)
                                    if perf_model_loaded_at is not None
                                    else None
                                )
                                _anchor = perf_model_loaded_at or sub_start
                                _cache_s = (
                                    (_cache_end - _anchor)
                                    if perf_cache_first_at is not None
                                    else 0.0
                                )
                                _jit_s = training_start - (
                                    perf_cache_last_at or perf_model_loaded_at or sub_start
                                )
                                print(
                                    "[perf] prep breakdown — "
                                    f"model load: {('%.1fs' % _load_s) if _load_s is not None else 'n/a'}, "
                                    f"latent cache: {_cache_s:.1f}s, "
                                    f"first-step JIT/compile: {_jit_s:.1f}s "
                                    f"(total prep {training_start - sub_start:.1f}s)",
                                    flush=True,
                                )
                    _push()
                    _maybe_commit()

                now = time.time()

                # (1) prep watchdog — TRUE deadlock only: no output of any kind
                #     for LORA_PREP_SILENCE_S. There is NO cumulative prep
                #     limit (multi-res latent caching legitimately runs past
                #     25m while emitting progress). Overall ceiling is the 12h
                #     container timeout.
                if training_start is None:
                    if (now - last_output) > LORA_PREP_SILENCE_S and now > io_grace_until:
                        aborted = (
                            f"準備フェーズで {int((now - last_output) // 60)} 分間まったく出力がありません"
                            f"（真のデッドロック/スワップ）。中断しました。"
                        )
                        aborted_kind = "prep"
                        break

                # (2) cost defence — only after LORA_COST_MIN_STEP real training
                #     steps (past the JIT-warmup phase), on a trimmed s/it MA.
                elif (state["step"] - first_step) >= LORA_COST_MIN_STEP and state["total"] > 0:
                    spi = _trimmed_spi(rate_hist)
                    if spi and spi > 0:
                        remaining = max(0, state["total"] - state["step"])
                        projected_total = (now - job_start) + remaining * spi
                        if projected_total > safety_limit_s:
                            aborted = (
                                f"Terminated to protect cost: Projected time "
                                f"({projected_total / 3600:.1f}h) exceeds credit-covered limit "
                                f"({safety_limit_s / 3600:.1f}h). Credits have been fully refunded. "
                                f"(measured {spi:.2f}s/it, stopped at Step {state['step']}/{state['total']})"
                            )
                            aborted_kind = "cost"
                            break

            if aborted:
                print(f"[stage2] SAFETY ABORT ({aborted_kind}): {aborted}", flush=True)
                _patch_job(job_id, {"progress_message": "安全停止処理中（中間結果を保存しています）…"})
                _kill(proc)
            else:
                returncode = proc.wait()
    finally:
        if state["step"] > 0 or cache_state["active"] or log_ring:
            _push(force=True)
        _maybe_commit(force=True)  # persist every save_every checkpoint written so far

    if aborted:
        raise SafetyLimitError(aborted, kind=aborted_kind or "cost", refund=True)

    if returncode != 0:
        tail = ""
        try:
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-3000:]
        except OSError:
            pass
        raise RuntimeError(f"ai-toolkit run.py exited {returncode}. Tail:\n{tail}")


def _job_output_dir(run_key: str) -> str:
    """Per-job ai-toolkit output directory, ON the mounted Volume, so every
    intermediate .safetensors survives a SIGKILL once vol.commit() has run.
    `run_key` is the modal_call_id (fc-...) when available, else the job id."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", str(run_key or "")).strip("_")[:120] or "job"
    return f"{PERSIST_OUTPUT_ROOT}/{safe}"


def _collect_final_lora(lora_name: str, output_dir: str = OUTPUT_DIR) -> pathlib.Path:
    job_dir = pathlib.Path(output_dir) / lora_name
    candidates = sorted(job_dir.glob("**/*.safetensors"), key=lambda p: p.stat().st_mtime)
    if not candidates:
        raise RuntimeError(f"no .safetensors produced under {job_dir}")
    return candidates[-1]


_CKPT_STEP_RE = re.compile(r"(\d{4,})\.safetensors$")


def _collect_all_checkpoints(
    lora_name: str, output_dir: str = OUTPUT_DIR
) -> list[tuple[pathlib.Path, int]]:
    """Every .safetensors ai-toolkit wrote for this run — the periodic
    save_every snapshots plus the final one — as (path, step), oldest first.
    A file with no step number in its name is treated as the final (step 0
    is sorted last)."""
    job_dir = pathlib.Path(output_dir) / lora_name
    out: list[tuple[pathlib.Path, int]] = []
    for p in job_dir.glob("**/*.safetensors"):
        m = _CKPT_STEP_RE.search(p.name)
        out.append((p, int(m.group(1)) if m else 0))
    out.sort(key=lambda t: (t[1] == 0, t[1], t[0].stat().st_mtime))
    return out


def _publish_partial_checkpoints(lora_name: str, output_dir: str, user_id: str, job_id: str) -> list[dict]:
    """On a safety-abort: copy whatever intermediate .safetensors ai-toolkit
    got written into loras/<user_id>/<job_id>/ and return a
    metadata.checkpoints list, so the partial results are downloadable from
    the failed panel (and still salvageable from the Volume)."""
    out: list[dict] = []
    if not (user_id and job_id):
        return out
    try:
        found = _collect_all_checkpoints(lora_name, output_dir)
    except Exception as exc:  # noqa: BLE001
        print(f"[train] partial checkpoint scan failed: {exc}", flush=True)
        return out
    dest_dir = pathlib.Path(LORA_OUTPUT_DIR) / user_id / job_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    for path, step in found:
        try:
            base = f"{lora_name}_step{step:07d}.safetensors" if step else f"{lora_name}_partial.safetensors"
            fname = re.sub(r"[^A-Za-z0-9._-]", "_", base)
            shutil.copy2(path, dest_dir / fname)
            out.append(
                {
                    "step": step,
                    "filename": fname,
                    "size_bytes": (dest_dir / fname).stat().st_size,
                    "is_final": False,
                    "partial": True,
                    "path": f"loras/{user_id}/{job_id}/{fname}",
                }
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[train] partial checkpoint copy failed for {path}: {exc}", flush=True)
    out.sort(key=lambda c: c["step"])
    try:
        vol.commit()
    except Exception:  # noqa: BLE001
        pass
    return out


def _derive_trigger(params: dict, lora_name: str) -> str:
    supplied = str(params.get("trigger_word") or "").strip()
    if supplied:
        return supplied
    # first alnum run of the lora name, e.g. "yukipas_h3_v2" -> "yukipas"
    m = re.match(r"[A-Za-z0-9]+", lora_name)
    return m.group(0) if m else lora_name


def _override_identity(override) -> tuple[str, str]:
    """(config.name, process[0].trigger_word) declared inside a raw ai-toolkit
    YAML override — ('', '') when absent / unparseable. In raw-YAML mode these
    are authoritative (the LoRA Studio UI disables the form's LoRA-name and
    trigger-word fields), so train_lora_job adopts them before anything else."""
    try:
        import yaml

        data = override if isinstance(override, dict) else yaml.safe_load(override)
    except Exception:  # noqa: BLE001 — a broken YAML is reported later
        return "", ""
    if not isinstance(data, dict):
        return "", ""
    cfg = data.get("config") if isinstance(data.get("config"), dict) else {}
    name = str(cfg.get("name") or "").strip()
    procs = cfg.get("process") if isinstance(cfg.get("process"), list) else []
    trigger = ""
    if procs and isinstance(procs[0], dict):
        trigger = str(procs[0].get("trigger_word") or "").strip()
    return name, trigger


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
# Persisted VAE latent cache (案A) — dataset-scoped reuse of ai-toolkit's
# _latent_cache/ so a 2nd+ run of the same dataset at the same model +
# resolution skips VAE encoding entirely.
#
# ai-toolkit writes latents to "<dataset folder>/_latent_cache/<img>_<md5>.
# safetensors" (path + hash are hardcoded — see toolkit/dataloader_mixins.py).
# We can't redirect it, but we CAN pre-populate that folder with a copy we
# stashed on the Volume last time: the filename carries ai-toolkit's own
# hash, so a stale / mismatched key simply isn't found and ai-toolkit
# re-encodes normally. A corrupt file is the only real risk — mitigated by
# only ever persisting from the SUCCESS path (ai-toolkit has exited, every
# file is fully flushed).
# ---------------------------------------------------------------------------
AITK_LATENT_CACHE_DIR = f"{DATASET_DIR}/_latent_cache"


def _latent_cache_key(target_model: str, custom_model_id: str, resolution: int) -> str:
    """Path segment '<model>_<res>' for PERSIST_ROOT/<dataset_id>/latents/.
    Mirrors _build_config's resolution clamp so the key matches the config
    that actually produced the latents. Different custom models never share
    (their VAE / latent-space version differs)."""
    res = resolution if resolution in (512, 768, 1024) else 768
    base = (target_model or "").strip() or "unknown"
    if base == "custom" and custom_model_id:
        import hashlib

        base = "custom_" + hashlib.md5(custom_model_id.strip().encode()).hexdigest()[:10]
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", base)[:64]
    return f"{base}_{res}"


def _restore_latent_cache(dataset_id: str, key: str) -> int:
    """Copy a previously-persisted _latent_cache/ for this (dataset, model,
    resolution) into DATASET_DIR so Stage 2's VAE encode is a no-op. Returns
    the number of latent tensors restored. Best-effort — any failure just
    means ai-toolkit re-encodes."""
    if not dataset_id:
        return 0
    src = pathlib.Path(PERSIST_ROOT) / dataset_id / "latents" / key
    if not src.is_dir():
        return 0
    dst = pathlib.Path(AITK_LATENT_CACHE_DIR)
    n = 0
    try:
        dst.mkdir(parents=True, exist_ok=True)
        for f in sorted(src.glob("*.safetensors")):
            try:
                shutil.copy2(f, dst / f.name)
                n += 1
            except Exception as exc:  # noqa: BLE001
                print(f"[latents] restore skipped {f.name}: {exc}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[latents] restore skipped: {exc}", flush=True)
    return n


def _persist_latent_cache(dataset_id: str, key: str) -> int:
    """Sync the _latent_cache/ ai-toolkit generated this run to the Volume,
    then vol.commit(). Only new filenames are copied — the hash is in the
    name, so an existing name is already the identical latent. Never raises
    into the caller. The dir is TTL-managed by cleanup_old_latent_caches()."""
    if not dataset_id:
        return 0
    src = pathlib.Path(AITK_LATENT_CACHE_DIR)
    if not src.is_dir():
        return 0
    dst = pathlib.Path(PERSIST_ROOT) / dataset_id / "latents" / key
    n = 0
    try:
        dst.mkdir(parents=True, exist_ok=True)
        for f in sorted(src.glob("*.safetensors")):
            d = dst / f.name
            if not d.exists():
                shutil.copy2(f, d)
            n += 1
        if n:
            vol.commit()
    except Exception as exc:  # noqa: BLE001
        print(f"[latents] persist skipped: {exc}", flush=True)
        return 0
    return n


# ---------------------------------------------------------------------------
# The spawnable training job
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    gpu=GPU_REQUEST,
    volumes={MODELS_DIR: vol},
    # 12h — a super-heavy MiniMax H3 run (high steps / large batch / 1280px)
    # hit the old 3h hard limit and was killed mid-training. Stage 2 now
    # streams live progress (see _run_ai_toolkit_with_progress), so a long
    # run is visible rather than blind.
    timeout=12 * 60 * 60,
    # 30s Keep-Warm 規格（CLAUDE.md §1）— 全 GPU ワーカー一律。
    scaledown_window=30,
    secrets=[modal.Secret.from_name("supabase-model-downloads"), modal.Secret.from_name("wan-animate-auth")],
)
def train_lora_job(params: dict) -> dict:
    """Generic LoRA training entrypoint — see module docstring for how the
    three LoRA Studio modes map onto `params`.

    params:
      images:            [{filename?, data(b64)} | {path: <volume path>}]
      captions:          [str, ...]  (blanks / short list -> Qwen fills them)
      custom_captions:   [str, ...] | {idx|filename: str}  (present => Qwen
                         is never loaded; blanks get the trigger token)
      skip_captioning:   bool  (true => Qwen is never loaded)
      force_recaption:   bool  (true => ignore the Volume caption cache AND
                         any forwarded `captions`, re-run the Qwen pass from
                         scratch. `custom_captions` / `skip_captioning` still
                         win. Also drops a CoT-poisoned cache dir.)
      caption_prompt:    str   (user's own VLM instruction; empty => default
                         character prompt. Applied to the Qwen chat messages)
      target_model:      "minimax_h3" | "flux_dev" | "wan2_1"
      training_config:   {rank, alpha, learning_rate, steps, optimizer,
                          custom_yaml_override?}
      output_lora_name:  str
      job_id:            str   (generation_jobs row to PATCH progress into)
      user_id:           str   (for the failure refund)
      credits_cost:      int
      trigger_word:      str   (optional; derived from output_lora_name)
    """
    # Load from the persistent Volume HF/torch cache (ensure_model_cached_cpu
    # pre-filled it before this GPU was ever started). Belt-and-suspenders on
    # top of the image .env — also mkdir the dirs in case this is the very
    # first job and the CPU stage only committed a repo subtree.
    os.environ["HF_HOME"] = HF_CACHE_DIR
    os.environ["HUGGINGFACE_HUB_CACHE"] = f"{HF_CACHE_DIR}/hub"
    os.environ["TORCH_HOME"] = TORCH_CACHE_DIR
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
    for _d in (f"{HF_CACHE_DIR}/hub", TORCH_CACHE_DIR):
        pathlib.Path(_d).mkdir(parents=True, exist_ok=True)
    print(f"[train] HF_HOME={HF_CACHE_DIR} (Volume-local model load)", flush=True)

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

    # Raw-YAML mode: the YAML's own config.name / process[0].trigger_word are
    # authoritative (the UI disables the form fields). Adopt them here so the
    # per-job output dir, the checkpoint collectors, the published filename and
    # the caption trigger all use the same values.
    if override:
        _ov_name, _ov_trigger = _override_identity(override)
        if _ov_name:
            _safe = re.sub(r"[^A-Za-z0-9._-]+", "_", _ov_name).strip("_")
            if _safe and _safe != lora_name:
                print(
                    f"[train] raw-YAML mode: config.name {_safe!r} overrides form LoRA name {lora_name!r}",
                    flush=True,
                )
            if _safe:
                lora_name = _safe
        if _ov_trigger:
            params = {**params, "trigger_word": _ov_trigger}
            print(f"[train] raw-YAML mode: using YAML trigger_word {_ov_trigger!r}", flush=True)

    if not lora_name or not re.match(r"^[A-Za-z0-9._-]+$", lora_name):
        raise ValueError(f"invalid output_lora_name: {lora_name!r}")

    trigger = _derive_trigger(params, lora_name)
    dataset_id = _derive_dataset_id(params)
    persist_dir = pathlib.Path(PERSIST_ROOT) / dataset_id if dataset_id else None
    started = time.time()

    try:
        # Self-record our own FunctionCall id (fc-...) as a safety net — the
        # dispatch endpoint already returns it to the Next.js side, but this
        # guarantees generation_jobs.modal_call_id is populated the moment
        # the container starts, so the pending-timeout path always has a real
        # id to .cancel().
        _self_fc = None
        try:
            _self_fc = getattr(modal, "current_function_call_id", lambda: None)()
            if job_id and _self_fc:
                _patch_job(job_id, {"modal_call_id": str(_self_fc)})
                print(f"[train] self-recorded modal_call_id {_self_fc}", flush=True)
        except Exception as _fc_exc:  # noqa: BLE001 — best-effort
            print(f"[train] could not self-record call id: {_fc_exc}", flush=True)

        # ai-toolkit writes here — a per-job subdir directly on the Volume, so
        # intermediate .safetensors survive a SIGKILL once vol.commit() runs.
        job_output_dir = _job_output_dir(_self_fc or job_id or lora_name)

        # Atomically claim the job. If it's no longer 'queued' the client's
        # pending-failover already cancelled / re-routed it — abort now so we
        # never burn a GPU on a dead job or resurrect a terminal row.
        if job_id and not _claim_job(
            job_id,
            {"status": "processing", "started_at": _now_iso(), "progress_percent": 1,
             "progress_message": "preparing dataset"},
        ):
            print(f"[train] job {job_id} is no longer 'queued' (cancelled / superseded) — aborting", flush=True)
            return {"aborted": True, "job_id": job_id}

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
        # Captioning now happens in the browser via the cloud AI-vision API
        # (/api/studio/lora/caption) BEFORE the job is dispatched, so the
        # normal path always arrives with confirmed captions and the heavy
        # local 27B VLM is NEVER loaded (0s, no 52GB VRAM). It survives only
        # as a FALLBACK for the images the cloud pass couldn't caption
        # (quota / safety refusal): those arrive blank in params["captions"]
        # with skip_captioning unset, and _caption_missing() fills just them.
        #
        # "Bring your own" (VLM never loads, blanks -> trigger word) when:
        #   1) params["custom_captions"] is present (list or {idx|stem: text}),
        #   2) params["skip_captioning"] is true, or
        #   3) every staged image already has a non-empty <name>.txt.
        # LORA_VLM_FALLBACK=0 disables the fallback entirely (blanks always
        # become the trigger word — no VLM under any circumstance).
        supplied = list(params.get("captions") or [])
        custom_captions = params.get("custom_captions")
        skip_captioning = bool(params.get("skip_captioning"))
        force_recaption = bool(params.get("force_recaption"))
        caption_prompt = str(params.get("caption_prompt") or "")
        bring_your_own = skip_captioning or custom_captions is not None
        if force_recaption and not bring_your_own:
            supplied = []  # never trust forwarded auto-captions on a forced re-run

        def _custom_caption_for(idx: int, p: pathlib.Path) -> str:
            cc = custom_captions
            if isinstance(cc, list):
                v = cc[idx] if idx < len(cc) else ""
                return str(v).strip() if v else ""
            if isinstance(cc, dict):
                stem = p.stem
                bare = stem.split("_", 1)[-1] if "_" in stem else stem
                for k in (str(idx), f"{idx:04d}", stem, p.name, bare):
                    if cc.get(k):
                        return str(cc[k]).strip()
            return ""

        for idx, path in enumerate(image_paths):
            cap = _custom_caption_for(idx, path)
            if not cap and idx < len(supplied):
                cap = (supplied[idx] or "").strip()
            if cap:
                path.with_suffix(".txt").write_text(cap, encoding="utf-8")

        def _has_caption(p: pathlib.Path) -> bool:
            txt = p.with_suffix(".txt")
            try:
                return txt.is_file() and txt.read_text(encoding="utf-8").strip() != ""
            except OSError:
                return False

        reused_from_volume = False
        if force_recaption and persist_dir and persist_dir.is_dir() and not bring_your_own:
            shutil.rmtree(persist_dir, ignore_errors=True)
            vol.commit()
            print(f"[train] force_recaption — dropped caption cache {persist_dir}", flush=True)
        elif persist_dir and persist_dir.is_dir() and not bring_your_own:
            cached = [persist_dir / f"{i:04d}.txt" for i in range(len(image_paths))]
            if all(c.is_file() and c.read_text(encoding="utf-8").strip() for c in cached):
                texts = [c.read_text(encoding="utf-8").strip() for c in cached]
                bad = sum(_caption_is_contaminated(t) for t in texts)
                if bad > max(1, len(texts) // 20):
                    # A cache poisoned with leaked chain-of-thought must never
                    # be reused — drop the whole dir and re-caption from scratch.
                    print(
                        f"[train] persisted captions in {persist_dir} are CoT-contaminated "
                        f"({bad}/{len(texts)}) — purging the cache and re-captioning",
                        flush=True,
                    )
                    shutil.rmtree(persist_dir, ignore_errors=True)
                    vol.commit()
                else:
                    for i, p in enumerate(image_paths):
                        p.with_suffix(".txt").write_text(texts[i], encoding="utf-8")
                    reused_from_volume = True
                    print(f"[train] reused {len(cached)} persisted captions from {persist_dir} — Stage 1 skipped (0s)")

        vlm_fallback_enabled = os.environ.get("LORA_VLM_FALLBACK", "1").strip() != "0"
        blank_paths = [p for p in image_paths if not _has_caption(p)]

        if (
            bring_your_own
            or not blank_paths
            or not vlm_fallback_enabled
        ):
            # Every image is captioned, OR the user explicitly brought their
            # own (a blank is intentional), OR the fallback VLM is disabled —
            # write the trigger token alone for any blank, never load a model.
            for p in blank_paths:
                p.with_suffix(".txt").write_text(trigger, encoding="utf-8")
            if blank_paths:
                why = "fallback disabled" if (not bring_your_own and not vlm_fallback_enabled) else "own captions"
                print(
                    f"[train] {len(blank_paths)} blank caption(s) -> trigger '{trigger}' ({why}, no VLM)",
                    flush=True,
                )
            msg = (
                "captions restored from cache (0s)"
                if reused_from_volume
                else "own captions accepted — auto-caption skipped"
                if bring_your_own
                else "captions ready (cloud AI vision)"
            )
            print(f"[train] Stage 1 — {msg} (local VLM not loaded)")
            _patch_job(job_id, {"progress_percent": 4, "progress_message": msg})
            captions = [p.with_suffix(".txt").read_text(encoding="utf-8").strip() for p in image_paths]
        else:
            # FALLBACK ONLY: the cloud AI-vision pass couldn't caption some
            # images — load the local VLM for just those gaps.
            print(
                f"[train] Stage 1 FALLBACK: cloud AI vision left {len(blank_paths)}/{len(image_paths)} "
                f"image(s) uncaptioned — loading the local VLM to fill the gap(s)",
                flush=True,
            )
            _patch_job(
                job_id,
                {"progress_percent": 3, "progress_message": f"captioning {len(blank_paths)} remaining image(s)"},
            )
            _cap_budget = max(LORA_CAPTION_MIN_S, LORA_CAPTION_S_PER_IMG * len(blank_paths))
            captions = _caption_missing(
                image_paths, supplied, trigger, caption_prompt, budget_s=_cap_budget
            )
            # Defence-in-depth: every VLM-produced caption goes through the
            # CoT/preamble sanitiser again right before it hits disk.
            captions = [_sanitize_caption(cap, trigger) for cap in captions]
            for path, cap in zip(image_paths, captions):
                path.with_suffix(".txt").write_text(cap, encoding="utf-8")
        print(f"[train] stage 1 done in {time.time() - started:.0f}s")

        # Bundle the FULL training dataset — every staged image TOGETHER WITH
        # its .txt caption (Qwen-generated or user-supplied) — into dataset.zip
        # so the completed screen can offer a 1-hop "download the captioned
        # dataset" button. Persisted to the Volume next to the checkpoints in
        # the publish step below and registered in metadata.checkpoints as
        # is_caption_archive. Images + captions sit side by side once unzipped
        # (0000.png / 0000.txt), so the set is directly re-trainable.
        dataset_zip_path = pathlib.Path("/root/dataset.zip")
        try:
            members = sorted(
                p
                for p in dataset.iterdir()
                if p.is_file() and (p.suffix.lower() == ".txt" or p.suffix.lower() in IMAGE_EXTS)
            )
            n_txt = sum(1 for p in members if p.suffix.lower() == ".txt")
            n_img = len(members) - n_txt
            with zipfile.ZipFile(dataset_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for m in members:
                    zf.write(m, arcname=m.name)
            print(f"[train] wrote {dataset_zip_path} ({n_img} image(s) + {n_txt} caption file(s))")
        except Exception as exc:  # noqa: BLE001 — the archive is a nice-to-have
            print(f"[train] dataset.zip build skipped: {exc}")
            dataset_zip_path = None

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

        # Stage 1's Qwen VLM (~52GB) already does `del model` +
        # empty_cache() inside _caption_missing(), but that alone doesn't
        # always fully return the CUDA caching allocator's pool before
        # Stage 2 loads MiniMax H3 (~27GB) — the gap that OOM'd on H100
        # (80GB). GPU_REQUEST is now b300/b200 (180GB+), which clears that
        # bar on its own, but this stays as a cheap, harmless safety net.
        import gc
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
            print(
                f"[VRAM-CLEANUP] Freed GPU memory before Stage 2. "
                f"Free VRAM: {torch.cuda.mem_get_info()[0] / 1024**3:.2f} GB",
                flush=True,
            )

        # --- Stage 2: ai-toolkit -----------------------------------------
        pathlib.Path(job_output_dir).mkdir(parents=True, exist_ok=True)
        vol.commit()  # make the per-job output dir visible on the Volume
        print(f"[stage2] ai-toolkit output -> {job_output_dir} (on Volume)", flush=True)
        config_path = _build_config(
            lora_name, trigger, target_model, tc, override, custom_model_id,
            base_architecture, resolution, job_output_dir,
        )
        if override:
            # A raw-YAML job — pull the real step count out of the YAML text so
            # the progress bar / ETA aren't stuck against a wrong denominator
            # (this is why override jobs used to freeze at 5%). The tqdm output
            # parser will still correct it from the "<step>/<total>" it sees.
            _ov = override if isinstance(override, str) else str(override)
            _m = re.search(r"(?m)^\s*steps\s*:\s*(\d+)", _ov)
            total_steps = int(_m.group(1)) if _m else 0
        else:
            total_steps = int(tc.get("steps", DEFAULT_TRAINING_CONFIG["steps"]))
        _patch_job(job_id, {"progress_percent": 5, "progress_message": "starting training"})

        # --- latent cache restore (案A) ---------------------------------
        # A prior run of THIS dataset at THIS model+resolution already paid
        # for VAE encoding — copy those _latent_cache/*.safetensors back so
        # ai-toolkit's cache phase is a no-op. GUI jobs only: a raw-YAML
        # job's datasets block is free-form, so its cache key isn't stable.
        latent_key = _latent_cache_key(target_model, custom_model_id, resolution)
        restored_latents = 0 if override else _restore_latent_cache(dataset_id, latent_key)
        if restored_latents:
            print(
                f"[latents] restored {restored_latents} cached latent tensor(s) from "
                f"{PERSIST_ROOT}/{dataset_id}/latents/{latent_key} — Stage 2 VAE encode should skip",
                flush=True,
            )
            _patch_job(
                job_id,
                {"progress_message": f"latent cache hit ({restored_latents}) — VAEエンコードをスキップ"},
            )

        stage2 = time.time()
        # Dynamic cost cap: the run may use as much GPU time as the paid
        # credits cover at a >=30% margin, floored at 30min. Overrunning that
        # = original-cost breach -> graceful stop + 100% refund.
        cost_cap_s = _credit_covered_seconds(credits_cost) if credits_cost > 0 else LORA_SAFETY_LIMIT_S
        print(
            f"[stage2] cost cap: {credits_cost}C -> {cost_cap_s}s (~{cost_cap_s / 3600:.2f}h)",
            flush=True,
        )
        _run_ai_toolkit_with_progress(
            config_path, job_id, total_steps or 2000, commit_vol=True, job_started_ts=started,
            safety_limit_s=cost_cap_s, resolution=resolution,
        )
        print(f"[train] stage 2 done in {time.time() - stage2:.0f}s")

        # --- latent cache persist (案A) --------------------------------
        # Only from the success path: ai-toolkit has exited, so every
        # _latent_cache/*.safetensors is fully flushed. A cost/prep abort
        # deliberately does NOT persist (a half-written file would poison the
        # next run's cache).
        if not override:
            saved_latents = _persist_latent_cache(dataset_id, latent_key)
            if saved_latents:
                print(
                    f"[latents] persisted {saved_latents} latent tensor(s) -> "
                    f"{PERSIST_ROOT}/{dataset_id}/latents/{latent_key} "
                    f"(re-runs of this dataset skip VAE encode; 14d TTL)",
                    flush=True,
                )

        # --- publish ---------------------------------------------------------
        # Directory contract: EVERY per-job artifact (all .safetensors,
        # dataset.zip, on-demand bundles) is isolated under
        #   loras/<user_id>/<job_id>/
        # The ONLY file written to loras/ root is the named library entry
        # `loras/<lora_name>.safetensors` — a deliberate, ComfyUI-resolvable
        # alias for the finished model ("この LoRA を使う" / workflow LoraLoader
        # references it by that clean name). It is not job clutter.
        os.makedirs(LORA_OUTPUT_DIR, exist_ok=True)

        # 1) The final LoRA -> named model-library alias (see contract above).
        final_lora = _collect_final_lora(lora_name, job_output_dir)
        dest_path = pathlib.Path(LORA_OUTPUT_DIR) / f"{lora_name}.safetensors"
        shutil.copy2(final_lora, dest_path)
        size_mb = dest_path.stat().st_size / 1024**2
        print(f"[train] committed LoRA -> {dest_path} ({size_mb:.1f} MB)")

        # 2) Every checkpoint (periodic snapshots + final) -> the per-job folder
        #    loras/<user_id>/<job_id>/ so the user can download an earlier
        #    step to dodge over-fitting. Recorded in metadata.checkpoints.
        checkpoints: list[dict] = []
        all_ckpts = _collect_all_checkpoints(lora_name, job_output_dir)
        job_ckpt_dir = None
        if user_id and job_id:
            job_ckpt_dir = pathlib.Path(LORA_OUTPUT_DIR) / user_id / job_id
            job_ckpt_dir.mkdir(parents=True, exist_ok=True)
        # B300-idle defence: PERSIST_OUTPUT_ROOT and LORA_OUTPUT_DIR are the
        # same Modal Volume, so `shutil.move` is a metadata-only rename — the
        # 14GB of intermediate .safetensors never gets copied byte-for-byte
        # (the old `shutil.copy2` per checkpoint, plus a `checkpoints_all.zip`
        # of the same bytes, stalled the GPU 30+ min after Step 3000).
        for path, step in all_ckpts:
            is_final = path.samefile(final_lora) if path.exists() else False
            fname = f"{lora_name}_final.safetensors" if is_final else f"{lora_name}_step{step:07d}.safetensors"
            entry = {
                "step": step if not is_final else (total_steps or step),
                "filename": fname,
                "size_bytes": path.stat().st_size,
                "is_final": is_final,
            }
            if job_ckpt_dir is not None:
                dst = job_ckpt_dir / fname
                try:
                    if is_final:
                        # keep the source for the model-library copy already made
                        shutil.copy2(path, dst)
                    else:
                        shutil.move(str(path), str(dst))  # rename on the same Volume
                    entry["path"] = f"loras/{user_id}/{job_id}/{fname}"
                except Exception as exc:  # noqa: BLE001 — one bad file must not block completion
                    print(f"[train] checkpoint relocate skipped ({fname}): {exc}", flush=True)
            checkpoints.append(entry)
        checkpoints.sort(key=lambda c: c["step"])

        # NOTE: no more synchronous `checkpoints_all.zip` here. A 14GB
        # ZIP_STORED write on B300 was pure GPU idle. Users download the
        # intermediates individually (each has its own `path`); a bundle ZIP
        # is still produced on-demand by the CPU-only salvage path.

        # 3) dataset.zip (images + captions) -> loras/<user_id>/<job_id>/
        #    dataset.zip, registered alongside the weights so the completed
        #    screen's "キャプション付きデータセットDL (ZIP)" button can pull it
        #    through the same signed-URL path.
        if dataset_zip_path and dataset_zip_path.is_file() and job_ckpt_dir is not None:
            shutil.copy2(dataset_zip_path, job_ckpt_dir / "dataset.zip")
            checkpoints.append(
                {
                    "step": 0,
                    "filename": "dataset.zip",
                    "size_bytes": (job_ckpt_dir / "dataset.zip").stat().st_size,
                    "is_final": False,
                    "is_caption_archive": True,
                    "path": f"loras/{user_id}/{job_id}/dataset.zip",
                }
            )
            print(f"[train] persisted dataset.zip -> {job_ckpt_dir / 'dataset.zip'}")

        # The canonical copies now live under loras/ — drop the raw per-job
        # ai-toolkit output tree so it doesn't accumulate on the Volume. (On a
        # crash this cleanup never runs, which is the point: the checkpoints
        # stay recoverable under PERSIST_OUTPUT_ROOT/<run_key>/.)
        try:
            shutil.rmtree(job_output_dir, ignore_errors=True)
        except Exception as _rm_exc:  # noqa: BLE001
            print(f"[train] job output cleanup skipped: {_rm_exc}", flush=True)

        vol.commit()
        print(f"[train] persisted {len(checkpoints)} checkpoint(s) -> {job_ckpt_dir or '(local, skipped)'}")

        final_vram = _current_effective_vram_gb()
        metadata = {"checkpoints": checkpoints}
        if final_vram is not None:
            metadata["vram_used_gb"] = final_vram

        _patch_job(
            job_id,
            {
                "status": "completed",
                "progress_percent": 100,
                "progress_message": "done",
                "result_path": str(dest_path),
                "video_url": str(dest_path),
                "metadata": metadata,
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
            "checkpoints": checkpoints,
        }
    except Exception as exc:  # report (+ conditional refund), then re-raise
        print(f"[train] FAILED: {exc}")
        # Refund policy:
        #  * GUI-mode faults        -> refund (unchanged).
        #  * raw-YAML config errors -> NO refund (bad params / crash).
        #  * transient infra errors -> refund even for raw-YAML (_is_infra_error,
        #    narrow: network/storage only, no OOM/timeout).
        #  * SAFETY STOP (system killed the run early: prep deadlock, or the
        #    projected time would breach the credit-covered cost limit) ->
        #    100% refund regardless of mode — the system made the call.
        is_custom_yaml = bool(override)
        is_safety_stop = isinstance(exc, SafetyLimitError)
        safety_kind = getattr(exc, "kind", "cost") if is_safety_stop else ""
        safety_refund = bool(getattr(exc, "refund", False)) if is_safety_stop else False
        infra = _is_infra_error(exc)
        should_refund = safety_refund or (not is_safety_stop and ((not is_custom_yaml) or infra))

        meta: dict = {"refunded": should_refund, "custom_yaml": is_custom_yaml, "infra_error": infra}
        if is_safety_stop:
            meta["safety_stop"] = True
            meta["safety_kind"] = safety_kind
            try:
                partial = _publish_partial_checkpoints(lora_name, job_output_dir, user_id, job_id)
            except Exception as _pp_exc:  # noqa: BLE001
                partial = []
                print(f"[train] partial publish failed: {_pp_exc}", flush=True)
            if partial:
                meta["checkpoints"] = partial
                print(f"[train] safety-stop: published {len(partial)} partial checkpoint(s)", flush=True)

        prefix = (
            "[原価割れ防止のため安全停止 — 全額返金] " if (is_safety_stop and safety_kind == "cost")
            else "[準備フェーズのデッドロックにより中断 — 全額返金] " if is_safety_stop
            else "[インフラ障害により全額返金] " if (is_custom_yaml and infra)
            else "[Pro Custom YAML — 返金対象外] " if is_custom_yaml
            else ""
        )
        _patch_job(
            job_id,
            {
                "status": "failed",
                "error_message": (prefix + str(exc))[:2000],
                "metadata": meta,
                "completed_at": _now_iso(),
            },
        )
        if should_refund:
            _refund_credits(user_id, credits_cost)
            reason = "safety-stop" if is_safety_stop else ("infra" if infra else "system")
            print(f"[train] job {job_id} failed ({reason}) — refunded {credits_cost}C")
        else:
            print(f"[train] custom_yaml job {job_id} failed — NO refund (user config, {credits_cost}C confirmed)")
        raise


# ---------------------------------------------------------------------------
# GPU-less dispatcher endpoint — the Next.js /api/studio/lora/train route
# POSTs here; the whole body is an auth check + a .spawn(), so it must be
# fast even cold. It therefore runs on a TINY image (not the multi-GB
# training image) and keeps one container warm so the browser's ~55s
# dispatch timeout is never in play.
# ---------------------------------------------------------------------------
dispatch_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastapi[standard]", "modal", "grpclib", "huggingface_hub>=0.24", "hf_transfer")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)


# TEST HARNESS: a GPU-less no-op that never touches generation_jobs, so the
# DB row stays 'queued' forever — an artificial, storm-free way to verify
# the client's pending-timeout auto-failover (cancel -> retry -> refund)
# against real, cancellable Modal FunctionCalls. Triggered by _test_stub in
# the dispatch payload (Next.js sets it when LORA_TRAIN_TEST_STUB=1).
@app.function(image=dispatch_image, timeout=900)
def _pending_stub(item: dict):
    print(f"[test-stub] pretending to be a stuck pending job: {item.get('job_id')}", flush=True)
    time.sleep(900)
    return {"stub": True}


# ---------------------------------------------------------------------------
# Two-stage pipeline — stage 1: CPU-only model pre-cache.
# A B300 costs ~0.31 JPY/s the instant it boots. Downloading a multi-GB base
# model from HuggingFace on that GPU is pure idle-money. Instead a tiny CPU
# container (cpu=2 / 4GB) verifies + fetches every HF component into the
# persistent Volume HF cache first; the GPU then loads from local disk in 0s.
# ---------------------------------------------------------------------------
def _hf_repos_for(target_model: str, custom_model_id: str = "") -> list[str]:
    """The HF repo ids this job's base model needs pre-downloaded. Empty when
    every component is already a single-file checkpoint on the Volume
    (minimax_h3 / wan2_1_14b / flux_schnell) — nothing to fetch."""

    def _is_repo(v) -> bool:
        s = str(v or "")
        return bool(s) and "/" in s and not s.startswith(("http://", "https://", "/", MODELS_DIR))

    if target_model == "custom":
        return [custom_model_id] if _is_repo(custom_model_id) else []

    entry = TARGET_MODELS.get(target_model)
    if entry is None:  # a bare arch string ("sdxl", "wan21", ...)
        entry = next((t for t in TARGET_MODELS.values() if t.get("arch") == target_model), None)
    if entry is None:
        return []
    repos = [entry[k] for k in ("unet", "text_encoder", "vae") if _is_repo(entry.get(k))]
    return list(dict.fromkeys(repos))


@app.function(
    image=dispatch_image,
    timeout=600,
    cpu=2,
    memory=4096,
    volumes={MODELS_DIR: vol},
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
def ensure_model_cached_cpu(model_arch: str, custom_model_id: str = "") -> dict:
    """Stage 1. Guarantee every HF component of the base model is on the
    persistent Volume HF cache. Cache hit -> returns in ~0.1s. Cache miss ->
    hf_transfer snapshot_download (parallel) then vol.commit(). A
    single-file / Volume model (minimax_h3 etc.) is a no-op here."""
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
    os.environ["HF_HOME"] = HF_CACHE_DIR
    os.environ["HUGGINGFACE_HUB_CACHE"] = f"{HF_CACHE_DIR}/hub"

    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] vol.reload skipped: {exc}", flush=True)
    pathlib.Path(f"{HF_CACHE_DIR}/hub").mkdir(parents=True, exist_ok=True)
    pathlib.Path(TORCH_CACHE_DIR).mkdir(parents=True, exist_ok=True)

    repos = _hf_repos_for(str(model_arch or ""), str(custom_model_id or ""))
    if not repos:
        print(f"[cache] arch={model_arch!r}: single-file / Volume model — nothing to download", flush=True)
        return {"ok": True, "cached": True, "repos": [], "downloaded": []}

    from huggingface_hub import snapshot_download

    downloaded: list[str] = []
    for repo in repos:
        try:
            snapshot_download(repo_id=repo, local_files_only=True)
            print(f"[cache] {repo}: already on Volume", flush=True)
            continue
        except Exception:  # noqa: BLE001 — not cached yet, fall through to fetch
            pass
        try:
            t0 = time.time()
            # convrot_quant / other arch-specific expansion is a train-time
            # code patch (not model files) and stays on the GPU side; the
            # snapshot here is the complete component tree that patch needs.
            snapshot_download(repo_id=repo, max_workers=8)
            downloaded.append(repo)
            print(f"[cache] {repo}: fetched in {time.time() - t0:.0f}s", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[cache] {repo}: download FAILED — {exc}", flush=True)
            return {"ok": False, "cached": False, "repo": repo, "error": str(exc)[:500]}

    if downloaded:
        try:
            vol.commit()
            print(f"[cache] vol.commit() — {len(downloaded)} repo(s) persisted to {HF_CACHE_DIR}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[cache] vol.commit skipped: {exc}", flush=True)

    return {"ok": True, "cached": not downloaded, "repos": repos, "downloaded": downloaded}


@app.function(
    image=dispatch_image,
    timeout=600,
    min_containers=1,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="POST")
def train_lora_dispatch(item: dict, request: fastapi.Request):
    _authorize(request)
    if not item.get("output_lora_name"):
        raise fastapi.HTTPException(status_code=400, detail="output_lora_name is required")
    if item.get("_test_stub"):
        call = _pending_stub.spawn(item)
        return {"ok": True, "spawned": True, "test_stub": True, "modal_call_id": call.object_id, "job_id": item.get("job_id")}

    # Stage 1 (CPU): pre-stage the base model. Only touched when the model
    # actually has HF components to fetch — a single-file Volume model
    # (minimax_h3 etc.) skips this entirely so the common path stays instant.
    cache_info: dict = {"downloaded": [], "cached": True}
    if _hf_repos_for(item.get("target_model") or "", item.get("custom_model_id") or ""):
        try:
            cache_res = ensure_model_cached_cpu.remote(
                item.get("target_model") or "", item.get("custom_model_id") or ""
            )
        except Exception as exc:  # noqa: BLE001
            raise fastapi.HTTPException(status_code=502, detail=f"model pre-cache errored: {exc}")
        if not cache_res.get("ok"):
            # Base model could not be downloaded — do NOT start a GPU. The
            # Next.js route treats a non-2xx here as a dispatch failure and
            # refunds the debit.
            raise fastapi.HTTPException(
                status_code=502,
                detail=f"base model download failed ({cache_res.get('repo')}): {cache_res.get('error')}",
            )
        cache_info = {"downloaded": cache_res.get("downloaded", []), "cached": cache_res.get("cached")}

    call = train_lora_job.spawn(item)
    return {
        "ok": True,
        "spawned": True,
        "modal_call_id": call.object_id,
        "job_id": item.get("job_id"),
        "model_cache": cache_info,
    }


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


_CKPT_DL_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,120}\.(?:safetensors|zip)$")
_CKPT_DL_ID_RE = re.compile(r"^[0-9a-fA-F-]{1,64}$")


# Hit directly by the browser (no Next.js proxy hop, so no Authorization
# header from the user's Supabase session and no MODAL_AUTH_TOKEN either —
# putting that shared secret in a URL the browser navigates to would leak
# it). Authenticated instead by a short-lived HMAC token the Next.js route
# mints server-side after doing the real ownership check against
# generation_jobs; see /api/studio/lora/checkpoint's signDownloadToken.
def _verify_download_token(user_id: str, job_id: str, filename: str, expires: str, sig: str) -> bool:
    secret = os.environ.get("MODAL_AUTH_TOKEN", "")
    if not secret or not sig:
        return False
    try:
        if int(expires) < time.time():
            return False
    except ValueError:
        return False
    payload = f"{user_id}:{job_id}:{filename}:{expires}"
    expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


# Streams a LoRA checkpoint straight off the Volume as raw bytes. The
# generic ModalStorage.handle(action="read_file") route (a different app,
# scripts/modal_wan_animate.py) reads the whole file and returns it as a
# base64 JSON blob — fine for the small assets it was built for, but a
# 600MB checkpoint becomes ~800MB of JSON that blows well past both this
# route's own 30s-class timeout budget and the Next.js API route's
# maxDuration on Vercel. Going through the Next.js proxy at all (even with
# a raw FileResponse stream) also meant every byte crossed browser<->Vercel
# AND Vercel<->Modal — this endpoint is hit directly by the browser instead
# so only one hop's bandwidth is in play.
@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol},
    # Checkpoints run 600MB-1GB+; observed transfer at ~1.6-3MB/s through
    # the old proxied path, so 120s cut a 620MB file off mid-stream
    # (NGHTTP2_INTERNAL_ERROR on the Next.js proxy side once Modal's
    # timeout killed it). Direct browser<->Modal may be faster, but keep
    # the generous budget regardless.
    timeout=600,
    min_containers=1,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="GET")
def download_lora_checkpoint(
    user_id: str, job_id: str, filename: str, expires: str, sig: str, request: fastapi.Request
):
    if not _verify_download_token(user_id, job_id, filename, expires, sig):
        raise fastapi.HTTPException(status_code=403, detail="invalid or expired download link")
    if not (_CKPT_DL_ID_RE.match(user_id) and _CKPT_DL_ID_RE.match(job_id) and _CKPT_DL_FILENAME_RE.match(filename)):
        raise fastapi.HTTPException(status_code=400, detail="invalid parameters")
    # This endpoint keeps a warm container (min_containers=1) whose Volume
    # snapshot is frozen at mount time — a checkpoint another container just
    # wrote + committed (a fresh training publish, or salvage_lora_job) is
    # invisible here until we explicitly pull the latest Volume state.
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001 — stale-but-present read is still better than a hard fail
        print(f"[download] vol.reload() skipped: {exc}", flush=True)
    file_path = pathlib.Path(MODELS_DIR) / "loras" / user_id / job_id / filename
    if not file_path.is_file():
        raise fastapi.HTTPException(status_code=404, detail="checkpoint not found")
    return fastapi.responses.FileResponse(
        str(file_path), media_type="application/octet-stream", filename=filename
    )


# ---------------------------------------------------------------------------
# Self-healing — Modal-native FunctionCall status probe
# ---------------------------------------------------------------------------
# A training container that dies by SIGKILL (Modal 12h timeout, OOM kill,
# host eviction) never runs train_lora_job's own except-block, so
# generation_jobs stays 'processing' forever and the Studio UI spins on a
# dead job. The Next.js /api/jobs/[id] poll calls this while a job is
# 'processing' + has a modal_call_id and has gone quiet: asking Modal
# directly whether the FunctionCall is still alive is authoritative
# regardless of how the container died.
#
#   completed -> the call returned a result (row should already be flipped)
#   running   -> container is alive (even if silent — e.g. a long model
#                download / latent-cache phase with no progress PATCH)
#   failed    -> the call raised / was killed / is gone: container death
#                confirmed, the caller closes + refunds the job
#   unknown   -> transient / result-TTL elapsed: caller does nothing
@app.function(
    image=dispatch_image,
    timeout=30,
    min_containers=1,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="GET")
def check_call_status(call_id: str, request: fastapi.Request):
    _authorize(request)
    call_id = str(call_id or "").strip()
    if not call_id:
        return {"status": "unknown", "error": "no call_id provided"}
    try:
        fc = modal.FunctionCall.from_id(call_id)
    except Exception as exc:  # noqa: BLE001 — malformed / unknown id
        return {"status": "unknown", "error": f"from_id failed: {exc}"}
    try:
        fc.get(timeout=0)
        return {"status": "completed"}
    except TimeoutError:
        return {"status": "running"}
    except Exception as exc:  # noqa: BLE001
        name = type(exc).__name__
        # Result TTL elapsed on a call that finished long ago — NOT a death.
        if "OutputExpired" in name:
            return {"status": "unknown", "error": "output expired"}
        return {"status": "failed", "error": f"{name}: {exc}"[:1000]}


# ---------------------------------------------------------------------------
# Salvage — rescue whatever a dead / cancelled run left on the Volume
# ---------------------------------------------------------------------------
# ai-toolkit writes into a per-job subdir of PERSIST_OUTPUT_ROOT (on the
# mounted Volume) and _run_ai_toolkit_with_progress() vol.commit()s it every
# ~2 min, so intermediate .safetensors survive a SIGKILL. The publish step
# that would normally move them under loras/<user_id>/<job_id>/ never ran, so
# this endpoint does that move on demand: copy every surviving checkpoint
# into the canonical per-job folder, bundle the persisted dataset captions,
# and return a checkpoint list in the exact shape a normal completion writes
# to generation_jobs.metadata.checkpoints — so the existing signed-URL
# download path (download_lora_checkpoint) serves them with no changes.
@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol},
    timeout=300,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="POST")
def salvage_lora_job(data: dict, request: fastapi.Request):
    _authorize(request)
    user_id = str(data.get("user_id") or "").strip()
    job_id = str(data.get("job_id") or "").strip()
    call_id = str(data.get("call_id") or data.get("modal_call_id") or "").strip()
    dataset_id = re.sub(r"[^A-Za-z0-9._-]", "", str(data.get("dataset_id") or ""))[:64]
    lora_name = str(data.get("output_lora_name") or "").strip()
    if not (_CKPT_DL_ID_RE.match(user_id) and _CKPT_DL_ID_RE.match(job_id)):
        raise fastapi.HTTPException(status_code=400, detail="invalid user_id / job_id")

    try:
        vol.reload()  # pull the freshest Volume state written by the dead run
    except Exception as exc:  # noqa: BLE001
        print(f"[salvage] vol.reload() skipped: {exc}", flush=True)

    # Where ai-toolkit's output tree could be — keyed by fc-id first (that's
    # what _job_output_dir() uses when the container self-recorded its call
    # id), then the job id, then a bare lora-name dir as a last resort.
    search_roots: list[pathlib.Path] = []
    for key in (call_id, job_id, lora_name):
        if key:
            root = pathlib.Path(_job_output_dir(key))
            if root not in search_roots:
                search_roots.append(root)
    dest_dir = pathlib.Path(LORA_OUTPUT_DIR) / user_id / job_id
    # An already-published (partial) per-job folder is also worth re-listing.
    if dest_dir not in search_roots:
        search_roots.append(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)

    seen: set[str] = set()
    checkpoints: list[dict] = []
    for root in search_roots:
        if not root.is_dir():
            continue
        for p in sorted(root.glob("**/*.safetensors"), key=lambda x: x.stat().st_mtime):
            m = _CKPT_STEP_RE.search(p.name)
            step = int(m.group(1)) if m else 0
            # A file already living directly in the canonical per-job dir is a
            # completed run's published artifact — list it under its own name,
            # don't make a salvaged_ duplicate or re-copy 14GB.
            already_canonical = (
                p.parent == dest_dir
                and not p.name.startswith("salvaged_")
                and p.name != "checkpoints_all.zip"
            )
            if already_canonical:
                fname, dest = p.name, p
            else:
                safe_base = re.sub(r"[^A-Za-z0-9._-]", "_", p.name)
                fname = safe_base if safe_base.startswith("salvaged_") else f"salvaged_{safe_base}"
                dest = dest_dir / fname
            if not _CKPT_DL_FILENAME_RE.match(fname) or fname in seen:
                continue
            if not already_canonical:
                try:
                    if not dest.exists() or dest.stat().st_size != p.stat().st_size:
                        shutil.copy2(p, dest)
                except Exception as exc:  # noqa: BLE001
                    print(f"[salvage] copy failed for {p}: {exc}", flush=True)
                    continue
            seen.add(fname)
            checkpoints.append(
                {
                    "step": step,
                    "filename": fname,
                    "size_bytes": dest.stat().st_size,
                    "is_final": fname.endswith("_final.safetensors"),
                    "salvaged": not already_canonical,
                    "path": f"loras/{user_id}/{job_id}/{fname}",
                }
            )

    # checkpoints_all.zip — every salvaged .safetensors in one archive, same
    # signed-URL download path as a completed job's bundle. Only when 2+.
    weight_ckpts = [c for c in checkpoints if c["filename"].endswith(".safetensors")]
    if len(weight_ckpts) >= 2:
        bundle_dest = dest_dir / "checkpoints_all.zip"
        try:
            with zipfile.ZipFile(bundle_dest, "w", zipfile.ZIP_STORED) as zf:
                for c in weight_ckpts:
                    f = dest_dir / c["filename"]
                    if f.is_file():
                        zf.write(f, arcname=c["filename"])
            checkpoints.append(
                {
                    "step": 0,
                    "filename": "checkpoints_all.zip",
                    "size_bytes": bundle_dest.stat().st_size,
                    "is_final": False,
                    "is_bundle": True,
                    "salvaged": True,
                    "path": f"loras/{user_id}/{job_id}/checkpoints_all.zip",
                }
            )
            print(f"[salvage] checkpoints_all.zip: {len(weight_ckpts)} checkpoint(s)", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[salvage] checkpoints_all.zip failed: {exc}", flush=True)

    # Persisted dataset -> dataset_salvaged.zip. Bundle the renamed images
    # (0000.png, 0001.jpg, ...) TOGETHER WITH their caption .txt so, once the
    # user unzips it, every "0001.txt" sits next to the "0001.<ext>" it
    # describes — the system rename is opaque without the paired image.
    caption_count = 0
    image_count = 0
    if dataset_id:
        ds_dir = pathlib.Path(PERSIST_ROOT) / dataset_id
        if ds_dir.is_dir():
            members = sorted(
                p
                for p in ds_dir.glob("*")
                if p.is_file() and (p.suffix.lower() == ".txt" or p.suffix.lower() in IMAGE_EXTS)
            )
            if members:
                zip_dest = dest_dir / "dataset_salvaged.zip"
                try:
                    with zipfile.ZipFile(zip_dest, "w", zipfile.ZIP_DEFLATED) as zf:
                        for m in members:
                            zf.write(m, arcname=m.name)
                            if m.suffix.lower() == ".txt":
                                caption_count += 1
                            else:
                                image_count += 1
                    checkpoints.append(
                        {
                            "step": 0,
                            "filename": "dataset_salvaged.zip",
                            "size_bytes": zip_dest.stat().st_size,
                            "is_final": False,
                            "is_caption_archive": True,
                            "salvaged": True,
                            "path": f"loras/{user_id}/{job_id}/dataset_salvaged.zip",
                        }
                    )
                    print(
                        f"[salvage] dataset_salvaged.zip: {image_count} image(s) + "
                        f"{caption_count} caption(s)",
                        flush=True,
                    )
                except Exception as exc:  # noqa: BLE001
                    print(f"[salvage] dataset zip failed: {exc}", flush=True)

    checkpoints.sort(
        key=lambda c: (
            2 if c.get("is_caption_archive") else 1 if c.get("is_bundle") else 0,
            c["step"],
        )
    )

    if checkpoints:
        try:
            vol.commit()
        except Exception as exc:  # noqa: BLE001
            print(f"[salvage] vol.commit() skipped: {exc}", flush=True)

    n_weights = len(
        [c for c in checkpoints if not c.get("is_caption_archive") and not c.get("is_bundle")]
    )
    print(
        f"[salvage] job {job_id}: {n_weights} checkpoint(s), {image_count} image(s) + "
        f"{caption_count} caption(s) "
        f"(roots scanned: {[str(r) for r in search_roots]})",
        flush=True,
    )
    return {
        "ok": True,
        "job_id": job_id,
        "salvaged": n_weights,
        "caption_files": caption_count,
        "image_files": image_count,
        "checkpoints": checkpoints,
    }


# ---------------------------------------------------------------------------
# TTL cleanup — persisted VAE latent caches (案A)
# ---------------------------------------------------------------------------
# Data-retention policy (CLAUDE.md §3): generated artefacts are kept a flat
# 14 days, then purged. The persisted _latent_cache/ copies under
# PERSIST_ROOT/<dataset_id>/latents/ are derived-from-dataset artefacts, so
# they get the same treatment. Flat 14d from creation (mtime is NOT bumped
# on reuse — a heavily re-run dataset just re-encodes + re-persists after
# the purge). Scoped to latents/ only; the caption cache and the LoRA
# library have their own lifecycle.
LATENT_CACHE_RETENTION_DAYS = int(os.environ.get("LORA_LATENT_TTL_DAYS", "14"))


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol},
    schedule=modal.Period(days=1),
    timeout=600,
)
def cleanup_old_latent_caches() -> dict:
    """Daily: delete PERSIST_ROOT/*/latents/**/*.safetensors older than
    LATENT_CACHE_RETENTION_DAYS, then drop the now-empty dirs. Best-effort."""
    root = pathlib.Path(PERSIST_ROOT)
    if not root.is_dir():
        print("[latents-ttl] no dataset cache root yet — nothing to do", flush=True)
        return {"ok": True, "removed": 0}

    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[latents-ttl] vol.reload skipped: {exc}", flush=True)

    cutoff = time.time() - LATENT_CACHE_RETENTION_DAYS * 24 * 60 * 60
    removed = 0
    freed = 0
    latent_dirs = list(root.glob("*/latents"))
    for ldir in latent_dirs:
        if not ldir.is_dir():
            continue
        for f in ldir.glob("**/*.safetensors"):
            try:
                if f.is_file() and f.stat().st_mtime < cutoff:
                    freed += f.stat().st_size
                    f.unlink()
                    removed += 1
            except Exception as exc:  # noqa: BLE001
                print(f"[latents-ttl] unlink skipped {f}: {exc}", flush=True)
        # prune empty key dirs, then the latents/ dir itself
        for sub in sorted(ldir.glob("*"), reverse=True):
            try:
                if sub.is_dir() and not any(sub.iterdir()):
                    sub.rmdir()
            except Exception:  # noqa: BLE001
                pass
        try:
            if not any(ldir.iterdir()):
                ldir.rmdir()
        except Exception:  # noqa: BLE001
            pass

    if removed:
        try:
            vol.commit()
        except Exception as exc:  # noqa: BLE001
            print(f"[latents-ttl] vol.commit skipped: {exc}", flush=True)
    print(
        f"[latents-ttl] removed {removed} latent file(s) "
        f"(~{freed / 1024**2:.1f} MB) older than {LATENT_CACHE_RETENTION_DAYS}d "
        f"across {len(latent_dirs)} dataset(s)",
        flush=True,
    )
    return {"ok": True, "removed": removed, "freed_bytes": freed}


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
