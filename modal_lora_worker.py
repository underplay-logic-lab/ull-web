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
  MiniMax H3 UNet  /models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors
  CLIP             /models/clip/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
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
import yaml  # pyyaml — in BOTH images (see `image` + `dispatch_image` below)

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
# The ONE HuggingFace hub cache directory. `snapshot_download` (in the CPU
# pre-cache stage) and every from_pretrained() on the GPU must resolve to
# EXACTLY this path, or a repo the CPU stage placed here is a cache MISS on the
# GPU and the B300 silently re-downloads it (idle-fee bleed). `_hf_cache_env()`
# is the single source of truth applied in all three places (image .env, the
# CPU function, the GPU function).
HF_HUB_CACHE_DIR = f"{HF_CACHE_DIR}/hub"
AI_TOOLKIT_DIR = "/root/ai-toolkit"
SHIM_DIR = "/root/aitk_shims"


def _hf_cache_env() -> dict:
    """Canonical model + HF/torch cache environment — byte-for-byte identical
    across EVERY container (image .env, the CPU pre-cache function, the GPU
    trainer, and the ai-toolkit subprocess it launches). A single mismatched
    var here = the GPU misses the CPU-staged cache and re-downloads 30GB+ at
    B300 rates. Covers every var current huggingface_hub / transformers / torch
    releases consult so nothing can fall back to ~/.cache.

    NOTE: no offline pins (HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE) anywhere —
    hard offline mode also blocks the metadata HEAD requests transformers needs
    to resolve a *present* local cache entry (LocalEntryNotFoundError). The GPU
    download guard is _missing_base_artifacts() Fail-Fast in train_lora_job."""
    return {
        "HF_HOME": HF_CACHE_DIR,                    # -> "/models/training/hf_cache"
        "HF_HUB_CACHE": HF_HUB_CACHE_DIR,           # huggingface_hub (current)
        "HUGGINGFACE_HUB_CACHE": HF_HUB_CACHE_DIR,  # huggingface_hub (legacy)
        "TRANSFORMERS_CACHE": HF_HUB_CACHE_DIR,     # transformers (legacy alias)
        "TORCH_HOME": TORCH_CACHE_DIR,
        # ai-toolkit's ComfyUI-layout resolver (toolkit/paths.py) reads this —
        # "/models", so Wan/comfy models resolve diffusion_models/ text_encoders/
        # vae/ IN PLACE instead of falling through to a Hub download.
        "MODELS_PATH": MODELS_DIR,
        "HF_HUB_ENABLE_HF_TRANSFER": "1",
    }


def _apply_hf_cache_env() -> None:
    """Force the canonical model/cache env into os.environ for the current
    process (and thus every subprocess that inherits it)."""
    os.environ.update(_hf_cache_env())

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
#           s/it projects total wall time; if it exceeds the dynamic cost cap
#           (_cost_cap_seconds: credit-covered seconds *
#           ULL_COST_GUARD_MULTIPLIER, floored by the per-arch expected run
#           time), graceful stop + 100% refund + salvageable partial
#           checkpoints.
# Checkpoint I/O (`Saving at step` / `Saved checkpoint`) grants a grace
# window so a long disk sync never looks like a stall.
# LORA_SAFETY_LIMIT_S is only a fallback ceiling for credits_cost == 0.
LORA_PREP_SILENCE_S = int(os.environ.get("LORA_PREP_SILENCE_S", str(20 * 60)))
LORA_COST_MIN_STEP = int(os.environ.get("LORA_COST_MIN_STEP", "50"))
LORA_CKPT_IO_GRACE_S = int(os.environ.get("LORA_CKPT_IO_GRACE_S", str(5 * 60)))
LORA_SAFETY_LIMIT_S = int(os.environ.get("LORA_SAFETY_LIMIT_S", str(5 * 60 * 60)))

# Cost-guard leniency. The projected-wall-time abort compares against
# (credit-covered seconds * this multiplier). 1.0 == strict break-even
# margin (the original behaviour); >1 lets a legitimately long run eat
# slightly into the gross margin instead of being false-aborted a few
# minutes short. A real runaway is still caught — the per-arch floor below
# is itself bounded, the projected-time check still fires above the raised
# threshold, and the 12h container timeout is the hard ceiling.
ULL_COST_GUARD_MULTIPLIER = max(
    1.0, min(float(os.environ.get("ULL_COST_GUARD_MULTIPLIER", "1.4")), 3.0)
)
# Measured seconds/iteration baseline per arch — floors the cost cap so a
# correctly-priced-but-slow heavy model (MiniMax H3 measures ~5s/it at 1024)
# always has enough runway to finish its declared step count even when its
# credit price underprices the wall time. Unlisted arch -> _DEFAULT.
LORA_SPI_BASELINE: dict[str, float] = {
    "minimax_h3": 5.0,
    "wan22_14b": 4.0,
    "wan21": 3.5,
    "ltx2": 3.5,
    "hunyuan": 4.0,
    "cogvideox": 4.0,
    "flux2": 2.2,
    "flux2_klein_9b": 1.6,
    "flux2_klein_4b": 1.1,
    "qwen_image": 2.0,
    "krea2": 2.0,
    "zimage": 1.2,
    "anima": 1.4,
    "sdxl": 0.9,
}
LORA_SPI_BASELINE_DEFAULT = float(os.environ.get("LORA_SPI_BASELINE_DEFAULT", "2.5"))
# Prep / latent-caching / checkpoint headroom added on top of pure training
# time in the per-arch floor (a multi-res 1024 run legitimately spends
# 20-40 min caching latents before step 1).
LORA_FLOOR_PREP_S = int(os.environ.get("LORA_FLOOR_PREP_S", str(45 * 60)))
# Hard ceiling shared by every cost-cap path — always stop gracefully before
# the 12h container timeout.
LORA_ABS_MAX_RUN_S = 12 * 60 * 60 - 20 * 60
# Stage 1 (Qwen caption) dynamic budget: 30s/image, min 10 min.
LORA_CAPTION_S_PER_IMG = int(os.environ.get("LORA_CAPTION_S_PER_IMG", "30"))
LORA_CAPTION_MIN_S = int(os.environ.get("LORA_CAPTION_MIN_S", str(10 * 60)))

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

