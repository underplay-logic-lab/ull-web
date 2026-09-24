"""Constants, the shared Volume handle and Supabase/job plumbing (no Modal app objects).

Split out of modal_lora_worker.py (2026-09-24) to keep the worker file small enough to
read in pieces. The Modal app, images and every @app.function stay in modal_lora_worker.py;
this module has no Modal app objects. Every image that runs this app must ship it via
add_local_python_source (see _LORA_WORKER_MODULES there).
"""

# ruff: noqa: F401
import base64
import collections
import copy
import hashlib
import hmac
import json
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

# 2026-09-24: train_lora_job commits from a background thread (dataset persist)
# while the main thread may commit too; serialise them.
_VOL_COMMIT_LOCK = threading.Lock()
# Captioned datasets are persisted here on the Volume, keyed by dataset_id,
# so a re-run of the same set skips the VLM pass entirely (0s).
PERSIST_ROOT = f"{MODELS_DIR}/datasets"
# Persistent HF / torch caches ON the Volume. ensure_model_cached_cpu()
# pre-fills these on a cheap CPU container so a B300 ($0.31/s) never idles
# on a HuggingFace download; train_lora_job points HF_HOME / TORCH_HOME here
# and loads everything from local disk in 0s.
HF_CACHE_DIR = f"{MODELS_DIR}/training/hf_cache"
TORCH_CACHE_DIR = f"{MODELS_DIR}/training/torch_cache"
# torch.compile（model.compile: true）の Inductor / Triton コンパイル成果物を
# 永続 Volume に置く。B300 の初回コンパイル（数分〜十数分）を 2 回目以降の
# ジョブで丸ごとスキップできるようにする — これが無いと毎ジョブ再コンパイル。
INDUCTOR_CACHE_DIR = f"{MODELS_DIR}/training/inductor_cache"
TRITON_CACHE_DIR = f"{MODELS_DIR}/training/triton_cache"
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
    process (and thus every subprocess that inherits it).

    NOTE: TORCHINDUCTOR_CACHE_DIR / TRITON_CACHE_DIR は **ここ（実行時）だけ**
    で設定する。イメージ .env に入れると、その後の build-time な torch import /
    Triton コンパイルが /models 配下に書き込んで "/models" が非空になり、
    Volume マウントが `cannot mount volume on non-empty path` で失敗する。
    実行時は Volume が既にマウント済みなので安全。"""
    os.environ.update(_hf_cache_env())
    os.environ["TORCHINDUCTOR_CACHE_DIR"] = INDUCTOR_CACHE_DIR
    os.environ["TRITON_CACHE_DIR"] = TRITON_CACHE_DIR

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

# arch 別 GPU tier（2026-09-23、docs/pricing-decision-sheet.md「決定 4」）: B300 への
# こだわりは無く、VRAM が収まる最安 tier へ寄せる。dispatch 時に
# `train_lora_job.with_options(gpu=...)` で差し替えるので再デプロイ無しで切り替わる
# （Modal 1.5.4、gpu は単一文字列のみ）。既定は空＝全 arch が GPU_REQUEST（B300/B200）。
# 実測で VRAM が判った arch から env `LORA_ARCH_GPU='{"flux2_klein_4b": "RTX-PRO-6000"}'`
# で指定するか、ここに書く。⚠️ 単価 knob `lora_credits_per_gpu_second` は B300 時給で
# 導出しているので、安い tier へ寄せた arch は arch 別の単価が要る（未対応）。
LORA_ARCH_GPU: dict[str, str] = {}


def _host_ram_peak_gb():
    """コンテナのメインメモリ使用量の最大値（GB）。2026-09-24: GPU 関数に memory= を指定しておらず、
    Multi-Angle で読み込み中に exit 137（メモリ不足で強制終了）が出たため、各ワーカーで実測して
    確保量を決める。cgroup v2 の memory.peak（子プロセス込み）、無ければ自プロセスの ru_maxrss。"""
    try:
        with open("/sys/fs/cgroup/memory.peak") as f:
            return round(int(f.read().strip()) / 1e9, 1)
    except Exception:  # noqa: BLE001
        pass
    try:
        import resource

        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, 1)
    except Exception:  # noqa: BLE001
        return None


def _host_ram_report() -> str:
    cur = None
    try:
        with open("/sys/fs/cgroup/memory.current") as f:
            cur = round(int(f.read().strip()) / 1e9, 1)
    except Exception:  # noqa: BLE001
        pass
    return f"host RAM peak={_host_ram_peak_gb()}GB now={cur}GB"
# Next 側 tier id（knob `gpu_usd_per_hour_<tier>` の綴り）→ Modal の GPU 文字列。
_MODAL_GPU_NAME: dict[str, str] = {
    "b300": "B300",
    "b200": "B200",
    "h200": "H200",
    "h100": "H100",
    "rtx_pro_6000": "RTX-PRO-6000",
    "a100_80gb": "A100-80GB",
    "a100_40gb": "A100-40GB",
    "l40s": "L40S",
}
try:
    LORA_ARCH_GPU.update(
        {str(k): str(v) for k, v in json.loads(os.environ.get("LORA_ARCH_GPU", "") or "{}").items()}
    )
except Exception as _exc:  # noqa: BLE001 — 壊れた env で全体を止めない
    print(f"[lora] LORA_ARCH_GPU ignored: {_exc!r}", flush=True)
AI_TOOLKIT_REF = os.environ.get("AI_TOOLKIT_REF", "main")

# 2026-09-20: 既定を False（無効）に変更（ホスト判断）。
# gradient checkpointing は activation を捨てて backward で再計算する VRAM
# 節約策で、一般に 20〜40% 遅くなる。LoRA はアダプタしか学習しないのに
# Blackwell の 288GB に対してこれを効かせているのは、CLAUDE.md §1 の
# 「量子化・オフロードで VRAM をケチらない」方針と同じ理由で筋が悪い。
# 遅い = GPU 秒が伸びる = 原価が上がる（課金は推定GPU秒ベース、
# src/lib/pricing/loraRuntime.ts）ので、切れるならそのまま値下げ余地になる。
# 効き幅の実測は modal_lora_benchmark.py の "settings" プラン（on/off の A/B）。
# OOM が出たら 1 に戻せば従来挙動。
LORA_GRADIENT_CHECKPOINTING = os.environ.get("LORA_GRADIENT_CHECKPOINTING", "0").strip() not in (
    "",
    "0",
    "false",
    "False",
)

# 2026-09-20: 学習中のサンプル画像生成を既定で全面停止（ホスト判断）。
# 詳細は _build_config の train.disable_sampling のコメント参照。
# LORA_ENABLE_SAMPLING=1 で従来どおりの挙動に戻せる。
_LORA_SAMPLING_ON = os.environ.get("LORA_ENABLE_SAMPLING", "0").strip() not in (
    "",
    "0",
    "false",
    "False",
)

# PyTorch 最適化標準（CLAUDE.md §1）: ai-toolkit の model ブロックに
# `compile: true` を付けて DiT/UNet を torch.compile（Inductor）し、学習
# ステップループを高速化する。ai-toolkit `ModelConfig` のネイティブ
# オプション（compile / compile_mode / compile_dynamic=既定 true）。
# 12h 上限の単発バッチなので初回コンパイル数分は step 単価で確実に回収できる。
# LORA_DISABLE_COMPILE=1 で無効化（特定 arch でコンパイルが不安定なとき用）。
LORA_COMPILE_ENABLED = os.environ.get("LORA_DISABLE_COMPILE", "").strip().lower() not in (
    "1",
    "true",
    "yes",
)

# ai-toolkit の `model.block_compile`。DiT を1グラフで compile する代わりに
# Transformer ブロック単位で compile する（ai-toolkit が cache_size_limit も
# ブロック数×2 へ自動で上げる）。既定 ON。
#
# 2026-09-20 実測（docs/gpu-benchmarks.md §14.8）:
#   - 実効バッチ>1 の「学習途中に8分停止」が消える。停止の正体は
#     minimax_h3 forward のデータ依存分岐による DiT 丸ごとの再コンパイルで、
#     ブロック単位なら再コンパイル1回の単価が数秒に落ちる。
#   - バッチ1（GUI 既定）でも s/it は悪化しない（1.79 vs whole-model 1.85）。
#     warmup も 135s vs 157.8s で不利にならない。
# ブロックを持たない arch では ai-toolkit 側が whole-model compile へ
# 自動フォールバックするので、arch ごとの分岐は不要。
# LORA_BLOCK_COMPILE=0 で従来の whole-model compile に戻せる。
LORA_BLOCK_COMPILE = os.environ.get("LORA_BLOCK_COMPILE", "").strip().lower() not in (
    "0",
    "false",
    "no",
)

# torch.compile（Inductor）が確実に失敗する arch。ここに入れた arch は最初から
# compile せず eager で回す。
#
# 2026-09-20: flux2_klein_4b を追加。modal_lora_benchmark.py の image_tier 計測で
# 学習開始前に必ず落ちることを確認:
#   torch._inductor.exc.InductorError:
#     CantSplit: 3072*s27 + 3072*s97 not divisible by s27 + s97
# compile_dynamic=True の動的 shape に対して Inductor がコード生成に失敗する。
# ⚠️ これは既定 ON の compile が原因で、**FLUX.2 Klein 4B を選んだユーザーの
# LoRA ジョブが100%失敗していた**（3分ほど GPU を回してから死ぬ）。
# torch / ai-toolkit の更新で直る可能性があるので、上げたときは外して再検証する。
COMPILE_UNSUPPORTED_ARCHES: frozenset[str] = frozenset({"flux2_klein_4b"})

# torch.compile は通るが、**warmup を回収できない** arch。明示指定が無ければ
# eager で回す（COMPILE_UNSUPPORTED_ARCHES と同じ扱い。速度ではなく採算の問題）。
#
# 2026-09-21 実測（docs/gpu-benchmarks.md §14.8.2）— minimax_h3 / B300 / 1024px /
# rank64 / gc 無効 / バッチ1（＝GUI 既定そのもの）:
#   - steady s/it は compile 1.78 / eager 1.87 ＝ **利得わずか 4.6%**（0.09 s/step）。
#   - 回収に必要な step 数は warmup 135秒（温 Inductor キャッシュ）で **約1,570**、
#     477秒（冷キャッシュ・§14.15）なら **約5,545**。
#   - GUI の step 下限は200・実運用は 1,000〜3,000 なので、**多くのジョブで純損**。
# さらに eager なら「学習途中の再コンパイルで止まる」事故クラス（§14.8）自体が
# 消える。速度の上振れ 4.6% より、warmup 分の確実な GPU 代と事故の上限を取った。
# ⚠️ 他 arch へ広げないこと（未実測。§5 の「学習は ~2x 効く」はバグったベンチ由来）。
# 有効化したいときは GUI 経路なら training_config.compile: true、生 YAML 経路なら
# model.compile: true を明示する（どちらも明示指定が最優先）。
COMPILE_LOW_VALUE_ARCHES: frozenset[str] = frozenset({"minimax_h3"})

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
#           (_cost_cap_seconds), graceful stop + 100% refund + salvageable
#           partial checkpoints. The cap is normally the value the API
#           pre-computed from the credit price and the admin-editable
#           pricing_knobs thresholds and sent as payload cost_cap_seconds; with
#           no payload value it is derived here (credit-covered seconds *
#           ULL_COST_GUARD_MULTIPLIER, floored by the per-arch expected run
#           time). The env vars below still override and LORA_ABS_MAX_RUN_S is
#           the hard ceiling either way.
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
# arch 別の s/it（秒/イテレーション）。cost cap の下限を作り、正しく課金されて
# いるが遅いジョブが宣言した step 数を終える前に損切りで撃ち落とされないように
# する。未収載の arch -> _DEFAULT。
#
# ⚠️ src/lib/pricing/loraRuntime.ts の同名テーブルと必ず同じ値にすること。
# あちらが課金側の SSOT で、ジョブ payload の cost_cap_seconds として降りて
# くる。この表はその payload が無い場合のフォールバック。
#
# 2026-09-20: 実測に合わせて総入れ替え（modal_lora_benchmark.py smoke /
# minimax_h3 / B300 / 1024px / rank32 / batch1 / prodigy /
# gradient_checkpointing 無効 / torch.compile 有効 → 0.2329 s/it）。
# 旧値 5.0 は **it/s を s/it と取り違えた値**で 21 倍の過大評価だった
# （docs/gpu-benchmarks.md §5 の「compile 5.0-5.4 it/s」が正しかった）。
# 実測は minimax_h3 の1点のみで、他の ai-toolkit arch は旧テーブルの相対順序を
# 保ったまま実測点でアンカーして一律 0.04658 倍した未検証値。
# sdxl は別ワーカー（sd-scripts / 別 tier）で桁が違うため別扱い。旧値 0.9 は
# 実測前の仮値だったので、2026-09-15 スモーク実測(1.32s/it)由来の 1.4 へ揃える。
LORA_SPI_BASELINE: dict[str, float] = {
    # src/lib/pricing/loraRuntime.ts と同値に保つこと（payload に
    # cost_cap_seconds が乗らなかった場合のフォールバック用）。
    # 2026-09-20（夜）: GUI 既定条件（実効バッチ1 / gradient_checkpointing 無効 /
    # torch.compile **有効**）の本番ランで minimax_h3 を直接実測し 1.80 s/it。
    # それまでの 0.90 は「実効バッチ4 の 3.60 s/it を正比例と仮定して 4 で割った
    # 逆算」で、実測の半分だった。未実測の他 arch は相対順序を保ったまま同じ
    # 倍率（x2.0）でスケールしてある。
    # 詳細は loraRuntime.ts のコメントと docs/gpu-benchmarks.md §14.15。
    "minimax_h3": 1.8,
    "wan22_14b": 1.44,
    "wan21": 1.24,
    "ltx2": 1.24,
    "hunyuan": 1.44,
    "cogvideox": 1.44,
    "qwen_image": 0.72,
    "krea2": 0.72,
    "anima": 0.5,
    "zimage": 0.42,
    "flux2_klein_4b": 0.4,
    "sdxl": 0.67,  # 2026-09-23 RTX PRO 6000 実測 0.645（LoCon 既定込み、docs §14.28）
}
# 未知 arch（カスタムモデル）の s/it フォールバック。pricing_knobs の
# lora_spi_baseline_default と同じ意図・同じ値に保つこと（2026-09-20: 2.0）。
LORA_SPI_BASELINE_DEFAULT = float(os.environ.get("LORA_SPI_BASELINE_DEFAULT", "2.0"))
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
    # FLUX.2 Klein (4B): ai-toolkit's flux2_klein loader hard-wires the text
    # encoder to Qwen/Qwen3-4B and the VAE to ai-toolkit/flux2_vae
    # (Flux2Klein4BModel class attrs) — it does NOT read the text_encoder/ vae/
    # subfolders bundled in the -klein-base repo. So all three repos must be
    # pre-cached.
    # NOTE: the 9B variant (flux2_klein_9b / FLUX.2-klein-base-9B) is
    # deliberately NOT listed — it ships under the FLUX Non-Commercial License
    # and cannot be hosted by a commercial SaaS. It is also rejected by
    # _is_blocked_model() below.
    "flux2_klein_4b": {
        "arch": "flux2_klein_4b",
        "unet": "black-forest-labs/FLUX.2-klein-base-4B",
        "text_encoder": "Qwen/Qwen3-4B",
        "vae": "ai-toolkit/flux2_vae",
    },
    # FLUX.2 [dev] — REMOVED (non-commercial). FLUX.2-dev ships under the FLUX
    # Non-Commercial License; a commercial SaaS cannot host it (same class as
    # FLUX.1 [dev] and FLUX.2 [klein] 9B). It is now rejected by
    # _is_blocked_model(). Its HF cache (transformer + 24B Mistral TE, ~210GB)
    # and the Mistral-Small repo are purged by admin_cleanup_volume — they leave
    # the keep-set with this entry gone, so the generic pass drops them (the
    # explicit --purge-flux2 flag also still works). ai-toolkit/flux2_vae stays
    # cached: flux2_klein_4b shares it.
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
# FLUX.2 [dev] is blocked too — FLUX Non-Commercial License. Matches "flux2dev",
# "flux.2-dev", "FLUX.2 dev", "black-forest-labs/FLUX.2-dev", … (the "2" is what
# separates it from _FLUX_DEV_RE, which only reaches the ".1"/bare variant).
_FLUX2_DEV_RE = re.compile(r"flux[\s._-]*2[\s._-]*dev\b", re.IGNORECASE)
# FLUX.2 [klein] 9B is also blocked — FLUX Non-Commercial License (a commercial
# SaaS cannot host it). Matches "flux2_klein_9b",
# "black-forest-labs/FLUX.2-klein-base-9B", "flux.2 klein 9b", … but never the
# Apache-2.0 4B variant.
_FLUX2_KLEIN_9B_RE = re.compile(r"flux[\s._-]*2[\s._-]*klein[\w\s.-]{0,24}9b\b", re.IGNORECASE)


def _is_blocked_model(value: str) -> bool:
    if not value:
        return False
    v = value.strip().lower()
    return (
        _FLUX_DEV_RE.search(value) is not None
        or _FLUX2_DEV_RE.search(value) is not None
        or v in {"flux_dev", "flux2", "flux2_dev", "flux2_klein_9b"}
        or _FLUX2_KLEIN_9B_RE.search(value) is not None
    )

DEFAULT_TRAINING_CONFIG = {
    # 2026-09-15: alpha を rank と同値(32)から rank/2(16) に変更。複数の外部
    # ガイドで「alpha = rank/2 が事実上の標準」（α/rの実効スケールを一定に
    # 保つ）という点が一致し、ホスト自身の納品実績（rank64/alpha32、同じ
    # 0.5比率）とも独立に一致した。この rank=32/alpha=16 は「人物」タイプの
    # 既定値（route.ts の autoLoraRankAlpha 参照）。通常の呼び出しは
    # route.ts が rank/alpha/steps を明示的に渡すのでこの既定値は使われず、
    # ここは Next.js を経由しない直接呼び出し（ローカルCLI等）向けの
    # フォールバックに過ぎない。
    "rank": 32,
    "alpha": 16,
    # AdamW-style rate — only used as a fallback for non-prodigy optimizers.
    # Prodigy (the actual default below) ignores this and gets a forced
    # lr=1.0 in _build_config (see the comment there).
    "learning_rate": 1e-4,
    "steps": 2000,
    # 2026-09-14: was adamw8bit (bitsandbytes 8bit-quantized optimizer states) —
    # a VRAM-saving quantization that was never benchmarked/approved per
    # CLAUDE.md §1 ("量子化は原則不使用、使うならホスト承認") and made no sense
    # on Blackwell's large VRAM. Switched to prodigy: full precision (no
    # quantization) AND learning-rate-free, which also removes another
    # never-validated guessed constant (the fixed LR) from "オート" mode —
    # matching its own "don't make the user tune anything" design (host
    # decision, 2026-09-14).
    "optimizer": "prodigy",
}

# Framing/composition tags and part-detail tags are kept in strictly
# separate groups so the LoRA learns appearance independently of crop.
CAPTION_INSTRUCTION = (
    "You are tagging one training image of a single subject. Output ONE line "
    "of comma-separated lowercase tags, no sentences, in this exact order and "
    "with the groups kept strictly separate:\n"
    "1) the literal trigger token '{trigger}'.\n"
    "2) a Danbooru-style subject-count/gender tag (e.g. '1girl', '1boy', "
    "'1man', '1woman', 'solo', '2girls', 'no humans') reflecting exactly how "
    "many people are in frame and their apparent gender.\n"
    "3) FRAMING (exactly one, composition only): one of 'head close-up', "
    "'upper body', 'lower body and boots', 'full-body standing view'.\n"
    "4) PART FEATURES (appearance only, never mention crop/zoom/framing): "
    "hair colour and style, eye colour, and each distinctive accessory or "
    "costume detail as its own short tag.\n"
    "5) SCENE: background and lighting, each as its own tag.\n"
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


# 走行中の VRAM ピーク。CLAUDE.md §6-3 は非同期ジョブに「ライブ更新＋完了時
# vram_peak_gb」を要求しているが、LoRA ワーカーは瞬間値を毎回上書きするだけで
# ピークを残していなかった（2026-09-20: job yukipas_v8 の完了時 metadata は
# 学習プロセス終了後の 0.6GB だけで、学習期のピークを後から追えなかった）。
# tier 判定・バッチ/解像度上限の検討で毎回必要になる数字なので残す。
# 1コンテナ＝1学習なのでモジュール変数で足りる。
_VRAM_PEAK: dict[str, float] = {"gb": 0.0}


# 実ジョブから arch 別の校正値を回収するための計測値（2026-09-21 導入）。
# 専用ベンチを14 arch ぶん回すと GPU 代と Volume 容量を先払いすることになるので、
# 「実ジョブが走るたびに実測が溜まる」形にする（docs/gpu-benchmarks.md §14.8.1）。
#
# 他系統（推論）は generation_logs の execution_time_ms + gpu_tier と
# generation_jobs.inputs の組で校正できるが、LoRA の課金式は
# `prep + steps × s/it` の **合成** なので総所要時間だけでは2つの未知数に
# 分解できない。だから LoRA に限って内訳を残す。
# 1コンテナ＝1学習なのでモジュール変数で足りる（_VRAM_PEAK と同じ）。
_RUN_METRICS: dict = {}


def _track_vram_peak(gb) -> float:
    """瞬間値を渡すとピークを更新し、更新後のピークを返す（telemetry 専用、
    例外は投げない）。"""
    try:
        v = float(gb)
    except (TypeError, ValueError):
        return _VRAM_PEAK["gb"]
    if v > _VRAM_PEAK["gb"]:
        _VRAM_PEAK["gb"] = round(v, 1)
    return _VRAM_PEAK["gb"]


def _gpu_tier_label() -> str:
    """実行中コンテナが実際に割り当てられたGPUの短い正規化ラベルを返す
    （torch.cuda.get_device_name() ベース。GPU_REQUEST=["b300","b200"]の
    ようなフォールバックリストの場合、実際にどれが割り当てられたかは
    これでしか分からない）。generation_logs.gpu_tier 経由で管理画面
    「実稼働ログ & 粗利監視」タブの原価計算に使われる（2026-09-18導入。
    src/lib/pricing/gpuRates.ts の正規化パターンと対応させること）。
    取得できない場合は 'unknown'。canonical copy は各ワーカーファイルに
    同一のものを複製している。"""
    try:
        import torch

        name = torch.cuda.get_device_name(0).lower()
    except Exception:  # noqa: BLE001 — telemetry only, never fatal
        return "unknown"
    if "b300" in name:
        return "B300"
    if "b200" in name:
        return "B200"
    if "h200" in name:
        return "H200"
    if "h100" in name:
        return "H100"
    if "rtx pro 6000" in name or "rtx_pro_6000" in name:
        return "RTX-PRO-6000"
    if "a100" in name:
        return "A100-80GB" if "80gb" in name else "A100-40GB"
    if "l40s" in name:
        return "L40S"
    if "a10g" in name or "a10" in name:
        return "A10"
    if "l4" in name:
        return "L4"
    if "t4" in name:
        return "T4"
    return name


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


def _effective_batch(train_block: dict) -> int:
    """1 step で処理する画像枚数 = batch_size x gradient_accumulation。

    🚨 2026-09-21 修正: 以前は `gradient_accumulation_steps` を掛けていたが、
    ai-toolkit ではそれは optimizer を踏む間隔（既定1）で **処理量を増やさない**。
    1 step の内側ループ回数は別キーの `gradient_accumulation`（既定1）で、両者は
    相互排他（toolkit/config_modules.py:455-462、
    BaseSDTrainProcess.py:2518/2549）。所要秒にはこの枚数がほぼ正比例する
    （docs/gpu-benchmarks.md §14.8.1）。compile の可否判定にも効く（§14.8）。
    """
    def _pos_int(v, default: int = 1) -> int:
        try:
            n = int(float(v))
        except (TypeError, ValueError):
            return default
        return n if n > 0 else default

    if not isinstance(train_block, dict):
        return 1
    return _pos_int(train_block.get("batch_size")) * _pos_int(
        train_block.get("gradient_accumulation")
    )


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
    credits_cost: int,
    target_model: str,
    total_steps: int,
    base_architecture: str = "",
    override_s: int = 0,
) -> tuple[int, str]:
    """The live projected-wall-time abort threshold. Returns (seconds, reason
    string for the log).

    `override_s` (> 0) is the value the API pre-computed from the credit price
    and the admin-editable pricing_knobs cost-guard thresholds — it is used
    verbatim (only clamped to LORA_ABS_MAX_RUN_S) so a pricing edit moves the
    loss-cut threshold without a worker redeploy. With no override the value is
    derived here from:
      * base      = _credit_covered_seconds(credits) (or LORA_SAFETY_LIMIT_S
                    for a zero-credit raw-YAML job)
      * + margin  = base * ULL_COST_GUARD_MULTIPLIER
      * floored   = max(margin, per-arch expected run time)
      * clamped   = min(that, LORA_ABS_MAX_RUN_S)
    """
    if override_s and override_s > 0:
        capped = int(min(override_s, LORA_ABS_MAX_RUN_S))
        return capped, (
            f"{credits_cost}C -> API-provided cap {override_s}s -> {capped}s "
            f"(~{capped / 3600:.2f}h)"
        )
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
    """2026-09-13: modal_angle_worker.py の実障害（_supabase_request が非2xx
    でも例外を投げないため、書き込み失敗が握りつぶされてジョブが進捗の
    まま止まる／completed に遷移しない）と同じバグが本ファイルにも存在して
    いたため横展開。一時的な失敗（ネットワーク/5xx/レート制限等）はリトライ
    し、'metadata' 列欠落（デプロイがDBより先行）だけは従来通りその場で
    metadata 抜きにフォールバックする（リトライしても直らない schema
    mismatch のため）。"""
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

    attempts, backoff_s = 3, 0.6
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            res = _send(fields)
            if res is not None and res.ok:
                return
            if res is not None and res.status_code >= 400 and "metadata" in fields:
                body = (res.text or "").lower()
                if "metadata" in body or "schema cache" in body or "column" in body:
                    slim = {k: v for k, v in fields.items() if k != "metadata"}
                    res2 = _send(slim) if slim else None
                    if res2 is not None and res2.ok:
                        print(f"[lora-worker] job {job_id}: 'metadata' column absent — patched without it")
                        return
                    last_exc = RuntimeError("metadata column absent and slim patch also failed")
                    break  # schema mismatch won't fix itself — retrying is pointless
            last_exc = RuntimeError(
                f"HTTP {res.status_code}: {res.text[:300]}" if res is not None else "no response (env not configured)"
            )
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
        if attempt < attempts:
            time.sleep(backoff_s * attempt)
    print(f"[lora-worker] failed to update job {job_id} (after retries): {last_exc}")


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