# Preset target_model -> ai-toolkit arch + a name_or_path (a single-file
# checkpoint on the Volume when we host it, otherwise a HuggingFace repo id
# ai-toolkit resolves at load time). This is the FULL, sealed, 14-model
# commercial lineup — the general UI's model dropdown (LoraStudioTab.tsx) no
# longer exposes free-text "custom HuggingFace repo id" entry, so this dict
# (mirrored in src/lib/loraModels.ts) is the only way an ordinary user's job
# reaches a base model. target_model="custom" + custom_model_id +
# base_architecture / training_config.custom_yaml_override still work
# server-side for internal/admin use, just aren't reachable from the UI.
TARGET_MODELS: dict[str, dict] = {
    # --- video ---
    # Wan 2.1 RETIRED — superseded by Wan 2.2 (below). Kept commented so the
    # history is legible; admin_cleanup_volume(purge_retired_wan21=True) drops
    # the leftover diffusion_models/wan2.1_t2v_*.safetensors comfy files.
    # "wan21_14b": {"arch": "wan21", "unet": "Wan-AI/Wan2.1-T2V-14B-Diffusers"},
    # "wan21_1.3b": {"arch": "wan21", "unet": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers"},
    # Wan 2.2 (MoE 14B): Wan2214bModel(Wan21) hard-wires TWO components to
    # SEPARATE repos that name_or_path can't reach —
    # te_path = "ai-toolkit/umt5_xxl_encoder" (UMT5 text_encoder/ + tokenizer/)
    # and _wan_vae_path = "ai-toolkit/wan2.1-vae" (the causal video VAE). Both
    # must be listed so _hf_repos_for() yields them and the CPU stage
    # snapshot_download's them. `model_kwargs.use_comfy_weights: False` forces
    # the loader to read the DUAL transformer (transformer/ + transformer_2/,
    # bf16) straight from the -bf16 Diffusers repo instead of pulling
    # fp8_scaled comfy single files from Comfy-Org/Wan_2.2_ComfyUI_Repackaged
    # (a hidden ~28GB GPU download, and the wrong precision for bf16 LoRA).
    "wan22_14b": {
        "arch": "wan22_14b",
        "unet": "ai-toolkit/Wan2.2-T2V-A14B-Diffusers-bf16",
        "text_encoder": "ai-toolkit/umt5_xxl_encoder",
        "vae": "ai-toolkit/wan2.1-vae",
        "model_kwargs": {"use_comfy_weights": False},
    },
    # LTX: ai-toolkit's "ltx2" arch is built for LTX-2. Handing it the old
    # Lightricks/LTX-Video (0.9.x) checkpoint crashes with a Meta Tensor error
    # (the state-dict keys don't line up), so point name_or_path at LTX-2.
    "ltx_video": {"arch": "ltx2", "unet": "Lightricks/LTX-2"},
    # MiniMax H3: NO Diffusers repo — ai-toolkit's minimax_h3 loader resolves
    # every component through _resolve_comfy_file(), which (a) IGNORES the
    # top-level text_encoder_path / vae_path YAML keys and (b) defaults to
    # partition "fl2va_pruned" + the *_int8_convrot / *_nvfp4_awq comfy
    # filenames. ai-toolkit's MiniMaxH3Transformer is hard-wired to that
    # fused int8_convrot state-dict layout — feeding it a raw bf16 checkpoint
    # crashes with "Unexpected key(s) in state_dict: blocks.0.adaln_proj.
    # linear.bias …" (bf16 keeps adaln_proj split, the quant partition fuses
    # it). So track ai-toolkit's default: pull the *pruned int8_convrot* DiT +
    # *nvfp4_awq* TE and select partition "fl2va_pruned". Pin ALL component
    # paths to the exact MODELS_DIR files _ensure_minimax_h3_weights() places
    # so there are zero Hub weight downloads on the GPU. `audio_vae` is loaded
    # unconditionally by _load_vaes() and has no top-level key, so it lives
    # only in model_kwargs (+ _MINIMAX_H3_WEIGHT_FILES). The VAEs are already
    # the layout ai-toolkit expects, so they stay as-is.
    "minimax_h3": {
        "arch": "minimax_h3",
        "unet": f"{MODELS_DIR}/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        "text_encoder": f"{MODELS_DIR}/clip/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        "vae": f"{MODELS_DIR}/vae/minimax_h3_video_vae_fp16.safetensors",
        "audio_vae": f"{MODELS_DIR}/vae/minimax_h3_audio_vae_fp32.safetensors",
        "model_kwargs": {
            "partition": "fl2va_pruned",
            "dit_fl2va_pruned_path": f"{MODELS_DIR}/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
            "text_encoder_path": f"{MODELS_DIR}/clip/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
            "video_vae_path": f"{MODELS_DIR}/vae/minimax_h3_video_vae_fp16.safetensors",
            "audio_vae_path": f"{MODELS_DIR}/vae/minimax_h3_audio_vae_fp32.safetensors",
        },
    },
    # --- photo / general — Diffusers repos, snapshot_download'd to the
    # Volume HF cache by ensure_model_cached_cpu() like Wan/Qwen above. ---
    # FLUX.2 Klein: ai-toolkit's flux2_klein loader hard-wires the text encoder
    # to Qwen/Qwen3-* and the VAE to ai-toolkit/flux2_vae (Flux2Klein{4B,9B}Model
    # class attrs) — it does NOT read the text_encoder/ vae/ subfolders bundled
    # in the -klein-base repo. So all three repos must be pre-cached.
    "flux2_klein_4b": {
        "arch": "flux2_klein_4b",
        "unet": "black-forest-labs/FLUX.2-klein-base-4B",
        "text_encoder": "Qwen/Qwen3-4B",
        "vae": "ai-toolkit/flux2_vae",
    },
    "flux2_klein_9b": {
        "arch": "flux2_klein_9b",
        "unet": "black-forest-labs/FLUX.2-klein-base-9B",
        "text_encoder": "Qwen/Qwen3-8B",
        "vae": "ai-toolkit/flux2_vae",
    },
    # FLUX.2 [dev]: Flux2Model loads the TE from a (gated) Mistral repo and the
    # VAE from the shared flux2 autoencoder. The Mistral pull needs an HF token
    # with that licence accepted (huggingface-secret HF_TOKEN).
    "flux2": {
        "arch": "flux2",
        "unet": "black-forest-labs/FLUX.2-dev",
        "text_encoder": "mistralai/Mistral-Small-3.1-24B-Instruct-2503",
        "vae": "ai-toolkit/flux2_vae",
    },
    # `extras` -> YAML model.extras_name_or_path: ai-toolkit's qwen_image loader
    # reads the tokenizer("tokenizer" subfolder) / text_encoder / vae / scheduler
    # + configs from this Diffusers repo. ensure_model_cached_cpu() pre-caches it
    # (transformer shards excluded — the Comfy single file covers those).
    "qwen_image": {"arch": "qwen_image", "unet": "Qwen/Qwen-Image", "extras": "Qwen/Qwen-Image"},
    # Krea 2: the MMDiT weights are the ONLY thing in "krea/Krea-2-Raw". The
    # Krea2Model loader (ai-toolkit extensions_built_in/diffusion_models/krea2/
    # krea2.py) hard-wires its other two components to SEPARATE HF repos —
    # QWEN3_VL_PATH = "Qwen/Qwen3-VL-4B-Instruct" (whole repo, subfolder="")
    # for the text encoder + both tokenizers, and QWEN_IMAGE_VAE_PATH =
    # "Qwen/Qwen-Image" (its "vae" subfolder) for the autoencoder. Neither is
    # reachable from name_or_path, so without listing them here the CPU
    # pre-cache misses them and the GPU pulls ~10GB (Qwen3-VL) + the Qwen-Image
    # VAE at B300 rates. The Qwen-Image snapshot is transformer-shards-excluded
    # (_REPO_SNAPSHOT_IGNORE) and shared with the qwen_image preset.
    "krea2": {
        "arch": "krea2",
        "unet": "krea/Krea-2-Raw",
        "text_encoder": "Qwen/Qwen3-VL-4B-Instruct",
        "vae": "Qwen/Qwen-Image",
    },
    # Z-Image: the TE (Qwen3TextEncoder, "text_encoder"), tokenizer and VAE
    # (KLVAE, "vae") all live inside "Tongyi-MAI/Z-Image-Turbo" (== name_or_path
    # == extras_name_or_path) and the full snapshot of `unet` covers them. But
    # ZImageModel.load_transformer defaults use_comfy_weights=True, which would
    # pull z_image_turbo_bf16.safetensors from Comfy-Org/z_image_turbo (a hidden
    # ~12GB GPU download) instead of the transformer/ folder already on the
    # Volume — so force it off. The whole model is then one snapshotted repo.
    "zimage": {
        "arch": "zimage",
        "unet": "Tongyi-MAI/Z-Image-Turbo",
        "model_kwargs": {"use_comfy_weights": False},
    },
    # --- anime / illustration ---
    # Anima: AnimaModel loads EVERY component (CosmosTransformer3DModel,
    # QwenImageVAE "vae", Qwen3ModelEncoder "text_encoder", AnimaTextConditioner
    # "text_conditioner", the "tokenizer" + "t5_tokenizer" subfolders) from a
    # single name_or_path. The full snapshot of `unet` covers all of them — no
    # hard-coded external TE/VAE repo.
    "anima": {"arch": "anima", "unet": "circlestone-labs/Anima-Base-v1.0-Diffusers"},
    # SDXL (illustrious_xl / juggernaut_xl): StableDiffusionXLPipeline
    # .from_pretrained(name_or_path) pulls unet + vae + text_encoder +
    # text_encoder_2 + both tokenizers from that one repo. ai-toolkit hard-codes
    # no separate TE/VAE (model_config.vae_path is left unset), so the `unet`
    # snapshot is complete.
    "illustrious_xl": {"arch": "sdxl", "unet": "OnomaAIResearch/Illustrious-xl-early-release-v0"},
    # Pony V6 XL removed: "AstraliteHeart/pony-diffusion-v6-xl" 404s (repo id
    # doesn't exist even with a valid HF token) and no vanilla-Pony mirror ships
    # a full ai-toolkit-loadable DIFFUSERS layout. Replaced with Juggernaut XL.
    #
    # RunDiffusion/Juggernaut-XL-v9 ships ONLY *.fp16.safetensors component
    # files (no plain-variant weights). model_kwargs.variant="fp16" records the
    # intent, though NOTE: ai-toolkit's SDXL path (toolkit/stable_diffusion_model
    # .py, is_xl) does not currently thread model_kwargs into from_pretrained —
    # the real safety net is diffusers>=0.32's own automatic fp16-file fallback
    # (a warning, not a crash), which this widely-used repo relies on.
    "juggernaut_xl": {
        "arch": "sdxl",
        "unet": "RunDiffusion/Juggernaut-XL-v9",
        "model_kwargs": {"variant": "fp16"},
    },
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

# Read-only view of the SAME Volume, for functions that only ever read files
# off it (checkpoint / artifact downloads, admin file explorer). A read-only
# mount disables Modal's implicit `allow_background_commits` AND the
# clean-shutdown auto-commit for that container, so a warm/idle downloader can
# never resurrect a file another container (the admin explorer, the TTL
# purges) has deleted + committed. Any function that writes to the Volume must
# keep mounting the read-write `vol` handle.
vol_ro = vol.with_mount_options(read_only=True)

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
            # Load the base model from the persistent Volume cache that
            # ensure_model_cached_cpu() (the CPU dispatcher, before this GPU
            # was ever spawned) pre-filled. train_lora_job self-aborts
            # (_missing_base_artifacts Fail-Fast) if a weight is missing — the
            # GPU NEVER runs a download. `_hf_cache_env()` (HF_HOME, MODELS_PATH,
            # …) is the SAME dict every container applies, so a CPU-cached
            # snapshot is always a GPU-local hit.
            **_hf_cache_env(),
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


# Placeholder written by `modal secret create huggingface-secret ...` so a
# deploy doesn't fail before a real token is set — treated as "no token".
_HF_TOKEN_PLACEHOLDERS = {"", "REPLACE_WITH_REAL_HF_TOKEN", "REPLACE_ME", "changeme", "your_token_here"}


def _hf_token() -> str | None:
    """The Hugging Face access token (from the `huggingface-secret` Modal
    secret), or None. Passing an authenticated token to snapshot_download /
    hf_hub_download lifts the anonymous per-IP bandwidth throttle — a big
    repo that crawls at anon speed downloads in minutes with a token."""
    for k in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN", "HF_API_TOKEN"):
        v = (os.environ.get(k) or "").strip()
        if v and v not in _HF_TOKEN_PLACEHOLDERS:
            # Normalise so huggingface_hub's own env lookups also see it.
            os.environ.setdefault("HF_TOKEN", v)
            os.environ.setdefault("HUGGING_FACE_HUB_TOKEN", v)
            return v
    return None


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
    projected wall time exceeds the dynamic cost cap ("cost") — credit-covered
    seconds * ULL_COST_GUARD_MULTIPLIER, floored by the per-arch expected
    run time (see _cost_cap_seconds). Partial checkpoints are committed +
    salvageable, and the credits are 100% refunded (system's call, not a
    config crash)."""

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
    This is the RAW break-even number — the live guard adds
    ULL_COST_GUARD_MULTIPLIER and the per-arch floor on top (see
    _cost_cap_seconds).
    """
    revenue_jpy = max(0, credits_cost) * 1.66
    max_cost_jpy = revenue_jpy * 0.70
    b300_jpy_per_sec = 1125 / 3600
    secs = max_cost_jpy / b300_jpy_per_sec if b300_jpy_per_sec else 0.0
    return int(max(1800, min(secs, LORA_ABS_MAX_RUN_S)))


def _arch_for_target(target_model: str, base_architecture: str = "") -> str:
    """Resolve a preset id / bare arch string to the ai-toolkit arch key used
    in LORA_SPI_BASELINE (falls back to whatever string was given)."""
    entry = TARGET_MODELS.get(target_model)
    if entry and entry.get("arch"):
        return str(entry["arch"])
    return (base_architecture or target_model or "").strip()


def _expected_run_floor_seconds(
    target_model: str, total_steps: int, base_architecture: str = ""
) -> int:
    """Lower bound for the cost cap: no matter how cheap the credit price came
    out, never abort a run before it has had a fair shot at completing
    `total_steps` at this arch's MEASURED s/it (LORA_SPI_BASELINE) plus a 30%
    cushion and prep headroom. Bounded by LORA_ABS_MAX_RUN_S so a true runaway
    (actual s/it far above baseline -> projected time still blows past this
    floor) is still stopped."""
    if total_steps <= 0:
        return 0
    arch = _arch_for_target(target_model, base_architecture)
    spi = LORA_SPI_BASELINE.get(arch, LORA_SPI_BASELINE_DEFAULT)
    floor = LORA_FLOOR_PREP_S + total_steps * spi * 1.3
    return int(min(floor, LORA_ABS_MAX_RUN_S))


def _cost_cap_seconds(
    credits_cost: int, target_model: str, total_steps: int, base_architecture: str = ""
) -> tuple[int, str]:
    """The live projected-wall-time abort threshold. Returns (seconds, reason
    string for the log). Combines three inputs:
      * base      = _credit_covered_seconds(credits) (or LORA_SAFETY_LIMIT_S
                    for a zero-credit raw-YAML job)
      * + margin  = base * ULL_COST_GUARD_MULTIPLIER
      * floored   = max(margin, per-arch expected run time)
      * clamped   = min(that, LORA_ABS_MAX_RUN_S)
    """
    base = _credit_covered_seconds(credits_cost) if credits_cost > 0 else LORA_SAFETY_LIMIT_S
    with_margin = base * ULL_COST_GUARD_MULTIPLIER
    arch_floor = _expected_run_floor_seconds(target_model, total_steps, base_architecture)
    capped = int(min(max(with_margin, arch_floor), LORA_ABS_MAX_RUN_S))
    arch = _arch_for_target(target_model, base_architecture)
    reason = (
        f"{credits_cost}C -> base {base}s x{ULL_COST_GUARD_MULTIPLIER:.2f} = {int(with_margin)}s, "
        f"arch-floor[{arch}, {total_steps or '?'}st] {arch_floor}s -> {capped}s "
        f"(~{capped / 3600:.2f}h)"
    )
    return capped, reason


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


def _purge_storage_objects(bucket: str, keys: list, *, batch: int = 100) -> int:
    """Best-effort PHYSICAL delete of objects from a (private) Supabase Storage
    bucket with the service-role key — mirrors supabase-js
    `storage.from(bucket).remove(paths)` (DELETE /object/<bucket> with a
    {"prefixes": [...]} body).

    Called the moment Smart Ingest has baked its own optimised WebP copies onto
    the persistent Modal Volume: the uploaded originals are dead weight after
    that, and leaving them in Storage silently eats the Supabase Free-tier 1GB
    quota (CLAUDE.md §3). Never raises — a failed purge must never sink a
    training job. Returns the number of objects Storage reported as removed."""
    import requests

    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    clean = [str(k).lstrip("/") for k in (keys or []) if k and ".." not in str(k)]
    if not supabase_url or not service_key or not clean:
        return 0

    url = f"{supabase_url}/storage/v1/object/{bucket}"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }
    removed = 0
    for i in range(0, len(clean), batch):
        chunk = clean[i : i + batch]
        try:
            res = requests.request(
                "DELETE", url, headers=headers, json={"prefixes": chunk}, timeout=(10, 60)
            )
            if res.status_code == 200:
                try:
                    removed += len(res.json())
                except Exception:  # noqa: BLE001 — 200 == the batch is gone
                    removed += len(chunk)
            else:
                print(
                    f"[ingest] storage purge {bucket}: HTTP {res.status_code} {res.text[:200]}",
                    flush=True,
                )
        except requests.exceptions.RequestException as exc:
            print(f"[ingest] storage purge {bucket} failed: {exc}", flush=True)
    return removed


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

    # The Qwen VLM checkpoint is pre-staged on the Volume, so from_pretrained()
    # resolves from local disk. We do NOT hard-pin HF_HUB_OFFLINE here: that
    # also blocks the few-byte metadata HEAD requests transformers needs to
    # resolve a present cache entry (LocalEntryNotFoundError on files that are
    # physically there). The tiny revision-check round-trip is harmless.
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

    # No HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE pin for Stage 2 either — the
    # ai-toolkit base model is 100% pre-staged on the Volume by
    # ensure_model_cached_cpu, and the download guard is
    # _missing_base_artifacts() (Fail-Fast RuntimeError) in train_lora_job.
    # Hard offline mode broke local cache resolution (LocalEntryNotFoundError).
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
H3_LOCAL_UNET = f"{MODELS_DIR}/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"


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
        block = {
            "name_or_path": h3["unet"],
            "arch": "minimax_h3",
            "quantize": False,
            "low_vram": False,
            "text_encoder_path": h3["text_encoder"],
            "vae_path": h3["vae"],
        }
        # model_kwargs is where ai-toolkit's minimax loader ACTUALLY reads the
        # per-component local paths + partition from (the top-level keys above
        # are ignored by it) — see TARGET_MODELS["minimax_h3"].
        if isinstance(h3.get("model_kwargs"), dict):
            block["model_kwargs"] = dict(h3["model_kwargs"])
        return block

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
        if isinstance(safe.get("model_kwargs"), dict):
            block["model_kwargs"] = dict(safe["model_kwargs"])
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
    # `extras_name_or_path` is where ai-toolkit's qwen_image loader reads the
    # tokenizer / text-encoder / VAE / scheduler + every config.json from
    # (toolkit/models/v2/_mixin.py load_tokenizer: AutoTokenizer.from_pretrained
    # (<extras>, subfolder="tokenizer") — the "tokenizer" subfolder is the class
    # default, no YAML key for it). It DEFAULTS to name_or_path in
    # config_modules.py, but the Comfy single-file transformer swap can leave
    # name_or_path pointing at a *.safetensors — so pin it explicitly to the
    # Diffusers repo id here. ensure_model_cached_cpu() snapshot_download's this
    # exact repo (transformer weight shards excluded) so it resolves offline.
    if target.get("extras"):
        model_block["extras_name_or_path"] = target["extras"]
    # Per-preset ai-toolkit model_kwargs (e.g. use_comfy_weights: False so the
    # loader reads the transformer/TE from the Diffusers repo the CPU stage
    # already snapshotted, not a Comfy-Org single file it would fetch on GPU).
    if isinstance(target.get("model_kwargs"), dict):
        model_block["model_kwargs"] = {**target["model_kwargs"], **model_block.get("model_kwargs", {})}

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
    offline: bool = False,
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

    # NO offline pins for the ai-toolkit subprocess. The full component tree —
    # including the small Wan tokenizer / arch-config repo
    # (ai-toolkit/umt5_xxl_encoder) — is pre-staged on the Volume by
    # ensure_model_cached_cpu, so every load resolves from local disk. Hard
    # HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE also blocked the metadata HEAD
    # requests transformers needs to resolve a *present* cache entry, raising
    # LocalEntryNotFoundError on files that were physically there. The download
    # guard is _missing_base_artifacts() in train_lora_job: it self-aborts
    # before this subprocess ever starts if any artefact is missing, so a
    # multi-GB Hub pull can never begin.
    _ = offline
    child_env = dict(os.environ)
    child_env.pop("HF_HUB_OFFLINE", None)
    child_env.pop("TRANSFORMERS_OFFLINE", None)
    child_env.pop("HF_DATASETS_OFFLINE", None)

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
    # Name of the persistent Volume, for the aitk-injected H3 TE Bake & Skip
    # patch to do a best-effort `modal.Volume.from_name(...).commit()` the
    # moment it finishes writing the ~64GB baked bf16 text encoder (the
    # parent's periodic vol.commit() would persist it anyway, just later).
    child_env["ULL_MODAL_VOLUME"] = "ull-wan-models"

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

    # --- MiniMax H3 int8_convrot dequant "Bake & Skip" ----------------------
    # ai-toolkit loads minimax_h3_fl2va_pruned_int8_convrot.safetensors and,
    # because our config asks for NO quantization (bf16 LoRA training), calls
    # dequantize_ostris_to_linear() on the CPU-resident model in aitk_post_load
    # — an inverse-Hadamard + per-row-scale pass over every linear of a 33B DiT
    # that costs 10+ minutes of B300 idle on EVERY run. Patch appended to
    # minimax_h3.py wraps MinimaxH3Model._load_transformer so that pass runs
    # ONCE: its bf16 result is baked to the Volume as
    # diffusion_models/minimax_h3_baked_<component>_bf16.safetensors (keyed by
    # partition — fl2va_pruned / ref2va_pruned dequantize to different weights),
    # and every later run loads that file directly (safetensors load + one
    # load_state_dict(assign=True) — no dequant math at all). A heartbeat line
    # every 30s during the one-time dequant/bake keeps the worker's 20-minute
    # prep-silence watchdog (and its checkpoint-I/O grace) from reading the
    # quiet CPU/disk work as a deadlock. Best-effort: any failure falls back to
    # ai-toolkit's stock path and training still proceeds.
    minimax_file = pathlib.Path(AI_TOOLKIT_DIR) / (
        "extensions_built_in/diffusion_models/minimax_h3/minimax_h3.py"
    )
    _H3_BAKE_MARKER = "INJECTED BY ULL STUDIO PATCH: MiniMax H3 dequant Bake & Skip"
    _H3_BAKE_PATCH = '''

# ===== INJECTED BY ULL STUDIO PATCH: MiniMax H3 dequant Bake & Skip =====
import time as _ull_time
import threading as _ull_threading

_ULL_H3_BAKE_DIR = os.environ.get("ULL_H3_BAKE_DIR", "/models/diffusion_models")


def _ull_h3_baked_path(model):
    try:
        component = model._dit_component()  # "dit_fl2va_pruned" etc.
    except Exception:
        component = "dit_unknown"
    return os.path.join(
        _ULL_H3_BAKE_DIR, f"minimax_h3_baked_{component}_bf16.safetensors"
    )


def _ull_h3_with_heartbeat(label, fn):
    """Run fn() on THIS thread; a daemon thread prints a progress line every
    30s so the worker's prep-silence watchdog never fires during the quiet
    CPU dequant / disk write. 'writing safetensors' also arms its I/O grace."""
    stop_evt = _ull_threading.Event()

    def _beat():
        t0 = _ull_time.time()
        while not stop_evt.wait(30):
            print(
                f"[ULL][minimax] {label} — writing safetensors, "
                f"{int(_ull_time.time() - t0)}s elapsed",
                flush=True,
            )

    hb = _ull_threading.Thread(target=_beat, daemon=True)
    hb.start()
    try:
        return fn()
    finally:
        stop_evt.set()
        hb.join(timeout=1)


_ull_h3_orig_load_transformer = MinimaxH3Model._load_transformer


def _ull_h3_load_transformer(self):
    if os.environ.get("ULL_H3_BAKE", "1") == "0":
        return _ull_h3_orig_load_transformer(self)  # kill switch: stock path

    baked = _ull_h3_baked_path(self)

    # --- SKIP: a baked bf16 transformer is already on the Volume ----------
    if os.path.isfile(baked) and os.path.getsize(baked) > 0:
        try:
            self.print_and_status_update(
                f"Loading pre-baked bf16 transformer (skipping int8_convrot "
                f"dequant): {baked}"
            )

            def _load():
                sd = load_file(baked)
                m = MiniMaxH3Transformer.load_from_state_dict(sd, self.torch_dtype)
                sd.clear()
                return m

            transformer = _ull_h3_with_heartbeat("loading baked transformer", _load)
            flush()
            print(
                f"[ULL][minimax] baked bf16 transformer loaded from {baked}",
                flush=True,
            )
            return transformer
        except Exception as e:
            print(
                f"[ULL][minimax] baked load failed ({e!r}) — falling back to "
                f"int8_convrot dequant",
                flush=True,
            )

    # --- BAKE: first run — attach quantized layers, dequantize, persist ---
    transformer = _ull_h3_orig_load_transformer(self)
    try:
        from toolkit.util.ostris_quant import OstrisLinear

        if any(isinstance(mod, OstrisLinear) for mod in transformer.modules()):
            from toolkit.util.quantize import dequantize_ostris_to_linear

            self.print_and_status_update(
                "Dequantizing int8_convrot -> bf16 (first run; caching the result)"
            )
            n = _ull_h3_with_heartbeat(
                "dequantizing int8_convrot",
                lambda: dequantize_ostris_to_linear(transformer),
            )
            transformer.aitk_is_quantized = False
            transformer.aitk_qtype = None
            print(
                f"[ULL][minimax] dequantized {n} layers -> bf16; baking to {baked}",
                flush=True,
            )
            try:
                _ull_h3_bake(transformer, baked)
            except Exception as e:
                print(
                    f"[ULL][minimax] bake skipped ({e!r}) — training continues "
                    f"with the in-memory weights",
                    flush=True,
                )
    except Exception as e:
        print(
            f"[ULL][minimax] dequant/bake wrapper error ({e!r}) — using "
            f"ai-toolkit's default path",
            flush=True,
        )
    return transformer


def _ull_h3_bake(transformer, baked):
    tmp = f"{baked}.tmp.{os.getpid()}"
    os.makedirs(os.path.dirname(baked), exist_ok=True)

    def _write():
        cpu_sd = {}
        for k, v in transformer.state_dict().items():
            cpu_sd[k] = v.detach().to("cpu").contiguous()
        save_file(
            cpu_sd,
            tmp,
            metadata={"format": "pt", "ull_baked_from": "minimax_h3_int8_convrot"},
        )
        cpu_sd.clear()

    _ull_h3_with_heartbeat("baking bf16 transformer", _write)
    os.replace(tmp, baked)
    flush()
    print(
        f"[ULL][minimax] baked bf16 transformer -> {baked} "
        f"({os.path.getsize(baked) / 1e9:.1f} GB)",
        flush=True,
    )


MinimaxH3Model._load_transformer = _ull_h3_load_transformer
print(
    "[aitk-patch] minimax_h3.py — installed int8_convrot dequant Bake & Skip wrapper",
    flush=True,
)
# ===== END INJECTED BY ULL STUDIO PATCH =====
'''

    # --- MiniMax H3 Text Encoder (qwen3vl_32b nvfp4_awq) "Bake & Skip" ------
    # PHASE B (promoted from the Phase-A timing probe). ai-toolkit's
    # MinimaxH3Model._load_text_encoder() reads the nvfp4_awq single file and
    # runs import_comfy_quantized_layers() to unpack the 4bit-packed AWQ
    # layers into OstrisLinear modules (+ an Int8Embedding token table) on
    # EVERY H3 run — ~16 min of B300 idle. The injected wrapper runs that pass
    # ONCE: the unpacked TE is fully dequantized to bf16 (OstrisLinear ->
    # nn.Linear via dequantize_ostris_to_linear, exactly like the DiT bake;
    # Int8Embedding -> nn.Embedding), its state_dict baked to the Volume as
    # diffusion_models/minimax_h3_baked_te_qwen3vl32b_bf16.safetensors, and
    # every later run rebuilds an empty Qwen3VLTextEncoder skeleton and loads
    # that file straight into it (safetensors load + one
    # load_state_dict(assign=True) — no AWQ unpack at all). A 30s heartbeat
    # during the one-time dequant/write keeps the worker's 20-minute
    # prep-silence watchdog quiet, and a best-effort modal.Volume commit right
    # after the write hardens it against a crash before the parent's next
    # periodic vol.commit(). Kill switch: ULL_H3_TE_BAKE=0 -> stock nvfp4 path.
    # Fully try/except-guarded end to end: any failure (bake OR skip) falls
    # back to ai-toolkit's stock nvfp4 load and training proceeds unchanged.
    _H3_TE_PROBE_MARKER = "INJECTED BY ULL STUDIO PATCH: MiniMax H3 TE Bake and Skip"
    _H3_TE_PROBE_PATCH = '''

# ===== INJECTED BY ULL STUDIO PATCH: MiniMax H3 TE Bake and Skip =====
import time as _ull_te_time
import threading as _ull_te_threading

_ULL_H3_TE_BAKE_DIR = os.environ.get("ULL_H3_BAKE_DIR", "/models/diffusion_models")
_ULL_H3_TE_BAKED = os.path.join(
    _ULL_H3_TE_BAKE_DIR, "minimax_h3_baked_te_qwen3vl32b_bf16.safetensors"
)
_ULL_H3_TE_DISABLED = os.environ.get("ULL_H3_TE_BAKE", "1") == "0"


def _ull_te_baked_ready():
    return os.path.isfile(_ULL_H3_TE_BAKED) and os.path.getsize(_ULL_H3_TE_BAKED) > 0


def _ull_h3_te_with_heartbeat(label, fn):
    """Run fn() on THIS thread; a daemon prints a progress line every 30s so
    the worker's prep-silence watchdog never fires during the quiet CPU
    dequant / disk write ('writing safetensors' also arms its I/O grace)."""
    _stop = _ull_te_threading.Event()

    def _beat():
        _t0 = _ull_te_time.time()
        while not _stop.wait(30):
            print(
                f"[ULL][minimax][te] {label} — writing safetensors, "
                f"{int(_ull_te_time.time() - _t0)}s elapsed",
                flush=True,
            )

    _hb = _ull_te_threading.Thread(target=_beat, daemon=True)
    _hb.start()
    try:
        return fn()
    finally:
        _stop.set()
        _hb.join(timeout=1)


def _ull_h3_te_commit_volume():
    """Best-effort immediate Volume commit so the freshly-baked TE survives a
    crash before the parent process's next periodic vol.commit(). A no-op or
    failure here is harmless — the parent commits the whole Volume anyway."""
    try:
        import modal as _ull_modal

        _vname = os.environ.get("ULL_MODAL_VOLUME", "ull-wan-models")
        _ull_modal.Volume.from_name(_vname).commit()
        print(
            f"[ULL][minimax] vol.commit() — baked bf16 text_encoder persisted "
            f"to Volume ({_vname})",
            flush=True,
        )
    except Exception as _e:  # noqa: BLE001
        print(
            f"[ULL][minimax] vol.commit() skipped ({_e!r}) — the parent's "
            f"periodic commit will persist the baked TE",
            flush=True,
        )


def _ull_h3_te_full_dequant(text_encoder):
    """OstrisLinear -> nn.Linear (folded, layer by layer) and Int8Embedding ->
    nn.Embedding (materialised table). Returns (n_linear, n_embedding)."""
    from toolkit.util.quantize import dequantize_ostris_to_linear

    n_lin = dequantize_ostris_to_linear(text_encoder)
    n_emb = 0
    try:
        from toolkit.util.comfy_quant_import import Int8Embedding
    except Exception:  # noqa: BLE001
        Int8Embedding = None
    if Int8Embedding is not None:
        for _parent in text_encoder.modules():
            for _cname, _child in list(_parent.named_children()):
                if isinstance(_child, Int8Embedding):
                    _w = _child.weight.detach().to("cpu").contiguous()
                    _emb = torch.nn.Embedding(
                        _child.num_embeddings, _child.embedding_dim
                    )
                    _emb.weight = torch.nn.Parameter(_w, requires_grad=False)
                    setattr(_parent, _cname, _emb)
                    n_emb += 1
    return n_lin, n_emb


def _ull_h3_te_bake(text_encoder, baked):
    n_lin, n_emb = _ull_h3_te_full_dequant(text_encoder)
    if n_lin == 0 and n_emb == 0:
        print(
            "[ULL][minimax] TE carried no quantized layers — nothing to bake",
            flush=True,
        )
        return
    metas = [
        k for k, v in text_encoder.state_dict().items()
        if getattr(v, "is_meta", False)
    ]
    if metas:
        raise ValueError(
            f"TE state_dict still has {len(metas)} meta tensors "
            f"(e.g. {metas[:5]}) — refusing to bake a partial file"
        )
    print(
        f"[ULL][minimax] TE dequant: {n_lin} linear + {n_emb} embedding "
        f"module(s) -> bf16; baking to {baked}",
        flush=True,
    )
    tmp = f"{baked}.tmp.{os.getpid()}"
    os.makedirs(os.path.dirname(baked), exist_ok=True)

    def _write():
        cpu_sd = {}
        for k, v in text_encoder.state_dict().items():
            t = v.detach().to("cpu")
            if t.is_floating_point() and t.dtype != torch.bfloat16:
                t = t.to(torch.bfloat16)
            cpu_sd[k] = t.contiguous()
        save_file(
            cpu_sd,
            tmp,
            metadata={
                "format": "pt",
                "ull_baked_from": "qwen3vl_32b_minimax_h3_nvfp4_awq",
            },
        )
        cpu_sd.clear()

    _ull_h3_te_with_heartbeat("baking bf16 text_encoder", _write)
    os.replace(tmp, baked)
    flush()
    print(
        f"[ULL][minimax] baked bf16 text_encoder saved to {baked} "
        f"({os.path.getsize(baked) / 1e9:.1f} GB)",
        flush=True,
    )
    _ull_h3_te_commit_volume()


def _ull_h3_te_load_baked(self, baked):
    """Rebuild the Qwen3VLTextEncoder skeleton exactly as _load_text_encoder's
    non-quantized branch does, then load the baked bf16 state_dict into it."""
    from accelerate import init_empty_weights
    from transformers import AutoConfig

    config = AutoConfig.from_pretrained(ORIGINAL_REPO, subfolder="FL2VA/text_encoder")
    config.text_config.num_hidden_layers = TEXT_ENCODER_LAYER
    config.tie_word_embeddings = False
    with init_empty_weights():
        text_encoder = Qwen3VLTextEncoder(config)
    text_encoder.lm_head = None

    sd = load_file(baked)
    result = text_encoder.load_state_dict(sd, assign=True, strict=False)
    sd.clear()

    # The baked state_dict was taken AFTER the stock loader neutralises these
    # (lm_head -> None, final norm -> Identity), so they are legitimately
    # absent from the file. Neutralise them here BEFORE the completeness check
    # so their empty-weights placeholders don't read as "uninitialised".
    allowed_missing = ("lm_head", "model.language_model.norm")
    text_encoder.model.language_model.norm = torch.nn.Identity()

    bad_missing = [
        k for k in result.missing_keys if not k.startswith(allowed_missing)
    ]
    if bad_missing or result.unexpected_keys:
        raise ValueError(
            f"baked TE key mismatch: missing {bad_missing[:6]}, "
            f"unexpected {list(result.unexpected_keys)[:6]}"
        )
    still_meta = [
        n
        for n, t in (
            list(text_encoder.named_parameters()) + list(text_encoder.named_buffers())
        )
        if getattr(t, "is_meta", False) and not n.startswith(allowed_missing)
    ]
    if still_meta:
        raise ValueError(
            f"baked TE has {len(still_meta)} uninitialised tensor(s) "
            f"(e.g. {still_meta[:5]}) — baked file is incomplete"
        )

    text_encoder.eval()
    text_encoder.requires_grad_(False)
    flush()
    return text_encoder


# import_comfy_quantized_layers is a module global (from ... import) that
# _load_text_encoder calls by name — rebind it so the AWQ-unpack cost is
# still logged whenever the BAKE (first run) path hits it.
try:
    _ull_te_orig_iccl = import_comfy_quantized_layers

    def _ull_te_timed_iccl(*_a, **_k):
        _t = _ull_te_time.time()
        try:
            return _ull_te_orig_iccl(*_a, **_k)
        finally:
            print(
                f"[ULL][minimax][te-probe] import_comfy_quantized_layers: "
                f"{_ull_te_time.time() - _t:.1f}s",
                flush=True,
            )

    import_comfy_quantized_layers = _ull_te_timed_iccl
except Exception as _e:  # noqa: BLE001
    print(f"[ULL][minimax][te-probe] iccl wrap skipped: {_e!r}", flush=True)

try:
    _ull_te_orig_load = MinimaxH3Model._load_text_encoder

    def _ull_te_load(self):
        _t0 = _ull_te_time.time()
        try:
            # --- SKIP: a baked bf16 TE is already on the Volume --------------
            if not _ULL_H3_TE_DISABLED and _ull_te_baked_ready():
                try:
                    self.print_and_status_update(
                        f"Loading pre-baked bf16 text_encoder (skipping nvfp4 "
                        f"dequant): {_ULL_H3_TE_BAKED}"
                    )
                    from transformers import AutoProcessor, AutoTokenizer

                    tokenizer = AutoTokenizer.from_pretrained(
                        ORIGINAL_REPO, subfolder="FL2VA/tokenizer"
                    )
                    processor = AutoProcessor.from_pretrained(
                        ORIGINAL_REPO, subfolder="FL2VA/processor"
                    )
                    text_encoder = _ull_h3_te_with_heartbeat(
                        "loading baked text_encoder",
                        lambda: _ull_h3_te_load_baked(self, _ULL_H3_TE_BAKED),
                    )
                    print(
                        "[ULL][minimax] baked bf16 text_encoder loaded "
                        "(skipping nvfp4 dequant)",
                        flush=True,
                    )
                    return tokenizer, processor, text_encoder
                except Exception as _se:  # noqa: BLE001
                    print(
                        f"[ULL][minimax] baked TE load failed ({_se!r}) — "
                        f"falling back to nvfp4 dequant",
                        flush=True,
                    )

            # --- normal load: nvfp4 read + AWQ unpack -----------------------
            result = _ull_te_orig_load(self)

            # --- BAKE: first run — dequantize to bf16 + persist -------------
            if not _ULL_H3_TE_DISABLED and not _ull_te_baked_ready():
                try:
                    _tok, _proc, _te = result
                    _ull_h3_te_bake(_te, _ULL_H3_TE_BAKED)
                except Exception as _be:  # noqa: BLE001
                    print(
                        f"[ULL][minimax] TE bake skipped ({_be!r}) — training "
                        f"continues with the in-memory nvfp4 TE",
                        flush=True,
                    )
            return result
        finally:
            print(
                f"[ULL][minimax][te-probe] _load_text_encoder TOTAL: "
                f"{_ull_te_time.time() - _t0:.1f}s",
                flush=True,
            )

    MinimaxH3Model._load_text_encoder = _ull_te_load
    print(
        "[aitk-patch] minimax_h3.py — installed TE Bake and Skip (Phase B)",
        flush=True,
    )
except Exception as _e:  # noqa: BLE001
    print(f"[ULL][minimax][te-probe] load wrap skipped: {_e!r}", flush=True)
# ===== END INJECTED BY ULL STUDIO PATCH =====
'''

    try:
        if not minimax_file.exists():
            print(f"[aitk-patch] {minimax_file} not found — skipping MiniMax H3 patches", flush=True)
        else:
            _mm = minimax_file.read_text(encoding="utf-8")
            if _H3_BAKE_MARKER in _mm:
                print("[aitk-patch] minimax_h3.py bake-and-skip patch already applied — skipping", flush=True)
            else:
                _mm += _H3_BAKE_PATCH
                minimax_file.write_text(_mm, encoding="utf-8")
                print("[aitk-patch] patched minimax_h3.py — int8_convrot dequant Bake & Skip", flush=True)
            if _H3_TE_PROBE_MARKER in _mm:
                print("[aitk-patch] minimax_h3.py TE Bake & Skip already applied — skipping", flush=True)
            else:
                minimax_file.write_text(_mm + _H3_TE_PROBE_PATCH, encoding="utf-8")
                print("[aitk-patch] patched minimax_h3.py — TE Bake & Skip (Phase B)", flush=True)
    except Exception as _patch_exc:  # noqa: BLE001 — best-effort
        print(f"[aitk-patch] minimax_h3.py patch skipped: {_patch_exc}", flush=True)

    # --- SDXL `variant` resolution patch ------------------------------------
    # ai-toolkit's SDXL loader (toolkit/stable_diffusion_model.py, the is_xl
    # branch) calls StableDiffusionXLPipeline.from_pretrained() with variant
    # hard-commented-out and never reads model_config.model_kwargs. A repo that
    # ships ONLY *.fp16.safetensors component files (RunDiffusion/Juggernaut-XL-
    # v9) then fails: diffusers' fp16 auto-fallback needs a Hub round-trip to
    # confirm no plain-variant file exists, which the Volume-local cache can't
    # answer -> LocalEntryNotFoundError. Inject a `variant` into load_args right
    # before that from_pretrained: from model_kwargs.variant when set, else
    # "fp16" for any Juggernaut repo. Idempotent (marker check); a no-op for
    # every other SDXL preset (illustrious_xl ships plain-variant weights and
    # sets no model_kwargs, so neither branch fires).
    sdm_file = pathlib.Path(AI_TOOLKIT_DIR) / "toolkit/stable_diffusion_model.py"
    _SDXL_VARIANT_MARKER = "INJECTED BY ULL STUDIO PATCH"
    # Inject right before the is_xl/ssd/vega branch. `model_path` and `load_args`
    # are both already in scope by then (built ~15 lines above).
    _SDXL_ANCHOR = "        if self.model_config.is_xl or self.model_config.is_ssd or self.model_config.is_vega:\n"
    _SDXL_INJECT = (
        "        # --- INJECTED BY ULL STUDIO PATCH (variant for fp16-only SDXL repos) ---\n"
        "        if getattr(self.model_config, \"model_kwargs\", None) and \"variant\" in self.model_config.model_kwargs:\n"
        "            load_args[\"variant\"] = self.model_config.model_kwargs[\"variant\"]\n"
        "        elif \"Juggernaut\" in model_path or \"juggernaut\" in model_path.lower():\n"
        "            load_args[\"variant\"] = \"fp16\"\n"
        "        # ---------------------------------------------------------------------\n"
        "        if self.model_config.is_xl or self.model_config.is_ssd or self.model_config.is_vega:\n"
    )
    try:
        if not sdm_file.exists():
            print(f"[aitk-patch] {sdm_file} not found — skipping SDXL variant patch", flush=True)
        else:
            _sdm = sdm_file.read_text(encoding="utf-8")
            if _SDXL_VARIANT_MARKER in _sdm:
                print("[aitk-patch] stable_diffusion_model.py SDXL variant patch already applied — skipping", flush=True)
            elif _sdm.count(_SDXL_ANCHOR) == 1:
                sdm_file.write_text(_sdm.replace(_SDXL_ANCHOR, _SDXL_INJECT, 1), encoding="utf-8")
                print("[aitk-patch] patched stable_diffusion_model.py — SDXL load_args['variant'] resolution", flush=True)
            else:
                print(f"[aitk-patch] stable_diffusion_model.py anchor matched {_sdm.count(_SDXL_ANCHOR)}x (expected 1) — skipping SDXL variant patch", flush=True)
    except Exception as _patch_exc:  # noqa: BLE001 — best-effort
        print(f"[aitk-patch] stable_diffusion_model.py SDXL variant patch skipped: {_patch_exc}", flush=True)

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
                                f"({projected_total / 3600:.2f}h) exceeds the cost-guard limit "
                                f"({safety_limit_s / 3600:.2f}h). Credits have been fully refunded. "
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
    """dataset_id keys the persisted-caption cache (and the VAE-latent /
    Smart-Ingest caches) on the Volume. Prefer the caller's value; otherwise
    take the 2nd segment of the first storage key ("<user_id>/<dataset_id>/
    <file>"). Sanitised to a safe path segment.

    The caption FORMAT is folded in as a "__dense" / "__tags" suffix so a
    dense run and a tags run of the SAME images get physically separate
    cache directories — a stale tag cache must never resurface on a later
    dense run and silently overwrite its captions (the yukipas Dense→tags
    swap). Idempotent: re-deriving from an already-suffixed id is a no-op,
    so the dispatcher can pass the derived value straight to the ingest
    helper."""
    raw = str(params.get("dataset_id") or "").strip()
    if not raw:
        for key in params.get("storage_paths") or []:
            parts = str(key).strip("/").split("/")
            if len(parts) >= 2:
                raw = parts[1]
                break
    raw = re.sub(r"[^A-Za-z0-9._-]", "", raw)
    if not raw:
        return ""
    mode = str(params.get("caption_mode") or "").strip().lower()
    if mode in ("dense", "tags") and not (raw.endswith("__dense") or raw.endswith("__tags")):
        raw = f"{raw[:56]}__{mode}"
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


# ---------------------------------------------------------------------------
# ULL Smart Ingest — CPU-side dataset optimisation (see ingest_and_optimize_
# dataset_cpu). Bake EXIF orientation, high-quality LANCZOS downscale (never
# upscale) to a training-appropriate long edge, strip metadata, re-encode to
# a compact uniform format. Output lands on the Volume at
# PERSIST_ROOT/<dataset_id>/_ingest/<ingest_key>/NNNN<INGEST_EXT> and the GPU
# job copies it verbatim (zero Supabase re-download, zero GPU-side resize).
# ---------------------------------------------------------------------------
INGEST_VERSION = 1            # bump -> every dataset re-ingests (the key changes)
INGEST_FMT = "WEBP"
INGEST_EXT = ".webp"
INGEST_QUALITY = 95
INGEST_WEBP_METHOD = 6
# resolution (512/768/1024) -> the training res * 1.5, rounded to a multiple
# of 8, as the target LONG edge. The 1.5x headroom covers ai-toolkit's
# aspect-ratio bucketing / crop without paying to VAE-encode pixels we'd
# never use.
INGEST_LONG_EDGE = {512: 768, 768: 1152, 1024: 1536}
INGEST_LONG_EDGE_DEFAULT = 1152
INGEST_LONG_EDGE_OVERRIDE = 2048   # raw-YAML: resolution can't be parsed -> generous


def _ingest_cache_key(long_edge: int) -> str:
    """The <key> in PERSIST_ROOT/<dataset_id>/_ingest/<key>/. Encodes every
    ingest parameter so a change to any of them yields a different directory
    (== a fresh re-ingest, the old one aged out by the 14d TTL)."""
    return (
        f"e{long_edge}_{INGEST_FMT.lower()}q{INGEST_QUALITY}"
        f"m{INGEST_WEBP_METHOD}_v{INGEST_VERSION}"
    )


def _ingest_long_edge(resolution: int, override: bool) -> int:
    if override:
        return INGEST_LONG_EDGE_OVERRIDE
    res = resolution if resolution in (512, 768, 1024) else 768
    return INGEST_LONG_EDGE.get(res, INGEST_LONG_EDGE_DEFAULT)


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
    secrets=[
        modal.Secret.from_name("supabase-model-downloads"),
        modal.Secret.from_name("wan-animate-auth"),
        modal.Secret.from_name("huggingface-secret"),
    ],
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
    # ---- FIRST THING: sync the Volume + seal the network ------------------
    # 1) Pull the CPU pre-cache stage's just-committed snapshot into this
    #    container's Volume view. MUST be the very first call — every model
    #    load below reads from disk and the CPU commit is only visible after
    #    an explicit reload.
    try:
        vol.reload()
        print("[train] vol.reload() — synced CPU pre-cache snapshot", flush=True)
    except Exception as _re:  # noqa: BLE001
        print(f"[train] vol.reload() skipped: {_re}", flush=True)

    # 2) EXACT same cache env dict the CPU stage snapshot_download'd into
    #    (HF_HOME=/models/training/hf_cache, MODELS_PATH=/models, …) — a
    #    mismatch here is a silent GPU-side re-download.
    _apply_hf_cache_env()

    # 3) NO HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE seal here. Hard offline mode
    #    also blocks the few-byte metadata HEAD requests transformers /
    #    huggingface_hub issue to *resolve* a local cache entry, which made
    #    from_pretrained() raise LocalEntryNotFoundError even though every
    #    weight was physically present on the Volume. The real download guard
    #    is _missing_base_artifacts() below: the CPU dispatcher pre-staged the
    #    full component tree and this job self-aborts (Fail-Fast RuntimeError)
    #    in the first seconds if any artefact is missing — so a genuine 30GB+
    #    Hub pull can never start regardless of the offline flags.

    # Normalise the HF token (or scrub the deploy placeholder so ai-toolkit's
    # own hf_hub_download for the tokenizer never auths with a bogus value).
    if not _hf_token():
        for _k in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN", "HF_API_TOKEN"):
            os.environ.pop(_k, None)
    for _d in (HF_HUB_CACHE_DIR, TORCH_CACHE_DIR):
        pathlib.Path(_d).mkdir(parents=True, exist_ok=True)
    print(
        f"[train] HF_HOME={HF_CACHE_DIR} MODELS_PATH={MODELS_DIR} "
        "(Volume-local; download guard = _missing_base_artifacts Fail-Fast)",
        flush=True,
    )

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
        # ---- FAIL-FAST: model must already be on the Volume -----------------
        # The CPU dispatcher ran ensure_model_cached_cpu to completion AND
        # verified the result before spawning this GPU. This check is the sole
        # download guard now (no HF_HUB_OFFLINE pin): a missing artefact means a
        # Hub pull would be needed, so we hard-abort instead of letting it run.
        # If any weight / config artefact is missing, self-abort in the
        # first seconds (scaledown_window=30) — 0s of wasted B300 time. Inside
        # `try` so the handler below refunds it 100% (GUI mode). Raw-YAML jobs
        # point name_or_path somewhere unparseable and are exempt.
        if not override:
            _missing = _missing_base_artifacts(target_model, custom_model_id)
            if _missing:
                print(f"[train] ABORT — model not on Volume: {_missing}", flush=True)
                raise RuntimeError(
                    "CRITICAL: Model not found in /models. GPU download is strictly blocked."
                )

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

        # --- Smart Ingest fast-path: the dispatcher already downloaded +
        #     optimised these images onto the Volume. Copy from there — no
        #     Supabase round-trip, and the GPU never resizes a 4K source.
        ingest_rel = str(params.get("ingest_dir") or "").strip().strip("/")
        staged_from_ingest = False
        if ingest_rel and ".." not in ingest_rel:
            try:
                vol.reload()
            except Exception:  # noqa: BLE001
                pass
            ingest_src = pathlib.Path(PERSIST_ROOT) / ingest_rel
            if ingest_src.is_dir():
                found = sorted(
                    p for p in ingest_src.iterdir()
                    if p.is_file() and p.stat().st_size > 0
                    and p.suffix.lower() in IMAGE_EXTS
                )
                if found and (not storage_paths or len(found) == len(storage_paths)):
                    for i, src in enumerate(found):
                        dest = dataset / f"{i:04d}{src.suffix.lower()}"
                        shutil.copy2(src, dest)
                        image_paths.append(dest)
                    staged_from_ingest = True
                    print(
                        f"[train] staged {len(image_paths)} pre-optimized images "
                        f"from {ingest_src} (Smart Ingest — no Supabase download)",
                        flush=True,
                    )

        if staged_from_ingest:
            pass  # images already in /root/dataset
        elif storage_paths:
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

        supplied_any = False
        for idx, path in enumerate(image_paths):
            cap = _custom_caption_for(idx, path)
            if not cap and idx < len(supplied):
                cap = (supplied[idx] or "").strip()
            if cap:
                path.with_suffix(".txt").write_text(cap, encoding="utf-8")
                supplied_any = True

        # The frontend handed us real caption text for THIS run (Dense prose,
        # curated edits, a .txt / ZIP set, semi-auto fills, …). That text is
        # AUTHORITATIVE and has already been written above — the Volume caption
        # cache must not be consulted, and above all must never overwrite it.
        # The cache for the same dataset_id can hold a DIFFERENT format from an
        # earlier run (the yukipas Dense→tags swap); reusing it here silently
        # replaced confirmed Dense captions with a stale tag list. The cache
        # fast-path stays available ONLY when the browser sent nothing at all
        # (a pure pending-timeout re-dispatch, or a total cloud-caption outage
        # with skip_captioning unset).
        frontend_supplied_captions = bring_your_own or supplied_any

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
        elif frontend_supplied_captions:
            # Supplied captions win, unconditionally — never touch the cache.
            if persist_dir and persist_dir.is_dir():
                print(
                    f"[train] frontend supplied captions — Volume caption cache "
                    f"{persist_dir} left untouched (not reused)",
                    flush=True,
                )
        elif persist_dir and persist_dir.is_dir():
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
        # Dynamic cost cap: credit-covered seconds, widened by
        # ULL_COST_GUARD_MULTIPLIER and floored by the per-arch expected run
        # time so a legit heavy run (MiniMax H3 3000 steps @ ~5s/it) never
        # false-aborts a few minutes short. Overrunning it is still a graceful
        # stop + 100% refund; a true runaway still trips the projected-time
        # check above this (higher) threshold.
        cost_cap_s, _cap_reason = _cost_cap_seconds(
            credits_cost, target_model, total_steps or 0, base_architecture
        )
        print(f"[stage2] cost cap: {_cap_reason}", flush=True)
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
    # pyyaml: the module now `import yaml` at top level (used by _build_config);
    # every dispatch_image endpoint imports this module, so it must resolve here
    # too, not just in the training `image`.
    .pip_install(
        # `requests` is REQUIRED: _supabase_request / _patch_job / _refund_credits
        # all `import requests`. Without it every job-status PATCH and every
        # credit refund from a dispatch-image function (_prepare_and_spawn_training,
        # ensure_model_cached_cpu, check_call_status, …) throws
        # ModuleNotFoundError — which _patch_job swallows, so a failed or finished
        # job never leaves "processing" in the UI (it just "進まない").
        "fastapi[standard]", "modal", "grpclib", "huggingface_hub>=0.24", "hf_transfer", "pyyaml", "requests"
    )
    # Same canonical HF cache env as the training image — ensure_model_cached_cpu
    # snapshot_download's into exactly the path the GPU later reads from.
    .env(_hf_cache_env())
)

# Smart Ingest image = dispatch_image (tiny, warm base) + Pillow. Inherits
# dispatch_image rather than rebuilding from debian_slim so this module's
# top-level `import fastapi / modal / yaml` still resolve inside the container.
ingest_image = dispatch_image.pip_install("Pillow>=10.2")


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
# Wan 2.1: ai-toolkit resolves its components from the ComfyUI folder layout
# under MODELS_PATH by their EXACT (case-sensitive) filenames — see
# toolkit/models/v2/{diffusion_models/wan,text_encoders/umt5,resolver}.py.
# ensure_model_cached_cpu places these on the Volume before the GPU spawns
# (hardlink from an existing case-variant, else a single-file pull from
# Comfy-Org — never the 55GB Diffusers repo).
# Wan 2.1 RETIRED (the wan21_* presets were removed) — layout kept empty so
# _wan_target() returns None everywhere and nothing pre-stages these files.
_WAN_COMFY_LAYOUT: dict[str, list[tuple[str, list[str]]]] = {
    # "wan21_14b": [
    #     ("diffusion_models/wan2.1_t2v_14B_bf16.safetensors", ["diffusion_models/wan2.1_t2v_14b_bf16.safetensors"]),
    #     ("text_encoders/umt5_xxl_fp16.safetensors", []),
    #     ("vae/wan_2.1_vae.safetensors", []),
    # ],
    # "wan21_1.3b": [
    #     ("diffusion_models/wan2.1_t2v_1.3B_bf16.safetensors", ["diffusion_models/wan2.1_t2v_1.3b_bf16.safetensors"]),
    #     ("text_encoders/umt5_xxl_fp16.safetensors", []),
    #     ("vae/wan_2.1_vae.safetensors", []),
    # ],
}
# Leftover Wan 2.1 comfy DIT files admin_cleanup_volume(purge_retired_wan21=True)
# removes. Deliberately NOT touching text_encoders/umt5_xxl_fp16.safetensors or
# vae/wan_2.1_vae.safetensors — those may be shared with the wan-animate app on
# the same Volume.
_WAN21_RETIRED_DIT_FILES = [
    "diffusion_models/wan2.1_t2v_14B_bf16.safetensors",
    "diffusion_models/wan2.1_t2v_14b_bf16.safetensors",
    "diffusion_models/wan2.1_t2v_1.3B_bf16.safetensors",
    "diffusion_models/wan2.1_t2v_1.3b_bf16.safetensors",
]
_WAN_COMFY_REPO = "Comfy-Org/Wan_2.1_ComfyUI_repackaged"
# ai-toolkit's default UMT5 tokenizer/config repo (weights come from the comfy
# file above; this is just tokenizer.json / config.json, a few MB).
_WAN_TOKENIZER_REPO = "ai-toolkit/umt5_xxl_encoder"


def _wan_target(target_model: str) -> str | None:
    """Map a target id / bare 'wan21' arch to a concrete _WAN_COMFY_LAYOUT key
    (None once Wan 2.1 is retired and _WAN_COMFY_LAYOUT is empty)."""
    if target_model in _WAN_COMFY_LAYOUT:
        return target_model
    if target_model == "wan21" or TARGET_MODELS.get(target_model, {}).get("arch") == "wan21":
        return "wan21_14b" if "wan21_14b" in _WAN_COMFY_LAYOUT else None
    return None


def _hf_repos_for(target_model: str, custom_model_id: str = "") -> list[str]:
    """Every HF repo id this job's base model needs pre-downloaded — the
    transformer/base repo AND any separate text-encoder / VAE repo the arch
    hard-wires (e.g. FLUX.2 Klein: TE=Qwen/Qwen3-*, VAE=ai-toolkit/flux2_vae).
    Empty for a single-file Volume model (minimax_h3). Wan 2.1 only needs the
    tiny UMT5 tokenizer repo here — its multi-GB weights are placed as
    ComfyUI-layout single files by _ensure_wan_comfy_layout()."""

    def _is_repo(v) -> bool:
        s = str(v or "")
        return bool(s) and "/" in s and not s.startswith(("http://", "https://", "/", MODELS_DIR))

    if _wan_target(target_model):
        return [_WAN_TOKENIZER_REPO]

    if target_model == "custom":
        return [custom_model_id] if _is_repo(custom_model_id) else []

    entry = TARGET_MODELS.get(target_model)
    if entry is None:  # a bare arch string ("sdxl", "wan21", ...)
        entry = next((t for t in TARGET_MODELS.values() if t.get("arch") == target_model), None)
    if entry is None:
        return []
    repos = [entry[k] for k in ("unet", "text_encoder", "vae", "extras") if _is_repo(entry.get(k))]
    return list(dict.fromkeys(repos))


def _wan_comfy_missing(target_model: str) -> list[str]:
    """ComfyUI-layout files ai-toolkit needs for this Wan target that are NOT
    yet on the Volume at their exact path."""
    key = _wan_target(target_model)
    if not key:
        return []
    missing = []
    for rel, _variants in _WAN_COMFY_LAYOUT[key]:
        p = pathlib.Path(MODELS_DIR) / rel
        if not (p.is_file() and p.stat().st_size > 0):
            missing.append(rel)
    return missing


def _ensure_wan_comfy_layout(target_model: str) -> dict:
    """Place every ComfyUI-layout file ai-toolkit's Wan loader expects, at its
    EXACT case-sensitive path under MODELS_DIR. Hardlink from an on-Volume
    case-variant when possible (0 bytes copied); else pull the single file
    from Comfy-Org. Never fetches the 55GB Diffusers repo."""
    key = _wan_target(target_model)
    if not key:
        return {"ok": True, "placed": []}
    from huggingface_hub import hf_hub_download

    placed: list[str] = []
    fetched: list[str] = []
    for rel, variants in _WAN_COMFY_LAYOUT[key]:
        dst = pathlib.Path(MODELS_DIR) / rel
        if dst.is_file() and dst.stat().st_size > 0:
            placed.append(rel)
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        done = False
        for v in variants:
            src = pathlib.Path(MODELS_DIR) / v
            if src.is_file() and src.stat().st_size > 0:
                try:
                    os.link(src, dst)
                except OSError:
                    shutil.copy2(src, dst)
                placed.append(rel)
                done = True
                print(f"[cache][wan] linked {v} -> {rel}", flush=True)
                break
        if done:
            continue
        try:
            t0 = time.time()
            p = hf_hub_download(
                repo_id=_WAN_COMFY_REPO,
                filename=f"split_files/{rel}",
                local_dir=str(MODELS_DIR),
                token=_hf_token(),
            )
            if os.path.abspath(p) != os.path.abspath(str(dst)):
                os.replace(p, dst)
            fetched.append(rel)
            placed.append(rel)
            print(f"[cache][wan] fetched {rel} in {time.time() - t0:.0f}s", flush=True)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "missing": rel, "error": str(exc)[:400]}
    return {"ok": True, "placed": placed, "fetched": fetched}


# ---------------------------------------------------------------------------
# Qwen-Image: SAME ComfyUI-single-file story as Wan. ai-toolkit's qwen_image
# loader resolves the TRANSFORMER from a Comfy-Org repackaged single file it
# looks for under MODELS_PATH (toolkit/models/v2/diffusion_models/qwen_image +
# its resolver) — it never reads the 9-shard / ~40GB transformer weights out of
# the "Qwen/Qwen-Image" Diffusers repo. The text encoder / VAE / tokenizer /
# every config.json DO come from that HF repo (Qwen25VLTextEncoder.load_model /
# QwenImageVAE.load_model are hard-wired to base_model_path="Qwen/Qwen-Image"),
# so it is snapshot'd too — just with the transformer shards ignored.
_QWEN_IMAGE_HF_REPO = "Qwen/Qwen-Image"
_QWEN_COMFY_REPO = "Comfy-Org/Qwen-Image_ComfyUI"
# (path under MODELS_DIR, filename in _QWEN_COMFY_REPO)
_QWEN_COMFY_FILES: list[tuple[str, str]] = [
    (
        "diffusion_models/qwen_image_bf16.safetensors",
        "split_files/diffusion_models/qwen_image_bf16.safetensors",
    ),
]
# snapshot_download ignore-patterns per repo — the Comfy single file above
# replaces these weight shards, so pulling them from the Diffusers repo too
# would just double a 40GB download. `transformer/config.json` is kept (diffusers
# from_single_file needs it).
_REPO_SNAPSHOT_IGNORE: dict[str, list[str]] = {
    _QWEN_IMAGE_HF_REPO: [
        "transformer/*.safetensors",
        "transformer/*.safetensors.index.json",
        "transformer/*.bin",
        "transformer/*.pth",
    ],
}

# The exact files ai-toolkit's qwen_image loader physically opens from the
# Qwen/Qwen-Image Diffusers snapshot (tokenizer + Qwen2.5-VL text encoder +
# VAE + scheduler + the diffusers configs). snapshot_download's own
# local_files_only check trusts the cached repo *listing* — an interrupted
# pull can leave that listing intact while the blobs behind the snapshot
# symlinks are missing / 0-byte. So the completeness gate below resolves each
# of these through its symlink and stat()s the real file. A single miss ==
# incomplete remnant -> re-download (and, if it persists, purge + clean pull).
_QWEN_REPO_CRITICAL_FILES: list[str] = [
    "model_index.json",
    "scheduler/scheduler_config.json",
    "tokenizer/tokenizer_config.json",
    "tokenizer/vocab.json",
    "tokenizer/merges.txt",
    "tokenizer/special_tokens_map.json",
    "text_encoder/config.json",
    "text_encoder/model.safetensors.index.json",
    "text_encoder/model-00001-of-00004.safetensors",
    "text_encoder/model-00002-of-00004.safetensors",
    "text_encoder/model-00003-of-00004.safetensors",
    "text_encoder/model-00004-of-00004.safetensors",
    "vae/config.json",
    "vae/diffusion_pytorch_model.safetensors",
    "transformer/config.json",
]


def _qwen_repo_cache_dir() -> pathlib.Path:
    slug = "models--" + _QWEN_IMAGE_HF_REPO.replace("/", "--")
    return pathlib.Path(HF_HUB_CACHE_DIR) / slug


def _qwen_snapshot_dir() -> "pathlib.Path | None":
    """Local snapshot revision dir for Qwen/Qwen-Image that snapshot_download
    would resolve to — the commit in refs/main, else the newest dir, else None."""
    root = _qwen_repo_cache_dir()
    snap_root = root / "snapshots"
    if not snap_root.is_dir():
        return None
    ref = root / "refs" / "main"
    try:
        if ref.is_file():
            rev = (snap_root / ref.read_text().strip())
            if rev.is_dir():
                return rev
    except OSError:
        pass
    revs = [r for r in snap_root.iterdir() if r.is_dir()]
    if not revs:
        return None
    return max(revs, key=lambda r: r.stat().st_mtime)


def _qwen_missing_critical_files() -> list[str]:
    """Repo-relative critical files NOT physically present (blob symlink
    followed) + non-zero on disk in the local Qwen/Qwen-Image snapshot.
    Non-empty == incomplete remnant."""
    snap = _qwen_snapshot_dir()
    if snap is None:
        return list(_QWEN_REPO_CRITICAL_FILES)
    missing: list[str] = []
    for rel in _QWEN_REPO_CRITICAL_FILES:
        p = snap / rel
        try:
            real = p.resolve()
            if not (os.path.exists(real) and os.path.isfile(real) and os.path.getsize(real) > 0):
                missing.append(rel)
        except OSError:
            missing.append(rel)
    return missing


def _qwen_repo_complete() -> bool:
    return not _qwen_missing_critical_files()


def _purge_qwen_snapshot() -> None:
    """Delete the whole Qwen/Qwen-Image hub-cache tree so the next
    snapshot_download starts from a clean slate (blobs, refs, snapshots)."""
    d = _qwen_repo_cache_dir()
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
        print(f"[cache][qwen] purged incomplete snapshot remnant -> {d}", flush=True)


def _is_qwen_image(target_model: str) -> bool:
    return (
        target_model == "qwen_image"
        or TARGET_MODELS.get(target_model, {}).get("arch") == "qwen_image"
    )


def _qwen_comfy_missing(target_model: str) -> list[str]:
    """ComfyUI-layout files ai-toolkit's qwen_image resolver needs that are NOT
    yet on the Volume at their exact MODELS_PATH-relative path."""
    if not _is_qwen_image(target_model):
        return []
    missing = []
    for rel, _repo_file in _QWEN_COMFY_FILES:
        p = pathlib.Path(MODELS_DIR) / rel
        if not (p.is_file() and p.stat().st_size > 0):
            missing.append(rel)
    return missing


def _ensure_qwen_comfy_layout(target_model: str) -> dict:
    """Place the Comfy-Org Qwen-Image transformer single file at its exact path
    under MODELS_DIR (and a hardlink at the repo-relative split_files/ path, so
    the resolver finds it whichever spelling it uses). Never fetches the 40GB
    Diffusers transformer."""
    if not _is_qwen_image(target_model):
        return {"ok": True, "placed": []}
    from huggingface_hub import hf_hub_download

    placed: list[str] = []
    fetched: list[str] = []
    for rel, repo_file in _QWEN_COMFY_FILES:
        dst = pathlib.Path(MODELS_DIR) / rel
        alt = pathlib.Path(MODELS_DIR) / repo_file  # split_files/... mirror
        if dst.is_file() and dst.stat().st_size > 0:
            placed.append(rel)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                t0 = time.time()
                p = hf_hub_download(
                    repo_id=_QWEN_COMFY_REPO,
                    filename=repo_file,
                    local_dir=str(MODELS_DIR),
                    token=_hf_token(),
                )
                if os.path.abspath(p) != os.path.abspath(str(dst)):
                    os.replace(p, dst)
                fetched.append(rel)
                placed.append(rel)
                print(f"[cache][qwen] fetched {rel} in {time.time() - t0:.0f}s", flush=True)
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "missing": rel, "error": str(exc)[:400]}
        # keep a 0-byte hardlink at the repo-relative path as a resolver safety net
        if not (alt.is_file() and alt.stat().st_size > 0):
            try:
                alt.parent.mkdir(parents=True, exist_ok=True)
                os.link(dst, alt)
            except OSError:
                pass
    return {"ok": True, "placed": placed, "fetched": fetched}


# ---------------------------------------------------------------------------
# MiniMax H3: the DiT / TE / VAE weights are hosted single files on the Volume
# (TARGET_MODELS["minimax_h3"] points at MODELS_DIR paths), so _hf_repos_for()
# is empty and the repo loop below never runs for it. BUT ai-toolkit's
# minimax_h3 loader ALWAYS calls AutoTokenizer/AutoProcessor.from_pretrained(
# "MiniMaxAI/MiniMax-H3", subfolder="FL2VA/tokenizer" | "FL2VA/processor") and
# AutoConfig.from_pretrained(..., subfolder="FL2VA/text_encoder") — a small
# (~23MB) but mandatory set of config/tokenizer files that would otherwise be
# a GPU-side Hub fetch. Pre-stage exactly those into the Volume HF cache.
_MINIMAX_H3_AUX_REPO = "MiniMaxAI/MiniMax-H3"
_MINIMAX_H3_AUX_ALLOW = [
    "FL2VA/tokenizer/*",
    "FL2VA/processor/*",
    "FL2VA/text_encoder/config.json",
]
_MINIMAX_H3_AUX_CRITICAL = [
    "FL2VA/tokenizer/tokenizer_config.json",
    "FL2VA/tokenizer/tokenizer.json",
    "FL2VA/processor/preprocessor_config.json",
    "FL2VA/text_encoder/config.json",
]

# ---------------------------------------------------------------------------
# MiniMax H3 hosted single-file checkpoints (DiT / TE / VAE). TARGET_MODELS
# ["minimax_h3"] points ai-toolkit's minimax_h3 loader straight at these
# MODELS_DIR paths — there is NO Diffusers repo for it, so _hf_repos_for()
# yields [] and nothing else fetches them. ai-toolkit's MiniMaxH3Transformer
# is hard-wired to the fused `fl2va_pruned` int8_convrot state-dict layout, so
# we MUST pull those exact quant single files (a raw bf16 checkpoint crashes
# with "Unexpected key(s) in state_dict: blocks.0.adaln_proj.linear.bias …").
# Pulled once from Comfy-Org/MiniMax-H3 and vol.commit()'d to the Volume.
# NOTE: the TE lives under `clip/` locally (TARGET_MODELS path) but under
# `text_encoders/` in the repo — hence the (local rel, repo filename) pair.
_MINIMAX_H3_WEIGHT_REPO = "Comfy-Org/MiniMax-H3"
_MINIMAX_H3_WEIGHT_FILES: list[tuple[str, str]] = [
    (
        "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    ),
    (
        "clip/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    ),
    (
        "vae/minimax_h3_video_vae_fp16.safetensors",
        "vae/minimax_h3_video_vae_fp16.safetensors",
    ),
    # audio VAE (~0.6GB) — _load_vaes() loads it unconditionally even for
    # image LoRA training, so it must be on the Volume too.
    (
        "vae/minimax_h3_audio_vae_fp32.safetensors",
        "vae/minimax_h3_audio_vae_fp32.safetensors",
    ),
]


def _is_minimax_h3(target_model: str) -> bool:
    return (
        target_model == "minimax_h3"
        or TARGET_MODELS.get(target_model, {}).get("arch") == "minimax_h3"
    )


def _minimax_h3_snapshot_dir() -> "pathlib.Path | None":
    slug = "models--" + _MINIMAX_H3_AUX_REPO.replace("/", "--")
    root = pathlib.Path(HF_HUB_CACHE_DIR) / slug
    snap_root = root / "snapshots"
    if not snap_root.is_dir():
        return None
    ref = root / "refs" / "main"
    try:
        if ref.is_file():
            rev = snap_root / ref.read_text().strip()
            if rev.is_dir():
                return rev
    except OSError:
        pass
    revs = [r for r in snap_root.iterdir() if r.is_dir()]
    return max(revs, key=lambda r: r.stat().st_mtime) if revs else None


def _minimax_h3_aux_missing(target_model: str) -> list[str]:
    """Critical FL2VA config/tokenizer files ai-toolkit's minimax_h3 loader
    reads from MiniMaxAI/MiniMax-H3 that are NOT physically on the Volume."""
    if not _is_minimax_h3(target_model):
        return []
    snap = _minimax_h3_snapshot_dir()
    if snap is None:
        return list(_MINIMAX_H3_AUX_CRITICAL)
    missing: list[str] = []
    for rel in _MINIMAX_H3_AUX_CRITICAL:
        p = snap / rel
        try:
            real = p.resolve()
            if not (os.path.isfile(real) and os.path.getsize(real) > 0):
                missing.append(rel)
        except OSError:
            missing.append(rel)
    return missing


def _ensure_minimax_h3_aux(target_model: str) -> dict:
    """Snapshot just the FL2VA tokenizer/processor/text_encoder-config subset of
    MiniMaxAI/MiniMax-H3 into the Volume HF cache (never the 68GB weights)."""
    if not _is_minimax_h3(target_model):
        return {"ok": True, "fetched": False}
    if not _minimax_h3_aux_missing(target_model):
        return {"ok": True, "fetched": False}
    from huggingface_hub import snapshot_download

    for attempt in range(3):
        try:
            snapshot_download(
                repo_id=_MINIMAX_H3_AUX_REPO,
                allow_patterns=_MINIMAX_H3_AUX_ALLOW,
                max_workers=max(4, int(os.environ.get("HF_SNAPSHOT_WORKERS", "8") or "8")),
                token=_hf_token(),
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[cache][minimax] FL2VA config fetch attempt {attempt + 1}/3 failed: {str(exc)[:300]}", flush=True)
            time.sleep(3)
            continue
        if not _minimax_h3_aux_missing(target_model):
            return {"ok": True, "fetched": True}
    return {"ok": False, "missing": _minimax_h3_aux_missing(target_model)}


def _minimax_h3_weights_missing(target_model: str) -> list[str]:
    """The hosted quant DiT (fl2va_pruned int8_convrot) / TE (nvfp4_awq) / VAE
    single files ai-toolkit's minimax_h3 loader opens straight off the Volume
    that are NOT physically present at their exact MODELS_DIR path (0-byte /
    partial counts as missing)."""
    if not _is_minimax_h3(target_model):
        return []
    missing: list[str] = []
    for rel, _repo_file in _MINIMAX_H3_WEIGHT_FILES:
        p = pathlib.Path(MODELS_DIR) / rel
        if not (p.is_file() and p.stat().st_size > 0):
            missing.append(rel)
    return missing


def _ensure_minimax_h3_weights(target_model: str) -> dict:
    """Fetch the MiniMax H3 quant DiT (fl2va_pruned int8_convrot) / TE
    (nvfp4_awq) / VAE single files from Comfy-Org/MiniMax-H3 and place each at
    its exact MODELS_DIR path (the minimax_h3 loader reads them from there —
    see TARGET_MODELS). Pulled once, then vol.commit()'d by the caller.
    Idempotent: a file already on the Volume is skipped."""
    if not _is_minimax_h3(target_model):
        return {"ok": True, "placed": [], "fetched": []}
    from huggingface_hub import hf_hub_download

    placed: list[str] = []
    fetched: list[str] = []
    hf_tok = _hf_token()
    for rel, repo_file in _MINIMAX_H3_WEIGHT_FILES:
        dst = pathlib.Path(MODELS_DIR) / rel
        if dst.is_file() and dst.stat().st_size > 0:
            placed.append(rel)
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        last_err = ""
        for attempt in range(3):
            try:
                t0 = time.time()
                p = hf_hub_download(
                    repo_id=_MINIMAX_H3_WEIGHT_REPO,
                    filename=repo_file,
                    local_dir=str(MODELS_DIR),
                    token=hf_tok,
                )
                # TE downloads to MODELS_DIR/text_encoders/... but must land at
                # MODELS_DIR/clip/... — move it into place when the paths differ.
                if os.path.abspath(p) != os.path.abspath(str(dst)):
                    os.replace(p, dst)
                fetched.append(rel)
                placed.append(rel)
                print(f"[cache][minimax] fetched {rel} in {time.time() - t0:.0f}s", flush=True)
                break
            except Exception as exc:  # noqa: BLE001
                last_err = str(exc)[:400]
                print(f"[cache][minimax] {rel} fetch attempt {attempt + 1}/3 FAILED — {last_err}", flush=True)
                time.sleep(3)
        if not (dst.is_file() and dst.stat().st_size > 0):
            return {"ok": False, "missing": rel, "fetched": fetched, "error": last_err}
    return {"ok": True, "placed": placed, "fetched": fetched}


def _repo_cache_complete(repo_id: str, ignore_patterns: list[str] | None = None) -> bool:
    """STRICT local-only completeness check: every file huggingface_hub knows
    this repo has (minus `ignore_patterns`) is present in the Volume hub cache.
    snapshot_download(local_files_only=True) walks the cached repo listing and
    raises the moment one expected file is missing — far stronger than the bare
    dir scan below, so a half-finished CPU pre-cache can't green-light a $/min
    GPU. Returns False on ANY error (missing listing, missing file, HF quirk):
    the caller pairs it with the lenient check to avoid false job failures."""
    try:
        from huggingface_hub import snapshot_download
    except Exception:  # noqa: BLE001
        return False
    kw = {"ignore_patterns": ignore_patterns} if ignore_patterns else {}
    try:
        snapshot_download(repo_id=repo_id, local_files_only=True, **kw)
        return True
    except Exception:  # noqa: BLE001
        return False


def _repo_snapshot_present(repo_id: str) -> bool:
    """LENIENT local-only check that a HF repo's snapshot is on the Volume
    cache, at the EXACT path `_hf_cache_env()` points every stage to. Paired
    with `_repo_cache_complete` — a repo counts as "missing" only when BOTH
    fail, so a strict-check quirk never fails an otherwise-cached job.
    Requires the snapshot revision to hold at least one real file AND a
    config/metadata json (a bare dir or a half-written tree does not count)."""
    slug = "models--" + repo_id.replace("/", "--")
    snap_root = pathlib.Path(HF_HUB_CACHE_DIR) / slug / "snapshots"
    if not snap_root.is_dir():
        return False
    for rev in snap_root.iterdir():
        if not rev.is_dir():
            continue
        files = [p for p in rev.rglob("*") if p.is_file() or p.is_symlink()]
        if not files:
            continue
        has_json = any(p.name.endswith(".json") for p in files)
        has_payload = any(
            p.name.endswith((".safetensors", ".bin", ".gguf", ".pt", ".ckpt", ".model", ".pth", ".onnx", ".txt"))
            for p in files
        )
        if has_json or has_payload:
            return True
    return False


def _missing_base_artifacts(target_model: str, custom_model_id: str = "") -> list[str]:
    """Everything this job's base model needs that is NOT on the Volume yet:

      * HF repo snapshots absent / incomplete in the local hub cache — every
        repo the arch needs: the transformer/base repo AND any SEPARATE text-
        encoder / VAE repo ai-toolkit hard-wires (FLUX.2 Klein loads its TE from
        Qwen/Qwen3-*, its VAE from ai-toolkit/flux2_vae; Wan 2.1 needs the UMT5
        tokenizer repo). Qwen-Image's repo is cached transformer-shards-excluded.
      * Wan 2.1 / Qwen-Image ComfyUI-layout single files missing from their
        exact MODELS_PATH-relative path
      * hosted single-file checkpoints (minimax_h3) not on disk

    An empty list is the hard precondition for spawning the GPU: it means
    train_lora_job + the ai-toolkit subprocess can load every byte from local
    disk and will never call snapshot_download at B300 rates. Shared by the
    dispatcher's strict CPU-gate and the GPU's fail-fast self-abort so the two
    agree exactly."""
    missing: list[str] = []

    for repo in _hf_repos_for(target_model, custom_model_id):
        ignore = _REPO_SNAPSHOT_IGNORE.get(repo)
        if repo == _QWEN_IMAGE_HF_REPO:
            # Qwen-Image: NEVER the lenient listing check (it is what mistook an
            # incomplete remnant for a hit). Every critical tokenizer / TE / VAE
            # / scheduler / config file must be physically on disk.
            for rel in _qwen_missing_critical_files():
                missing.append(f"qwen-repo-file:{rel}")
            continue
        # "missing" only when BOTH the strict completeness check and the lenient
        # on-disk check fail — the CPU stage already verified strictly before
        # returning ok, so a lone strict-check quirk must not fail the job here.
        if not (_repo_cache_complete(repo, ignore) or _repo_snapshot_present(repo)):
            missing.append(f"hf-repo:{repo}")

    missing += [f"wan-file:{f}" for f in _wan_comfy_missing(target_model)]
    missing += [f"qwen-file:{f}" for f in _qwen_comfy_missing(target_model)]
    missing += [f"minimax-cfg:{f}" for f in _minimax_h3_aux_missing(target_model)]
    missing += [f"minimax-weight:{f}" for f in _minimax_h3_weights_missing(target_model)]

    entry = TARGET_MODELS.get(target_model)
    if entry is None:
        entry = next((t for t in TARGET_MODELS.values() if t.get("arch") == target_model), None)
    if entry:
        for k in ("unet", "text_encoder", "vae", "audio_vae"):
            v = str(entry.get(k) or "")
            if v.startswith(MODELS_DIR) and not pathlib.Path(v).is_file():
                missing.append(f"weight-file:{v}")

    return list(dict.fromkeys(missing))


@app.function(
    image=dispatch_image,
    # Some presets pull MULTIPLE repos totalling 100GB+ on a COLD Volume — e.g.
    # FLUX.2 [dev] = transformer + a 24B Mistral text encoder, or LTX-2's full
    # pipeline repo. 2h ceiling so a slow-but-progressing multi-repo fetch is
    # never killed mid-flight (a partial snapshot then forces the $/min GPU to
    # re-fetch). The dispatcher (_prepare_and_spawn_training, 3h) blocks on this.
    timeout=2 * 60 * 60,
    cpu=4,
    memory=8192,
    volumes={MODELS_DIR: vol},
    secrets=[
        modal.Secret.from_name("wan-animate-auth"),
        modal.Secret.from_name("huggingface-secret"),
    ],
)
def ensure_model_cached_cpu(model_arch: str, custom_model_id: str = "") -> dict:
    """Stage 1. Guarantee every HF component of the base model is on the
    persistent Volume HF cache. Cache hit -> returns in ~0.1s. Cache miss ->
    hf_transfer snapshot_download (parallel) then vol.commit(). A
    single-file / Volume model (minimax_h3 etc.) is a no-op here."""
    # Byte-identical to the GPU's cache env (train_lora_job) — the whole point
    # of this stage is that what we snapshot_download here is a guaranteed
    # local hit there.
    _apply_hf_cache_env()

    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] vol.reload skipped: {exc}", flush=True)
    pathlib.Path(HF_HUB_CACHE_DIR).mkdir(parents=True, exist_ok=True)
    pathlib.Path(TORCH_CACHE_DIR).mkdir(parents=True, exist_ok=True)

    # Wan 2.1: place the ComfyUI-layout single files at their exact paths
    # BEFORE the GPU. (Hardlink from an on-Volume case-variant / single-file
    # pull — never the 55GB Diffusers repo.)
    wan_key = _wan_target(str(model_arch or ""))
    if wan_key:
        wan_res = _ensure_wan_comfy_layout(str(model_arch or ""))
        if not wan_res.get("ok"):
            return {"ok": False, "cached": False, "repo": wan_res.get("missing"), "error": wan_res.get("error")}
        if wan_res.get("fetched"):
            try:
                vol.commit()
                print(f"[cache][wan] vol.commit() — {wan_res['fetched']}", flush=True)
            except Exception as exc:  # noqa: BLE001
                print(f"[cache][wan] vol.commit skipped: {exc}", flush=True)

    # Qwen-Image: two halves, both placed on the Volume BEFORE the GPU.
    #  (a) the Comfy-Org repackaged TRANSFORMER single file where ai-toolkit's
    #      resolver looks (MODELS_PATH/diffusion_models/...).
    #  (b) the full Qwen/Qwen-Image DIFFUSERS snapshot MINUS the transformer
    #      weight shards — tokenizer/, text_encoder/, vae/, scheduler/ and every
    #      config.json / model_index.json. ai-toolkit's Qwen25VLTextEncoder
    #      .load_tokenizer / .load_model + QwenImageVAE.load_model read these
    #      straight from HF_HOME by repo id; the GPU has no network token, so a
    #      single missing file there is a hard stop (the tokenizer-config crash
    #      this fixes). Forced every run (snapshot_download is idempotent +
    #      resumable — a genuine cache hit is a fast re-verify) rather than
    #      trusting the completeness gate in the repo loop below, which a stale
    #      transformer-only half-cache from an older deploy could wrongly
    #      green-light.
    if _is_qwen_image(str(model_arch or "")):
        qwen_res = _ensure_qwen_comfy_layout(str(model_arch or ""))
        if not qwen_res.get("ok"):
            return {"ok": False, "cached": False, "repo": qwen_res.get("missing"), "error": qwen_res.get("error")}

        from huggingface_hub import snapshot_download as _qwen_snap

        _q_ignore = _REPO_SNAPSHOT_IGNORE.get(
            _QWEN_IMAGE_HF_REPO,
            ["transformer/*.safetensors*", "transformer/*.bin", "transformer/*.pth"],
        )
        _q_workers = max(4, int(os.environ.get("HF_SNAPSHOT_WORKERS", "8") or "8"))
        _q_tok = _hf_token()
        _q_ok = False
        _q_err = ""
        # 4 passes. Passes 1-2 are resumable top-ups (only the missing/short
        # files re-pull). If pass 2 still leaves a critical file missing the
        # snapshot tree itself is corrupt (bad refs / dangling symlinks that
        # snapshot_download won't self-heal), so pass 3 hard-purges the whole
        # Qwen/Qwen-Image cache dir and pass 3-4 do a clean pull. Success is
        # gated ONLY on every critical file being physically on disk — never on
        # snapshot_download's own listing-based check, which is exactly what
        # mistook the incomplete remnant for a hit.
        _q_missing = _qwen_missing_critical_files()
        if _q_missing:
            print(f"[cache][qwen] diffusers snapshot: {len(_q_missing)} critical file(s) missing -> fetching {_q_missing[:6]}", flush=True)
        for _qs in range(4):
            if _qs == 2 and not _q_ok and _qwen_missing_critical_files():
                _purge_qwen_snapshot()
            try:
                _t0 = time.time()
                _qwen_snap(
                    repo_id=_QWEN_IMAGE_HF_REPO,
                    ignore_patterns=_q_ignore,
                    max_workers=_q_workers,
                    token=_q_tok,
                    # only the pass right after the purge forces a from-scratch
                    # pull; the rest are resumable top-ups of the missing files.
                    force_download=(_qs == 2),
                )
            except Exception as exc:  # noqa: BLE001
                _q_err = str(exc)[:400]
                print(f"[cache][qwen] diffusers snapshot attempt {_qs + 1}/4 FAILED — {_q_err}", flush=True)
                time.sleep(3)
                continue
            _q_missing = _qwen_missing_critical_files()
            if not _q_missing:
                _q_ok = True
                print(
                    f"[cache][qwen] TE/tokenizer/VAE/scheduler snapshot verified on disk "
                    f"({len(_QWEN_REPO_CRITICAL_FILES)} critical files) in {time.time() - _t0:.0f}s",
                    flush=True,
                )
                break
            print(
                f"[cache][qwen] post-fetch verify: still missing {_q_missing[:6]} "
                f"(attempt {_qs + 1}/4)",
                flush=True,
            )
            time.sleep(3)
        if not _q_ok:
            return {
                "ok": False,
                "cached": False,
                "repo": _QWEN_IMAGE_HF_REPO,
                "error": (
                    f"{_QWEN_IMAGE_HF_REPO}: critical files still missing after 4 passes "
                    f"(incl. purge+clean): {_qwen_missing_critical_files()[:8]} ({_q_err})"
                ),
            }

        # Persist BOTH halves (comfy transformer file + diffusers TE/tokenizer/
        # VAE snapshot) so the GPU can load every byte offline.
        for _qa in range(2):
            try:
                vol.commit()
                print(
                    "[cache][qwen] vol.commit() — comfy transformer + Qwen/Qwen-Image "
                    "TE/tokenizer/VAE/scheduler snapshot",
                    flush=True,
                )
                break
            except Exception as exc:  # noqa: BLE001
                print(f"[cache][qwen] vol.commit() attempt {_qa + 1}/2 failed: {exc}", flush=True)
                time.sleep(2)

    # MiniMax H3: its weights are hosted single files (repos == []) that nothing
    # else fetches. Pull the fl2va_pruned int8_convrot DiT / nvfp4_awq TE / VAE
    # from Comfy-Org/MiniMax-H3 onto the Volume (ai-toolkit's transformer is
    # hard-wired to the fused quant state-dict, not raw bf16), AND the mandatory
    # ~23MB FL2VA config/tokenizer subset from
    # MiniMaxAI/MiniMax-H3 that the ai-toolkit loader also reads.
    if _is_minimax_h3(str(model_arch or "")):
        w_res = _ensure_minimax_h3_weights(str(model_arch or ""))
        if not w_res.get("ok"):
            return {
                "ok": False,
                "cached": False,
                "repo": _MINIMAX_H3_WEIGHT_REPO,
                "error": f"MiniMax-H3 quant weight fetch failed on {w_res.get('missing')}: {w_res.get('error')}",
            }
        if w_res.get("fetched"):
            for _mw in range(3):
                try:
                    vol.commit()
                    print(f"[cache][minimax] vol.commit() — quant weights: {w_res.get('fetched')}", flush=True)
                    break
                except Exception as exc:  # noqa: BLE001
                    print(f"[cache][minimax] weights vol.commit() attempt {_mw + 1}/3 failed: {exc}", flush=True)
                    time.sleep(2)

        mm_res = _ensure_minimax_h3_aux(str(model_arch or ""))
        if not mm_res.get("ok"):
            return {
                "ok": False,
                "cached": False,
                "repo": _MINIMAX_H3_AUX_REPO,
                "error": f"MiniMax-H3 FL2VA config files missing after fetch: {mm_res.get('missing')}",
            }
        if mm_res.get("fetched"):
            for _ma in range(2):
                try:
                    vol.commit()
                    print("[cache][minimax] vol.commit() — FL2VA tokenizer/processor/te-config", flush=True)
                    break
                except Exception as exc:  # noqa: BLE001
                    print(f"[cache][minimax] vol.commit() attempt {_ma + 1}/2 failed: {exc}", flush=True)
                    time.sleep(2)

    repos = _hf_repos_for(str(model_arch or ""), str(custom_model_id or ""))
    if not repos:
        # Single-file / Volume-hosted model (minimax_h3, flux_schnell). Nothing
        # to download here, but STILL verify the hosted weights are actually on
        # the Volume — `ok:True` must always mean "the GPU can load from disk".
        miss = _missing_base_artifacts(str(model_arch or ""), str(custom_model_id or ""))
        if miss:
            print(f"[cache] arch={model_arch!r}: hosted weights missing from Volume: {miss}", flush=True)
            return {"ok": False, "cached": False, "repo": miss[0], "error": "hosted weight file not on Volume: " + ", ".join(miss)}
        print(f"[cache] arch={model_arch!r}: single-file / Volume model — nothing to download", flush=True)
        return {"ok": True, "cached": True, "repos": [], "downloaded": []}

    from huggingface_hub import snapshot_download

    # Parallel file downloads. hf_transfer (env flag above) already parallelises
    # the CHUNKS of a single large shard; max_workers fans out across the many
    # shards of a big repo (LTX-Video / Wan / FLUX are 10s of files). 8 is a
    # safe fit for this container's cpu=4 (network-bound, not CPU-bound); a
    # bigger box can raise it via HF_SNAPSHOT_WORKERS.
    dl_workers = max(4, int(os.environ.get("HF_SNAPSHOT_WORKERS", "8") or "8"))
    # Authenticated pull — lifts the anonymous per-IP bandwidth throttle that
    # was making a big repo crawl for 50+ min.
    hf_tok = _hf_token()
    print(f"[cache] HF auth: {'token present' if hf_tok else 'ANONYMOUS (throttled — set huggingface-secret HF_TOKEN)'}", flush=True)

    downloaded: list[str] = []
    for repo in repos:
        # Repos where a ComfyUI single file already covers the heavy weights
        # (Qwen-Image transformer) are pulled config/other-components-only.
        ignore = _REPO_SNAPSHOT_IGNORE.get(repo)
        ig_kw = {"ignore_patterns": ignore} if ignore else {}
        # Qwen/Qwen-Image was already fully fetched + PHYSICALLY verified in the
        # dedicated block above; here it only gets the strict on-disk check
        # (never the lenient listing one that mistook the remnant for a hit).
        is_qwen_repo = repo == _QWEN_IMAGE_HF_REPO
        repo_complete = (lambda: not _qwen_missing_critical_files()) if is_qwen_repo else (lambda: _repo_cache_complete(repo, ignore))

        if repo_complete():
            print(f"[cache] {repo}: already complete on Volume", flush=True)
            continue

        # Fetch, then VERIFY completeness; snapshot_download is resumable so a
        # retry only re-pulls the gap. Give it 3 passes before failing the job.
        fetched_ok = False
        last_err = ""
        for attempt in range(3):
            try:
                t0 = time.time()
                snapshot_download(repo_id=repo, max_workers=dl_workers, token=hf_tok, **ig_kw)
            except Exception as exc:  # noqa: BLE001
                last_err = str(exc)[:400]
                print(f"[cache] {repo}: download attempt {attempt + 1}/3 FAILED — {last_err}", flush=True)
                time.sleep(3)
                continue
            if repo_complete():
                downloaded.append(repo)
                fetched_ok = True
                print(
                    f"[cache] {repo}: fetched + verified in {time.time() - t0:.0f}s "
                    f"(max_workers={dl_workers}{', transformer-shards-ignored' if ignore else ''})",
                    flush=True,
                )
                break
            # snapshot_download returned but the strict listing still shows a
            # gap — loop (idempotent). On the final pass accept the lenient
            # check so an HF completeness quirk can't fail a real download.
            print(f"[cache] {repo}: post-fetch strict verify miss (attempt {attempt + 1}/3)", flush=True)
            if attempt == 2 and not is_qwen_repo and _repo_snapshot_present(repo):
                downloaded.append(repo)
                fetched_ok = True
                print(f"[cache] {repo}: accepted on lenient check after 3 passes", flush=True)
                break
        if not fetched_ok:
            return {
                "ok": False,
                "cached": False,
                "repo": repo,
                "error": f"{repo}: not fully cached after 3 download passes ({last_err})",
            }

    # ALWAYS commit right after the download loop — the GPU only sees Volume
    # state that was explicitly committed here, so this is the single line that
    # makes a fetched 30GB snapshot survive into train_lora_job. A no-op when
    # nothing changed; retried once because a dropped commit = GPU re-download.
    for _attempt in range(2):
        try:
            vol.commit()
            print(
                f"[cache] vol.commit() — {len(downloaded)} repo(s) persisted to {HF_HUB_CACHE_DIR}",
                flush=True,
            )
            break
        except Exception as exc:  # noqa: BLE001
            print(f"[cache] vol.commit() attempt {_attempt + 1}/2 failed: {exc}", flush=True)
            time.sleep(2)

    # Post-commit verification — the GPU is only spawned on {"ok": True}, so
    # confirm every repo's snapshot survived the commit (a partial download that
    # raised no exception, a commit that silently no-op'd, …). Strict listing
    # check, lenient fallback. This is the "fully placed on /models" guarantee
    # the lazy-GPU sequence rests on.
    def _post_commit_ok(r: str) -> bool:
        if r == _QWEN_IMAGE_HF_REPO:
            # strict physical check only — the whole point of this fix
            return not _qwen_missing_critical_files()
        return _repo_cache_complete(r, _REPO_SNAPSHOT_IGNORE.get(r)) or _repo_snapshot_present(r)

    unverified = [r for r in repos if not _post_commit_ok(r)]
    if unverified:
        print(f"[cache] POST-COMMIT VERIFY FAILED — snapshot missing for {unverified}", flush=True)
        if _QWEN_IMAGE_HF_REPO in unverified:
            print(f"[cache][qwen] missing after commit: {_qwen_missing_critical_files()[:8]}", flush=True)
        return {"ok": False, "cached": False, "repo": unverified[0], "error": "snapshot missing after download+commit"}

    if wan_key:
        wan_missing = _wan_comfy_missing(str(model_arch or ""))
        if wan_missing:
            print(f"[cache][wan] POST-COMMIT VERIFY FAILED — {wan_missing}", flush=True)
            return {"ok": False, "cached": False, "repo": wan_missing[0], "error": "wan comfy file missing after placement"}

    # Final consolidated gate — repos + Wan files + any hosted single-file
    # weights. `ok:True` returned to the dispatcher is the hard promise that
    # train_lora_job will never need the network.
    leftover = _missing_base_artifacts(str(model_arch or ""), str(custom_model_id or ""))
    if leftover:
        print(f"[cache] FINAL VERIFY FAILED — still missing: {leftover}", flush=True)
        return {"ok": False, "cached": False, "repo": leftover[0], "error": "still missing after cache stage: " + ", ".join(leftover)}

    return {"ok": True, "cached": not downloaded, "repos": repos, "downloaded": downloaded}


@app.function(
    image=ingest_image,
    # 200 images * (download + decode + LANCZOS + WebP m6) worst case, on a
    # FREE CPU container. cache hit -> returns in <1s.
    timeout=45 * 60,
    cpu=4,
    memory=8192,
    # RW: writes the optimised images to PERSIST_ROOT (vol_ro can't).
    volumes={MODELS_DIR: vol},
    secrets=[modal.Secret.from_name("supabase-model-downloads")],
    # CPU-only function -> no scaledown_window (CLAUDE.md §1, 30s規格 is GPU-only).
)
def ingest_and_optimize_dataset_cpu(
    bucket: str,
    storage_paths: list,
    dataset_id: str,
    resolution: int,
    override: bool = False,
) -> dict:
    """Stage 1.5 — FREE CPU dataset optimisation, run before the GPU spawns.

    Per image: download from Supabase Storage -> bake EXIF orientation ->
    LANCZOS downscale (never upscale) so the long edge == the training-derived
    target -> normalise mode, strip metadata -> re-encode WEBP q95. Output:
    PERSIST_ROOT/<dataset_id>/_ingest/<ingest_key>/NNNN.webp (index-keyed).

    Idempotent: a complete output dir short-circuits to a cache hit. Never
    raises — returns {"ok": False, "error": ...} so the dispatcher decides the
    cost-defence action (mirrors ensure_model_cached_cpu's contract)."""
    import io
    import concurrent.futures

    try:
        from PIL import Image, ImageOps
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"Pillow import failed: {exc}"}

    storage_paths = list(storage_paths or [])
    dataset_id = _derive_dataset_id(
        {"dataset_id": dataset_id, "storage_paths": storage_paths}
    )
    if not dataset_id:
        return {"ok": False, "error": "no dataset_id"}
    n = len(storage_paths)
    if n == 0:
        return {"ok": False, "error": "no storage_paths"}

    long_edge = _ingest_long_edge(int(resolution or 768), bool(override))
    key = _ingest_cache_key(long_edge)
    rel = f"{dataset_id}/_ingest/{key}"
    out_dir = pathlib.Path(PERSIST_ROOT) / rel

    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[ingest] vol.reload skipped: {exc}", flush=True)

    # --- idempotency: a complete previous ingest short-circuits ------------
    if out_dir.is_dir():
        done = sorted(
            p for p in out_dir.iterdir()
            if p.is_file() and p.stat().st_size > 0
            and p.suffix.lower() in IMAGE_EXTS
        )
        if len(done) == n and [p.stem for p in done] == [f"{i:04d}" for i in range(n)]:
            print(f"[ingest] cache hit — {n} images at {rel}", flush=True)
            if os.environ.get("ULL_INGEST_PURGE_SOURCE", "1") != "0":
                purged = _purge_storage_objects(bucket, storage_paths)
                print(
                    f"[ingest] cache-hit — purged {purged}/{n} source objects "
                    f"from Supabase Storage ({bucket})",
                    flush=True,
                )
            return {
                "ok": True, "cache_hit": True, "ingest_dir": rel, "ingest_key": key,
                "count": n, "long_edge": long_edge, "downscaled": 0, "passthrough": 0,
                "bytes_in": 0, "bytes_out": 0, "error": None,
            }

    # Wipe any partial remnant and (re)build in place. A crash mid-run leaves an
    # incomplete dir that the idempotency check above rejects, so the next
    # dispatch rebuilds it — the dispatcher only ever injects ingest_dir on a
    # fully-committed {"ok": True}.
    shutil.rmtree(out_dir, ignore_errors=True)

    _NEEDS_RGB = {"P", "L", "1", "I", "I;16", "CMYK", "YCbCr", "LAB", "HSV", "F"}

    def _one(idx: int, key_path: str) -> tuple:
        """-> (bytes_in, bytes_out, downscaled, passthrough)."""
        raw = _download_storage_object(bucket, str(key_path))  # InfraError propagates -> hard fail
        bytes_in = len(raw)
        orig_ext = (os.path.splitext(str(key_path))[1] or ".png").lower()
        try:
            im = Image.open(io.BytesIO(raw))
            im.load()
            im = ImageOps.exif_transpose(im)
        except Exception as exc:  # noqa: BLE001 — undecodable: hand the raw bytes to the GPU
            dst = out_dir / f"{idx:04d}{orig_ext if orig_ext in IMAGE_EXTS else '.png'}"
            dst.write_bytes(raw)
            print(f"[ingest] {idx:04d}: decode failed ({exc}) — passthrough", flush=True)
            return (bytes_in, bytes_in, False, True)

        has_alpha = im.mode in ("RGBA", "LA", "PA") or (
            im.mode == "P" and "transparency" in im.info
        )
        if has_alpha and im.mode != "RGBA":
            im = im.convert("RGBA")
        elif not has_alpha and im.mode in _NEEDS_RGB:
            im = im.convert("RGB")

        w, h = im.size
        downscaled = False
        if max(w, h) > long_edge:
            scale = long_edge / float(max(w, h))
            im = im.resize(
                (max(1, round(w * scale)), max(1, round(h * scale))),
                Image.Resampling.LANCZOS,
            )
            downscaled = True

        # Format unification: every image (resized or not) is re-encoded to the
        # one compact format so the GPU DataLoader's decode path is uniform.
        dst = out_dir / f"{idx:04d}{INGEST_EXT}"
        save_kw = {"format": INGEST_FMT, "quality": INGEST_QUALITY}
        if INGEST_FMT == "WEBP":
            save_kw["method"] = INGEST_WEBP_METHOD
        elif INGEST_FMT == "JPEG":
            save_kw["subsampling"] = 0
            if im.mode == "RGBA":
                bg = Image.new("RGB", im.size, (255, 255, 255))
                bg.paste(im, mask=im.split()[-1])
                im = bg
        im.save(dst, **save_kw)  # no exif=/icc_profile= -> metadata stripped
        bytes_out = dst.stat().st_size
        im.close()
        return (bytes_in, bytes_out, downscaled, False)

    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        bytes_in = bytes_out = downscaled = passthrough = 0
        if n <= 8:
            results = [_one(i, storage_paths[i]) for i in range(n)]
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
                results = list(ex.map(lambda i: _one(i, storage_paths[i]), range(n)))
        for bi, bo, dsz, pt in results:
            bytes_in += bi
            bytes_out += bo
            downscaled += 1 if dsz else 0
            passthrough += 1 if pt else 0

        written = sorted(p for p in out_dir.iterdir() if p.is_file() and p.stat().st_size > 0)
        if len(written) != n:
            raise RuntimeError(f"wrote {len(written)}/{n} images")

        for _att in range(3):
            try:
                vol.commit()
                break
            except Exception as exc:  # noqa: BLE001
                print(f"[ingest] vol.commit attempt {_att + 1}/3 failed: {exc}", flush=True)
                time.sleep(2)
        print(
            f"[ingest] optimised {n} images -> {rel} "
            f"(downscaled {downscaled}, passthrough {passthrough}, "
            f"{bytes_in / 1024**2:.0f}MB -> {bytes_out / 1024**2:.0f}MB, "
            f"long_edge={long_edge})",
            flush=True,
        )
        # Optimised copies are committed to the Volume — the uploaded originals
        # are now dead weight in Supabase Storage. Purge them so the Free-tier
        # 1GB quota stays at ~0 (CLAUDE.md §3). Best-effort, never fatal.
        if os.environ.get("ULL_INGEST_PURGE_SOURCE", "1") != "0":
            purged = _purge_storage_objects(bucket, storage_paths)
            print(
                f"[ingest] purged {purged}/{n} source objects from "
                f"Supabase Storage ({bucket}) after optimisation",
                flush=True,
            )
        return {
            "ok": True, "cache_hit": False, "ingest_dir": rel, "ingest_key": key,
            "count": n, "long_edge": long_edge, "downscaled": downscaled,
            "passthrough": passthrough, "bytes_in": bytes_in, "bytes_out": bytes_out,
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(out_dir, ignore_errors=True)  # leave no partial dir behind
        print(f"[ingest] FAILED: {type(exc).__name__}: {exc}", flush=True)
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "ingest_key": key}


@app.function(
    image=dispatch_image,
    # Long: it may block on a multi-GB ensure_model_cached_cpu.remote() before
    # spawning the GPU. Fired async by train_lora_dispatch — nothing HTTP is
    # waiting on it.
    timeout=3 * 60 * 60,
    cpu=1,
    memory=2048,
    # read-only: this orchestrator never touches /models itself — the actual
    # pre-cache runs in ensure_model_cached_cpu (its own RW container). A RW
    # mount here would just give a 3h-idle container a stale snapshot to
    # auto-commit.
    volumes={MODELS_DIR: vol_ro},
    secrets=[
        modal.Secret.from_name("supabase-model-downloads"),
        modal.Secret.from_name("wan-animate-auth"),
        modal.Secret.from_name("huggingface-secret"),
    ],
)
def _prepare_and_spawn_training(item: dict) -> dict:
    """CPU orchestrator: pre-cache the base model on the persistent Volume,
    THEN spawn the GPU job. Runs in the background so train_lora_dispatch can
    ACK in <1s regardless of download size (a 55GB Wan-14B pull no longer
    blows the 300s HTTP timeout)."""
    job_id = str(item.get("job_id") or "")
    user_id = str(item.get("user_id") or "")
    credits_cost = int(item.get("credits_cost") or 0)

    def _fail(msg: str):
        _patch_job(
            job_id,
            {
                "status": "failed",
                "progress_message": "failed",
                "error_message": msg[:2000],
                "completed_at": _now_iso(),
                "metadata": {"refunded": True},
            },
        )
        if user_id and credits_cost > 0:
            _refund_credits(user_id, credits_cost)
        return {"ok": False, "error": msg}

    # Same defaulting as train_lora_job so the gate and the GPU agree on which
    # model's artefacts to verify.
    target_model = str(item.get("target_model") or "minimax_h3")
    custom_model_id = str(item.get("custom_model_id") or "").strip()
    override = bool(dict(item.get("training_config") or {}).get("custom_yaml_override"))

    try:
        # ---- STRICT CPU-GATE ------------------------------------------------
        # A raw-YAML job points name_or_path anywhere we can't parse — it's the
        # user's responsibility and skips the gate (mirrors train_lora_job).
        # For every managed model we ALWAYS run the CPU pre-cache to completion
        # and BLOCK the GPU spawn until it returns ok — ensure_model_cached_cpu
        # is a ~0.1s no-op for single-file models, so running it unconditionally
        # costs nothing and removes the "skipped when _hf_repos_for() came back
        # empty" hole that let a B300 do the download.
        if not override:
            _patch_job(
                job_id,
                {
                    "progress_percent": 1,
                    "progress_message": "🧊 ベースモデルを準備しています…（初回のみ・数分かかります）",
                },
            )
            try:
                cache_res = ensure_model_cached_cpu.remote(target_model, custom_model_id)
            except Exception as exc:  # noqa: BLE001
                return _fail(f"ベースモデルの事前キャッシュに失敗しました: {exc}")
            # ensure_model_cached_cpu only returns ok AFTER its own post-commit
            # presence check (repos + Wan files + hosted single-file weights)
            # passes — so `ok` here is the hard guarantee that the GPU can load
            # 100% from local disk. Anything else -> fail + refund, no spawn.
            if not isinstance(cache_res, dict) or not cache_res.get("ok"):
                return _fail(
                    "ベースモデルの事前キャッシュに失敗しました（GPU は起動しません／コスト防衛）: "
                    f"{(cache_res or {}).get('repo')} — "
                    f"{str((cache_res or {}).get('error'))[:400]}"
                )

        # ---- STAGE 1.5: Smart Ingest (FREE CPU dataset optimisation) --------
        # After the model-cache gate, before the GPU spawn. Downscale / EXIF-
        # bake / re-encode the uploaded images on a cheap CPU container so the
        # B300 never spends idle time on image I/O or resize. Idempotent
        # (cache hit -> <1s). Managed job: a failure is a cost-defence stop
        # (refund, no GPU) — same contract as the model gate. Raw-YAML: a
        # failure just falls through to the GPU downloading originals itself
        # (unchanged semantics, no refund).
        if os.environ.get("ULL_SMART_INGEST", "1") != "0":
            _sp = list(item.get("storage_paths") or [])
            _did = _derive_dataset_id(item)
            if _sp and _did:
                _bucket = str(item.get("storage_bucket") or "lora_datasets")
                _res = int(item.get("resolution") or 768)
                _patch_job(
                    job_id,
                    {
                        "progress_percent": 3,
                        "progress_message": "🖼️ 超高精細データセット解析・無損失最適化中…",
                    },
                )
                try:
                    ing = ingest_and_optimize_dataset_cpu.remote(
                        _bucket, _sp, _did, _res, override
                    )
                except Exception as exc:  # noqa: BLE001
                    ing = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
                if isinstance(ing, dict) and ing.get("ok") and ing.get("ingest_dir"):
                    item = {
                        **item,
                        "ingest_dir": ing["ingest_dir"],
                        "ingest_key": ing.get("ingest_key"),
                    }
                    print(
                        f"[dispatch] smart-ingest ok: {ing.get('count')} imgs -> "
                        f"{ing['ingest_dir']} (cache_hit={ing.get('cache_hit')}, "
                        f"long_edge={ing.get('long_edge')})",
                        flush=True,
                    )
                elif override:
                    print(
                        f"[dispatch] smart-ingest skipped (raw-YAML): "
                        f"{(ing or {}).get('error')}",
                        flush=True,
                    )
                else:
                    return _fail(
                        "データセットの最適化（データセット前処理）に失敗しました"
                        "（GPU は起動しません／コスト防衛）: "
                        f"{str((ing or {}).get('error'))[:400]}"
                    )

        call = train_lora_job.spawn(item)
        _patch_job(
            job_id,
            {"modal_call_id": call.object_id, "progress_message": "starting training"},
        )
        return {"ok": True, "modal_call_id": call.object_id, "job_id": job_id}
    except Exception as exc:  # noqa: BLE001
        return _fail(f"ジョブ準備中に予期しないエラー: {exc}")


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
    if item.get("_test_stub"):
        call = _pending_stub.spawn(item)
        return {"ok": True, "spawned": True, "test_stub": True, "modal_call_id": call.object_id, "job_id": item.get("job_id")}

    # Fully async: fire the CPU orchestrator (pre-cache -> GPU spawn) and ACK
    # immediately. Its call id stands in as modal_call_id for cancel /
    # self-heal until train_lora_job self-records its own fc-id.
    call = _prepare_and_spawn_training.spawn(item)
    return {
        "ok": True,
        "spawned": True,
        "async": True,
        "modal_call_id": call.object_id,
        "job_id": item.get("job_id"),
        "status": "queued",
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


# Large downloads (a rank-32 minimax_h3 LoRA is ~1.18GB) stream in 4 MiB
# chunks. Starlette's FileResponse reads the Modal Volume (NFS) in 64 KiB
# slices — ~19k syscalls for a 1.18GB file — and that per-read overhead
# collapsed real throughput to a few KB/s partway through. A 4 MiB buffered
# read amortises the NFS round-trip; Starlette runs this sync generator via
# iterate_in_threadpool, so the blocking reads never touch the event loop.
_DL_CHUNK = 4 * 1024 * 1024  # 4 MiB


def _stream_download(
    file_path: pathlib.Path,
    *,
    download_name: str | None = None,
    media_type: str = "application/octet-stream",
    background=None,
    request: "fastapi.Request | None" = None,
):
    """Stream a file off the Volume in 4 MiB chunks, honouring a single HTTP
    Range request.

    Range support is the difference between a 7GB download that survives a
    flaky link and one that corrupts: the browser's own download manager (and
    every resumable client) reconnects with `Range: bytes=<resumed>-` after a
    drop. Without a 206 for that, it gets a fresh 200 from byte 0 carrying the
    FULL `Content-Length` while the body is offset -> ERR_CONTENT_LENGTH_
    MISMATCH / a truncated .safetensors. Pass `request` for any file that
    lives on the Volume long enough to be re-requested (checkpoints, salvaged
    weights); leave it None for a build-once /tmp zip that a BackgroundTask
    deletes right after the response (a later Range would 404 anyway) — that
    path then streams a plain 200 and does NOT advertise Accept-Ranges, so the
    client restarts rather than trying a resume that can't work.
    """
    file_size = file_path.stat().st_size
    name = (download_name or file_path.name).replace('"', "")
    headers = {
        "Content-Disposition": f'attachment; filename="{name}"',
        "Content-Type": media_type,
    }

    start, end = 0, file_size - 1
    status_code = 200
    if request is not None:
        headers["Accept-Ranges"] = "bytes"
        raw_range = request.headers.get("range") or request.headers.get("Range")
        if raw_range:
            m = re.match(r"\s*bytes=(\d*)-(\d*)\s*$", raw_range)
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else file_size - 1
                else:  # suffix range: bytes=-N  -> the last N bytes
                    start = max(0, file_size - int(m.group(2)))
                    end = file_size - 1
                end = min(end, file_size - 1)
                if start > end or start >= file_size:
                    return fastapi.responses.Response(
                        status_code=416,
                        headers={**headers, "Content-Range": f"bytes */{file_size}"},
                    )
                status_code = 206
                headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"

    length = end - start + 1
    headers["Content-Length"] = str(length)

    def _iter():
        remaining = length
        # buffering=_DL_CHUNK -> the BufferedReader pulls 4 MiB per NFS read,
        # amortising the Volume's per-read syscall overhead.
        with open(file_path, "rb", buffering=_DL_CHUNK) as fh:
            if start:
                fh.seek(start)
            while remaining > 0:
                chunk = fh.read(min(_DL_CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return fastapi.responses.StreamingResponse(
        _iter(),
        status_code=status_code,
        media_type=media_type,
        background=background,
        headers=headers,
    )


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
    # Read-only: this endpoint keeps a warm container (min_containers=1) and
    # only streams files — a RW mount would let its stale snapshot auto-commit
    # deleted checkpoints back onto the Volume.
    volumes={MODELS_DIR: vol_ro},
    # Checkpoints run 600MB-1GB+ (a rank-32 minimax_h3 LoRA is ~1.18GB) and a
    # slow / unstable mobile link can crawl at <1MB/s, so give the whole
    # transfer a full hour before Modal kills the container mid-stream. The
    # response is Range-aware, so a dropped connection resumes instead of
    # restarting.
    timeout=3600,
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
        # The canonical path missed — the file may sit in a sibling folder
        # keyed by call-id, or carry a salvaged_ prefix. Search this user's
        # loras/ tree by exact name, then by stem match.
        user_root = pathlib.Path(MODELS_DIR) / "loras" / user_id
        stem = filename.rsplit(".", 1)[0].removeprefix("salvaged_")
        hit = None
        if user_root.is_dir():
            cands = list(user_root.glob(f"**/{filename}"))
            if not cands:
                cands = [
                    p
                    for p in user_root.glob("**/*")
                    if p.is_file() and p.suffix == pathlib.Path(filename).suffix and stem in p.name
                ]
            hit = min(cands, key=lambda p: len(str(p)), default=None)
        if hit is None:
            raise fastapi.HTTPException(status_code=404, detail="checkpoint not found")
        file_path = hit
    return _stream_download(file_path, download_name=file_path.name, request=request)


# Bundles a caller-chosen set of this job's checkpoints into ONE uncompressed
# zip and streams it. safetensors are already incompressible, so ZIP_STORED
# (Store, no Deflate) makes the "zip" a header-wrapped concat built at raw
# disk-copy speed — the browser then pulls a single stream instead of racing
# the same-origin connection cap with N parallel .safetensors downloads.
# `files` is the sorted, comma-joined name list the Next.js
# /api/studio/lora/checkpoint/selection route signed (owner-or-admin check +
# validation against generation_jobs.metadata.checkpoints happens there).
_SELECTION_MAX_FILES = 64


def _verify_selection_token(user_id: str, job_id: str, files: str, expires: str, sig: str) -> bool:
    secret = os.environ.get("MODAL_AUTH_TOKEN", "")
    if not secret or not sig:
        return False
    try:
        if int(expires) < time.time():
            return False
    except ValueError:
        return False
    expected = hmac.new(
        secret.encode(), f"selection:{user_id}:{job_id}:{files}:{expires}".encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, sig)


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol_ro},  # read-only: reads checkpoints, zips into /tmp
    timeout=3600,
    min_containers=1,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="GET")
def download_lora_selection(
    user_id: str, job_id: str, files: str, expires: str, sig: str, request: fastapi.Request
):
    if not _verify_selection_token(user_id, job_id, files, expires, sig):
        raise fastapi.HTTPException(status_code=403, detail="invalid or expired download link")
    if not (_CKPT_DL_ID_RE.match(user_id) and _CKPT_DL_ID_RE.match(job_id)):
        raise fastapi.HTTPException(status_code=400, detail="invalid parameters")
    names = [n for n in files.split(",") if n]
    if not names or len(names) > _SELECTION_MAX_FILES or any(
        not _CKPT_DL_FILENAME_RE.match(n) for n in names
    ):
        raise fastapi.HTTPException(status_code=400, detail="invalid file list")

    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[selection] vol.reload() skipped: {exc}", flush=True)

    user_root = pathlib.Path(MODELS_DIR) / "loras" / user_id
    resolved: list[pathlib.Path] = []
    seen: set[str] = set()
    for n in names:
        if n in seen:
            continue
        seen.add(n)
        p = user_root / job_id / n
        if not p.is_file():
            cands = list(user_root.glob(f"**/{n}")) if user_root.is_dir() else []
            p = min(cands, key=lambda q: len(str(q)), default=None)
        if p is None or not p.is_file():
            raise fastapi.HTTPException(status_code=404, detail=f"checkpoint not found: {n}")
        resolved.append(p)

    stem = re.sub(r"(_step\d+|_final)?\.safetensors$", "", resolved[0].name) or "lora"
    zip_name = f"{stem}_checkpoints.zip"
    tmp = pathlib.Path("/tmp") / f"sel_{int(time.time())}_{job_id[:8]}.zip"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for p in resolved:
            zf.write(p, arcname=p.name)
    print(
        f"[selection] job {job_id[:8]}: {len(resolved)} ckpt(s) -> {tmp.stat().st_size / 1024**3:.2f} GB",
        flush=True,
    )

    from starlette.background import BackgroundTask

    return _stream_download(
        tmp,
        download_name=zip_name,
        media_type="application/zip",
        background=BackgroundTask(lambda: tmp.unlink(missing_ok=True)),
    )


# ---------------------------------------------------------------------------
# Admin file explorer — direct signed download of ANY Volume path + folder ZIP
# ---------------------------------------------------------------------------
# Both are hit straight from the browser (hidden <iframe>), so no Next.js
# proxy hop (which base64'd GB-scale .safetensors through a Vercel function
# and timed out). The Next.js admin route does the requireAdmin() check and
# mints a short-lived HMAC token; these endpoints only verify the signature.
_ADMIN_PATH_RE = re.compile(r"^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,399}$")


def _verify_admin_token(scope: str, path: str, expires: str, sig: str) -> bool:
    secret = os.environ.get("MODAL_AUTH_TOKEN", "")
    if not secret or not sig:
        return False
    try:
        if int(expires) < time.time():
            return False
    except ValueError:
        return False
    expected = hmac.new(
        secret.encode(), f"admin:{scope}:{path}:{expires}".encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, sig)


def _safe_volume_path(rel: str) -> pathlib.Path:
    """Resolve `rel` under MODELS_DIR, rejecting traversal / escapes."""
    if not _ADMIN_PATH_RE.match(rel) or ".." in rel.split("/"):
        raise fastapi.HTTPException(status_code=400, detail="invalid path")
    root = pathlib.Path(MODELS_DIR).resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise fastapi.HTTPException(status_code=400, detail="path escapes volume")
    return target


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol_ro},  # read-only: streams files only, never writes
    timeout=3600,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="GET")
def admin_download_volume_file(path: str, expires: str, sig: str, request: fastapi.Request):
    if not _verify_admin_token("file", path, expires, sig):
        raise fastapi.HTTPException(status_code=403, detail="invalid or expired link")
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[admin-dl] vol.reload() skipped: {exc}", flush=True)
    fp = _safe_volume_path(path)
    if not fp.is_file():
        raise fastapi.HTTPException(status_code=404, detail="file not found")
    return _stream_download(fp, download_name=fp.name)


@app.function(
    image=dispatch_image,
    # read-only: reads Volume files, writes the ZIP only to /tmp (not the Volume)
    volumes={MODELS_DIR: vol_ro},
    timeout=3600,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="GET")
def admin_zip_volume_folder(path: str, expires: str, sig: str, request: fastapi.Request):
    if not _verify_admin_token("zip", path, expires, sig):
        raise fastapi.HTTPException(status_code=403, detail="invalid or expired link")
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[admin-zip] vol.reload() skipped: {exc}", flush=True)
    folder = _safe_volume_path(path)
    if not folder.is_dir():
        raise fastapi.HTTPException(status_code=404, detail="folder not found")
    leaf = re.sub(r"[^A-Za-z0-9._-]", "_", path.strip("/").split("/")[-1] or "volume")
    zip_name = f"{leaf}.zip"
    tmp = pathlib.Path("/tmp") / f"admzip_{int(time.time())}_{leaf}.zip"
    files = [f for f in sorted(folder.rglob("*")) if f.is_file()]
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for f in files:
            zf.write(f, arcname=str(f.relative_to(folder)))
    print(f"[admin-zip] {path}: {len(files)} file(s) -> {tmp.stat().st_size / 1024**2:.1f} MB", flush=True)

    from starlette.background import BackgroundTask

    return fastapi.responses.FileResponse(
        str(tmp),
        media_type="application/zip",
        filename=zip_name,
        background=BackgroundTask(lambda: tmp.unlink(missing_ok=True)),
    )


# ---------------------------------------------------------------------------
# LoRA Studio bulk / smart artifact download — resolves the ACTUAL file for a
# job (final weights / all-checkpoint zip / dataset zip) wherever it landed:
# loras/<user>/<job_id>/, loras/<user>/<call_id>/, salvaged_ prefixes, etc.
# The Next.js /api/studio/lora/checkpoint/bundle route mints the token after
# its owner-or-admin check. ?probe=1 -> JSON {found, filename, size_bytes}.
_STEP_NUM_RE = re.compile(r"(\d{3,})")


def _resolve_job_artifact(user_id: str, job_id: str, call_id: str, want: str):
    """(file_path | None, on_demand_zip_root | None) — searches every plausible
    per-job folder recursively for the artifact the caller asked for."""
    base = pathlib.Path(MODELS_DIR) / "loras" / user_id
    roots = [r for r in (base / job_id, base / call_id) if str(r) != str(base) and r.is_dir()]
    if not roots:
        return None, None

    def files(pat: str):
        out: list = []
        for r in roots:
            out.extend(p for p in r.glob(pat) if p.is_file())
        return out

    def _step(p: pathlib.Path) -> int:
        m = _STEP_NUM_RE.search(p.stem)
        return int(m.group(1)) if m else 0

    if want == "final":
        for got in (files("**/*final*.safetensors"),):
            if got:
                return min(got, key=lambda p: len(p.name)), None
        st = [p for p in files("**/*.safetensors") if "step" in p.name.lower()]
        if st:
            return max(st, key=_step), None
        any_st = files("**/*.safetensors")
        return (max(any_st, key=_step) if any_st else None), None

    if want == "bundle":
        for pat in ("**/checkpoints_all.zip", "**/*checkpoint*.zip"):
            got = files(pat)
            if got:
                return min(got, key=lambda p: len(str(p))), None
        return None, roots[0]  # nothing pre-built -> zip on demand

    for pat in ("**/dataset*.zip", "**/caption*.zip"):  # want == "dataset"
        got = files(pat)
        if got:
            return min(got, key=lambda p: len(str(p))), None
    return None, None


@app.function(
    image=dispatch_image,
    # read-only: resolves + streams job artifacts, builds any on-demand ZIP in
    # /tmp — never writes the Volume.
    volumes={MODELS_DIR: vol_ro},
    timeout=3600,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="GET")
def admin_download_job_artifact(
    user_id: str,
    job_id: str,
    want: str,
    expires: str,
    sig: str,
    request: fastapi.Request,
    call_id: str = "",
    probe: str = "",
):
    if want not in ("final", "bundle", "dataset"):
        raise fastapi.HTTPException(status_code=400, detail="bad want")
    if not _verify_admin_token(f"artifact:{want}", f"{user_id}:{job_id}", expires, sig):
        raise fastapi.HTTPException(status_code=403, detail="invalid or expired link")
    if not (_CKPT_DL_ID_RE.match(user_id) and _CKPT_DL_ID_RE.match(job_id)):
        raise fastapi.HTTPException(status_code=400, detail="invalid ids")
    if call_id and not _CKPT_DL_ID_RE.match(call_id):
        call_id = ""
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[artifact] vol.reload() skipped: {exc}", flush=True)

    hit, zip_root = _resolve_job_artifact(user_id, job_id, call_id, want)

    if hit is None and zip_root is not None:
        # on-demand ZIP of every file under the job folder
        tmp = pathlib.Path("/tmp") / f"jobzip_{int(time.time())}_{job_id[:8]}.zip"
        files = [f for f in sorted(zip_root.rglob("*")) if f.is_file()]
        if not files:
            raise fastapi.HTTPException(status_code=404, detail="no files for this job")
        if probe:
            return {"found": True, "filename": "checkpoints_all.zip", "size_bytes": sum(f.stat().st_size for f in files)}
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
            for f in files:
                zf.write(f, arcname=str(f.relative_to(zip_root)))
        from starlette.background import BackgroundTask

        return fastapi.responses.FileResponse(
            str(tmp),
            media_type="application/zip",
            filename="checkpoints_all.zip",
            background=BackgroundTask(lambda: tmp.unlink(missing_ok=True)),
        )

    if hit is None:
        if probe:
            return {"found": False, "filename": None, "size_bytes": 0}
        raise fastapi.HTTPException(status_code=404, detail="artifact not found")

    if probe:
        return {"found": True, "filename": hit.name, "size_bytes": hit.stat().st_size}
    media = "application/zip" if hit.suffix == ".zip" else "application/octet-stream"
    return _stream_download(hit, download_name=hit.name, media_type=media, request=request)


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
        # Captions are persisted under a caption-format-keyed dir
        # (<dataset_id>__dense / __tags — see _derive_dataset_id); the job
        # metadata may carry either the bare id or an already-suffixed one.
        # Probe every shape and take the first that exists.
        _ds_candidates = [dataset_id]
        if not (dataset_id.endswith("__dense") or dataset_id.endswith("__tags")):
            _ds_candidates += [f"{dataset_id[:56]}__dense", f"{dataset_id[:56]}__tags"]
        ds_dir = next(
            (d for d in (pathlib.Path(PERSIST_ROOT) / c for c in _ds_candidates) if d.is_dir()),
            pathlib.Path(PERSIST_ROOT) / dataset_id,
        )
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
# PERSIST_ROOT/<dataset_id>/latents/ AND the Smart-Ingest optimised images
# under PERSIST_ROOT/<dataset_id>/_ingest/ are both derived-from-dataset
# artefacts, so they get the same treatment. Flat 14d from creation (mtime is
# NOT bumped on reuse — a heavily re-run dataset just re-encodes / re-ingests
# after the purge). The caption cache and the LoRA library have their own
# lifecycle.
LATENT_CACHE_RETENTION_DAYS = int(os.environ.get("LORA_LATENT_TTL_DAYS", "14"))


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol},
    schedule=modal.Period(days=1),
    timeout=600,
)
def cleanup_old_latent_caches() -> dict:
    """Daily: delete files under PERSIST_ROOT/*/latents/ and PERSIST_ROOT/*/
    _ingest/ older than LATENT_CACHE_RETENTION_DAYS, then drop the now-empty
    dirs. Best-effort."""
    root = pathlib.Path(PERSIST_ROOT)
    if not root.is_dir():
        print("[ds-ttl] no dataset cache root yet — nothing to do", flush=True)
        return {"ok": True, "removed": 0}

    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[ds-ttl] vol.reload skipped: {exc}", flush=True)

    cutoff = time.time() - LATENT_CACHE_RETENTION_DAYS * 24 * 60 * 60
    removed = 0
    freed = 0

    def _sweep(top: pathlib.Path, pattern: str) -> None:
        nonlocal removed, freed
        for f in top.glob(pattern):
            try:
                if f.is_file() and f.stat().st_mtime < cutoff:
                    freed += f.stat().st_size
                    f.unlink()
                    removed += 1
            except Exception as exc:  # noqa: BLE001
                print(f"[ds-ttl] unlink skipped {f}: {exc}", flush=True)
        # prune empty sub-dirs deepest-first, then `top` itself
        for sub in sorted(top.glob("**/*"), key=lambda p: len(p.parts), reverse=True):
            try:
                if sub.is_dir() and not any(sub.iterdir()):
                    sub.rmdir()
            except Exception:  # noqa: BLE001
                pass
        try:
            if not any(top.iterdir()):
                top.rmdir()
        except Exception:  # noqa: BLE001
            pass

    scoped = list(root.glob("*/latents")) + list(root.glob("*/_ingest"))
    for top in scoped:
        if top.is_dir():
            _sweep(top, "**/*.safetensors" if top.name == "latents" else "**/*")

    if removed:
        try:
            vol.commit()
        except Exception as exc:  # noqa: BLE001
            print(f"[ds-ttl] vol.commit skipped: {exc}", flush=True)
    print(
        f"[ds-ttl] removed {removed} file(s) (~{freed / 1024**2:.1f} MB) older "
        f"than {LATENT_CACHE_RETENTION_DAYS}d across {len(scoped)} cache dir(s)",
        flush=True,
    )
    return {"ok": True, "removed": removed, "freed_bytes": freed}


# ---------------------------------------------------------------------------
# Admin: one-shot Volume cleanup (junk HF-cache repos + stale output dirs)
# ---------------------------------------------------------------------------
# PERSIST_OUTPUT_ROOT/<run_key>/ is ai-toolkit's per-job working dir. A finished
# job's weights are copied out to LORA_OUTPUT_DIR/<user>/<job>/; a failed one
# stays here for salvage_lora_job. After this many days a leftover is stale
# (max job runtime is ~12h) and safe to drop.
OUTPUTS_RETENTION_DAYS = int(os.environ.get("LORA_OUTPUTS_TTL_DAYS", "3"))


def _hf_cache_slug(repo_id: str) -> str:
    """`owner/name` -> the `models--owner--name` dir name huggingface_hub uses."""
    return "models--" + repo_id.replace("/", "--")


def _keep_hf_cache_slugs() -> set[str]:
    """Every `models--…` hub-cache dir the current sealed preset lineup
    legitimately needs — the per-preset repos (_hf_repos_for) plus the shared
    comfy / aux repos. Anything else under HF_HUB_CACHE_DIR is a removable
    remnant (retired presets included — a re-add re-pulls it)."""
    repos: set[str] = set()
    for _key in TARGET_MODELS:
        for _r in _hf_repos_for(_key):
            if _r and "/" in _r:
                repos.add(_r)
    repos.update(
        {
            _WAN_TOKENIZER_REPO,
            _WAN_COMFY_REPO,
            _QWEN_IMAGE_HF_REPO,
            _QWEN_COMFY_REPO,
            _MINIMAX_H3_AUX_REPO,
            _MINIMAX_H3_WEIGHT_REPO,
        }
    )
    return {_hf_cache_slug(r) for r in repos if r and "/" in r}


def _walk_size_dedup(root: "pathlib.Path | str") -> int:
    """Total bytes under `root`, counting each physical byte ONCE. The HF hub
    cache symlinks every blob from snapshots/ and the comfy layout hardlinks
    some weights; os.stat() follows both, so a naive sum double-counts. On a
    Modal Volume st_ino is unreliable (often 0), so we can't lean on inode
    de-dupe — instead two physical rules root out the duplication:
      1. os.path.islink() -> the entry is an alias, contributes 0 bytes.
      2. a "snapshots" path segment -> HF cache revision view; the real bytes
         live only in the sibling blobs/ dir, so the whole subtree is skipped.
    The inode set stays as a fallback for hardlinked comfy weights, where
    st_ino *is* populated."""
    seen: set = set()
    total = 0
    for dirpath, dirs, names in os.walk(root):
        dirs.sort()
        # Prune HF-cache snapshots/ subtrees before descending.
        if "snapshots" in dirs:
            dirs.remove("snapshots")
        for n in names:
            full = os.path.join(dirpath, n)
            if os.path.islink(full):
                continue
            if "snapshots" in full.replace(os.sep, "/").split("/"):
                continue
            try:
                st = os.lstat(full)
            except OSError:
                continue
            key = (st.st_dev, st.st_ino)
            if st.st_ino and key in seen:
                continue
            if st.st_ino:
                seen.add(key)
            total += st.st_size
    return total


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol},
    timeout=1800,
    secrets=[modal.Secret.from_name("huggingface-secret")],
)
def admin_cleanup_volume(
    dry_run: bool = True,
    outputs_max_age_days: int = OUTPUTS_RETENTION_DAYS,
    purge_retired_wan21: bool = False,
    purge_flux2: bool = False,
    purge_qwen_image: bool = False,
) -> dict:
    """Purge the Volume of (1) HF-cache model dirs outside the sealed preset
    lineup (e.g. models--AstraliteHeart--pony-diffusion-v6-xl,
    models--THUDM--CogVideoX-5b, models--stabilityai--stable-diffusion-3.5-*)
    and (2) empty / stale PERSIST_OUTPUT_ROOT working dirs.

    purge_retired_wan21=True ALSO removes the leftover Wan 2.1 comfy DiT files
    (diffusion_models/wan2.1_t2v_*.safetensors, ~30GB) — opt-in because the
    shared umt5 text-encoder / wan VAE files are deliberately left in place
    (the wan-animate app on the same Volume may still need them).

    purge_flux2=True force-removes the FLUX.2 [dev] HF-cache — the transformer
    repo (black-forest-labs/FLUX.2-dev) and the 24B Mistral text encoder that
    ONLY that preset uses (mistralai/Mistral-Small-3.1-24B-Instruct-2503,
    ~50GB). Both are in the sealed lineup so the generic pass keeps them; this
    flag is the explicit pre-release storage escape hatch. The shared
    ai-toolkit/flux2_vae is left intact (flux2_klein_* still need it). A later
    `flux2` training job re-pulls the ~80GB through the CPU gate.

    purge_qwen_image=True force-removes the Qwen-Image (Alibaba 20B) transformer
    single file (diffusion_models/qwen_image_bf16.safetensors + its split_files/
    hardlink mirror, ~40GB). Opt-in: the `qwen_image` preset is hidden from the
    GUI (loraModels.ts), so it's dead weight — but the shared Qwen/Qwen-Image HF
    snapshot is deliberately KEPT (the live `krea2` preset reads its vae/
    subfolder). A later re-enabled `qwen_image` job re-pulls the ~40GB single
    file through the CPU gate.

    dry_run=True (the default) only reports what WOULD be removed — review that
    list, then re-run to actually delete:

        modal run modal_lora_worker.py::admin_cleanup_volume                # preview
        modal run modal_lora_worker.py::admin_cleanup_volume --no-dry-run   # delete
        modal run modal_lora_worker.py::admin_cleanup_volume --purge-flux2 --no-dry-run
        modal run modal_lora_worker.py::admin_cleanup_volume --purge-qwen-image --no-dry-run

    Returns freed_gb and the accurate post-cleanup used_gb (inode-deduped)."""
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[cleanup] vol.reload skipped: {exc}", flush=True)

    GB = 1024**3
    verb = "WOULD REMOVE" if dry_run else "REMOVING"
    freed = 0
    hf_removed: list[dict] = []
    outputs_removed: list[dict] = []
    files_removed: list[dict] = []

    # ---- 1) HF cache: model dirs not in the sealed lineup ------------------
    keep = _keep_hf_cache_slugs()
    hub = pathlib.Path(HF_HUB_CACHE_DIR)
    print(f"[cleanup] HF-cache keep-set ({len(keep)}): {', '.join(sorted(keep))}", flush=True)
    if hub.is_dir():
        for d in sorted(hub.iterdir()):
            if not d.is_dir() or not d.name.startswith("models--") or d.name in keep:
                continue
            sz = _walk_size_dedup(d)
            freed += sz
            hf_removed.append({"dir": d.name, "gb": round(sz / GB, 3)})
            print(f"[cleanup] {verb} hf-cache/{d.name}  (~{sz / GB:.2f} GB)", flush=True)
            if not dry_run:
                shutil.rmtree(d, ignore_errors=True)

    # ---- 1b) FLUX.2 [dev] explicit purge (opt-in) ------------------------
    # These slugs ARE in the keep-set (flux2 is a sealed preset), so the
    # generic pass above skips them — this flag deletes them anyway. Scans
    # both the real HF cache root and a legacy /models/hub in case an old
    # HF_HUB_CACHE config left a copy there.
    if purge_flux2:
        flux2_slugs = {
            _hf_cache_slug("black-forest-labs/FLUX.2-dev"),
            _hf_cache_slug("mistralai/Mistral-Small-3.1-24B-Instruct-2503"),
        }
        flux2_roots = [pathlib.Path(HF_HUB_CACHE_DIR), pathlib.Path(MODELS_DIR) / "hub"]
        for base in flux2_roots:
            if not base.is_dir():
                continue
            for slug in sorted(flux2_slugs):
                d = base / slug
                if not d.is_dir():
                    continue
                sz = _walk_size_dedup(d)
                freed += sz
                rel = str(d.relative_to(MODELS_DIR)).replace(os.sep, "/")
                hf_removed.append({"dir": rel, "gb": round(sz / GB, 3)})
                print(f"[cleanup] {verb} {rel}  (FLUX.2 [dev] purge, ~{sz / GB:.2f} GB)", flush=True)
                if not dry_run:
                    shutil.rmtree(d, ignore_errors=True)

    # ---- 1c) Qwen-Image (20B) transformer single file (opt-in) -----------
    # The `qwen_image` preset is hidden from the GUI (loraModels.ts). Its Comfy
    # single-file transformer (~40GB) is used by NOTHING else — drop it. The
    # shared Qwen/Qwen-Image HF snapshot is deliberately NOT touched here: the
    # live `krea2` preset loads its VAE (vae/ subfolder) from that same repo.
    if purge_qwen_image:
        _qwen_seen: set = set()
        _qwen_targets: list[str] = []
        for _rel, _repo_file in _QWEN_COMFY_FILES:
            _qwen_targets.extend([_rel, _repo_file])
        # also sweep any sibling qwen_image*.safetensors variants (fp8 etc.)
        for _base_rel in ("diffusion_models", "split_files/diffusion_models"):
            _dir = pathlib.Path(MODELS_DIR) / _base_rel
            if _dir.is_dir():
                for _p in sorted(_dir.glob("qwen_image*.safetensors")):
                    _qwen_targets.append(str(_p.relative_to(MODELS_DIR)).replace(os.sep, "/"))
        for _rel in dict.fromkeys(_qwen_targets):  # de-dup, keep order
            f = pathlib.Path(MODELS_DIR) / _rel
            if not (f.is_file() and not f.is_symlink() and f.stat().st_size > 0):
                # still unlink a 0-byte / symlink mirror so the path is clean
                if f.is_symlink() or (f.is_file() and f.stat().st_size == 0):
                    files_removed.append({"file": _rel, "gb": 0.0})
                    print(f"[cleanup] {verb} {_rel}  (Qwen-Image mirror, ~0 GB)", flush=True)
                    if not dry_run:
                        try:
                            f.unlink()
                        except OSError as exc:
                            print(f"[cleanup] unlink {_rel} failed: {exc}", flush=True)
                continue
            st = f.stat()
            key = (st.st_dev, st.st_ino)
            sz = 0 if (st.st_ino and key in _qwen_seen) else st.st_size
            if st.st_ino:
                _qwen_seen.add(key)
            freed += sz
            files_removed.append({"file": _rel, "gb": round(sz / GB, 3)})
            print(f"[cleanup] {verb} {_rel}  (Qwen-Image 20B, ~{sz / GB:.2f} GB)", flush=True)
            if not dry_run:
                try:
                    f.unlink()
                except OSError as exc:
                    print(f"[cleanup] unlink {_rel} failed: {exc}", flush=True)

    # ---- 2) outputs/: empty or stale per-job working dirs -----------------
    out_root = pathlib.Path(PERSIST_OUTPUT_ROOT)
    cutoff = time.time() - max(0, int(outputs_max_age_days)) * 86400
    if out_root.is_dir():
        for d in sorted(out_root.iterdir()):
            if not d.is_dir():
                continue
            file_mtimes = [p.stat().st_mtime for p in d.rglob("*") if p.is_file()]
            is_empty = not file_mtimes
            newest = max(file_mtimes) if file_mtimes else d.stat().st_mtime
            if not is_empty and newest >= cutoff:
                continue
            sz = _walk_size_dedup(d)
            freed += sz
            reason = "empty" if is_empty else f"stale {(time.time() - newest) / 86400:.1f}d"
            outputs_removed.append({"dir": d.name, "gb": round(sz / GB, 3), "reason": reason})
            print(f"[cleanup] {verb} outputs/{d.name}  ({reason}, ~{sz / GB:.2f} GB)", flush=True)
            if not dry_run:
                shutil.rmtree(d, ignore_errors=True)

    # ---- 3) retired Wan 2.1 comfy DiT files (opt-in) ---------------------
    _wan21_live = any(t.get("arch") == "wan21" for t in TARGET_MODELS.values())
    if purge_retired_wan21 and not _wan21_live:
        for rel in _WAN21_RETIRED_DIT_FILES:
            f = pathlib.Path(MODELS_DIR) / rel
            if not (f.is_file() and f.stat().st_size > 0):
                continue
            sz = f.stat().st_size
            freed += sz
            files_removed.append({"file": rel, "gb": round(sz / GB, 3)})
            print(f"[cleanup] {verb} {rel}  (retired Wan 2.1, ~{sz / GB:.2f} GB)", flush=True)
            if not dry_run:
                try:
                    f.unlink()
                except OSError as exc:
                    print(f"[cleanup] unlink {rel} failed: {exc}", flush=True)
    elif purge_retired_wan21 and _wan21_live:
        print("[cleanup] purge_retired_wan21 ignored — a live preset still has arch:'wan21'", flush=True)

    if not dry_run and (hf_removed or outputs_removed or files_removed):
        for _att in range(2):
            try:
                vol.commit()
                break
            except Exception as exc:  # noqa: BLE001
                print(f"[cleanup] vol.commit() attempt {_att + 1}/2 failed: {exc}", flush=True)
                time.sleep(2)

    used = _walk_size_dedup(MODELS_DIR)
    freed_gb = round(freed / GB, 2)
    used_gb = round(used / GB, 2)
    print(
        f"[cleanup] {'DRY-RUN — nothing deleted. ' if dry_run else ''}"
        f"freed ~{freed_gb} GB "
        f"({len(hf_removed)} hf-cache dir(s), {len(outputs_removed)} output dir(s), "
        f"{len(files_removed)} file(s)) | "
        f"volume now ~{used_gb} GB (inode-deduped, accurate)",
        flush=True,
    )
    return {
        "ok": True,
        "dry_run": dry_run,
        "freed_gb": freed_gb,
        "used_gb": used_gb,
        "hf_cache_removed": hf_removed,
        "outputs_removed": outputs_removed,
        "files_removed": files_removed,
    }


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
