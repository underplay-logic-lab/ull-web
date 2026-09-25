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

# Helpers split into sibling modules (2026-09-24); the names below are the ones this file
# (and modal_lora_benchmark.py via `import modal_lora_worker as W`) uses.
from lora_worker_core import (  # noqa: F401
    AI_TOOLKIT_DIR,
    AI_TOOLKIT_REF,
    DATASET_DIR,
    DEFAULT_TRAINING_CONFIG,
    GPU_REQUEST,
    HF_CACHE_DIR,
    HF_HUB_CACHE_DIR,
    IMAGE_EXTS,
    INDUCTOR_CACHE_DIR,
    LORA_ARCH_GPU,
    LORA_CAPTION_MIN_S,
    LORA_CAPTION_S_PER_IMG,
    LORA_OUTPUT_DIR,
    LORA_SPI_BASELINE,
    LORA_SPI_BASELINE_DEFAULT,
    MODELS_DIR,
    OUTPUT_DIR,
    PERSIST_OUTPUT_ROOT,
    PERSIST_ROOT,
    SHIM_DIR,
    SafetyLimitError,
    TARGET_MODELS,
    TORCH_CACHE_DIR,
    TRITON_CACHE_DIR,
    _MODAL_GPU_NAME,
    _QUANT_PATCH,
    _RUN_METRICS,
    _SITECUSTOMIZE,
    _USERCUSTOMIZE,
    _VOL_COMMIT_LOCK,
    _VRAM_PEAK,
    _apply_hf_cache_env,
    _arch_for_target,
    _authorize,
    _caption_is_contaminated,
    _claim_job,
    _cost_cap_seconds,
    _current_effective_vram_gb,
    _gpu_tier_label,
    _hf_cache_env,
    _hf_token,
    _host_ram_peak_gb,
    _host_ram_report,
    _is_blocked_model,
    _is_infra_error,
    _now_iso,
    _patch_job,
    _refund_credits,
    _sanitize_caption,
    _supabase_request,
    _track_vram_peak,
    vol,
    vol_ro,
)
from lora_worker_models import (  # noqa: F401
    _MINIMAX_H3_AUX_REPO,
    _MINIMAX_H3_WEIGHT_REPO,
    _QWEN_COMFY_FILES,
    _QWEN_COMFY_REPO,
    _QWEN_IMAGE_HF_REPO,
    _QWEN_REPO_CRITICAL_FILES,
    _REPO_SNAPSHOT_IGNORE,
    _WAN_TOKENIZER_REPO,
    _ensure_minimax_h3_aux,
    _ensure_minimax_h3_weights,
    _ensure_qwen_comfy_layout,
    _is_minimax_h3,
    _is_qwen_image,
    _minimax_h3_aux_missing,
    _minimax_h3_weights_missing,
    _purge_qwen_snapshot,
    _qwen_comfy_missing,
    _qwen_missing_critical_files,
    _repo_cache_complete,
    _repo_snapshot_present,
)
from lora_worker_train import (  # noqa: F401
    INGEST_EXT,
    INGEST_FMT,
    INGEST_PNG_COMPRESS,
    INGEST_QUALITY,
    INGEST_WEBP_METHOD,
    _CKPT_STEP_RE,
    _build_config,
    _caption_missing,
    _collect_all_checkpoints,
    _collect_final_lora,
    _derive_dataset_id,
    _derive_trigger,
    _group_dataset_by_repeats,
    _ingest_cache_key,
    _ingest_long_edge,
    _job_output_dir,
    _latent_cache_key,
    _normalize_repeats,
    _override_identity,
    _override_structure_error,
    _persist_latent_cache,
    _publish_partial_checkpoints,
    _restore_latent_cache,
    _run_ai_toolkit_with_progress,
)
from lora_worker_endpoints import (  # noqa: F401
    DIRECTOR_USER_LORA_SUBDIR,
    LATENT_CACHE_RETENTION_DAYS,
    LORA_DATASET_UPLOADS_DIR,
    OUTPUTS_RETENTION_DAYS,
    _ADMIN_UPLOAD_MAX_BYTES,
    _CKPT_DL_FILENAME_RE,
    _CKPT_DL_ID_RE,
    _DATASET_BATCH_MAX_BYTES,
    _DATASET_BATCH_MAX_FILES,
    _DATASET_IMG_FILENAME_RE,
    _DL_CHUNK,
    _SELECTION_MAX_FILES,
    _UPLOAD_MAX_BYTES,
    _admin_upload_dest,
    _cancel_function_call,
    _delete_lora_dataset_uploads,
    _hf_cache_slug,
    _read_lora_dataset_upload,
    _resolve_job_artifact,
    _safe_volume_path,
    _stream_download,
    _verify_admin_token,
    _verify_dataset_upload_token,
    _verify_download_token,
    _verify_selection_token,
    _verify_upload_token,
    _walk_size_dedup,
)


app = modal.App("ull-lora-worker")

# Helper modules split out of this file (2026-09-24). This module imports them at top level,
# so EVERY image a function of this app runs on must ship them (add_local_python_source).
_LORA_WORKER_MODULES = ("lora_worker_core", "lora_worker_models", "lora_worker_train", "lora_worker_endpoints")

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
            # CLAUDE.md §1 が torch.compile に要求しているガード
            # （「try/except と torch._dynamo.config.suppress_errors = True で
            # 必ずガードし、環境変数で ON/OFF できるようにする」）。LoRA ワーカー
            # だけこれが入っておらず、2026-09-20 に実害が出た — flux2_klein_4b で
            # Inductor のコード生成が落ちると、eager へフォールバックせず
            # **学習ジョブごと死んでいた**。
            #
            # 学習は run.py の別プロセスで走るので、こちら側で
            # torch._dynamo.config を書いても届かない。torch が同じ設定を読む
            # 環境変数（torch/_dynamo/config.py の suppress_errors）で入れる。
            # これで compile 失敗は eager フォールバックになり、遅くはなっても
            # ジョブは完走する。
            # LORA_COMPILE_STRICT=1 を渡せば従来どおり落として原因を見られる。
            "TORCHDYNAMO_SUPPRESS_ERRORS": "1",
            # Deliberately NOT setting CUDA_FORCE_PTX_JIT / TORCH_CUDA_ARCH_LIST.
            # Confirmed by direct probe: torch==2.7.0+cu128's arch_list already
            # includes sm_100 (native cubin, ships with both B200 sm_100 and
            # B300 sm_103 confirmed working via forward-compat) — forcing PTX
            # JIT made the driver refuse those working native kernels and was
            # the actual cause of "no kernel image is available", not a fix
            # for it. Do not re-add these without re-verifying on real HW.
        }
    )
    # R2 成果物ストア（2026-09-23、docs/STATUS.md）。完了した checkpoint /
    # dataset.zip は Volume ではなく R2 へ置く。末尾に足す = 既存レイヤーは
    # 再ビルドされない。
    .pip_install("boto3>=1.35")
    .add_local_python_source("ull_r2", *_LORA_WORKER_MODULES)
)


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
    # LoRA worker は例外的に 2秒即切り（CLAUDE.md §1）— 学習ジョブは長時間の
    # バッチ処理で「🔥火をくべる」的な連続実行UXが無いため、30秒Keep-Warmの
    # 恩恵がなくアイドル課金だけが残る。動画生成系GPUワーカー（WanAnimate等）
    # は引き続き30秒を維持。
    scaledown_window=2,
    secrets=[
        modal.Secret.from_name("supabase-model-downloads"),
        modal.Secret.from_name("wan-animate-auth"),
        modal.Secret.from_name("huggingface-secret"),
        modal.Secret.from_name("r2-artifacts"),  # R2 成果物ストア（ull_r2.py）
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
    for _d in (HF_HUB_CACHE_DIR, TORCH_CACHE_DIR, INDUCTOR_CACHE_DIR, TRITON_CACHE_DIR):
        pathlib.Path(_d).mkdir(parents=True, exist_ok=True)
    print(
        f"[train] HF_HOME={HF_CACHE_DIR} MODELS_PATH={MODELS_DIR} "
        "(Volume-local; download guard = _missing_base_artifacts Fail-Fast)",
        flush=True,
    )

    job_id = str(params.get("job_id") or "")
    user_id = str(params.get("user_id") or "")
    credits_cost = int(params.get("credits_cost") or 0)
    # Cost-guard budget (seconds) pre-computed by the API from the credit price
    # and the admin-editable pricing_knobs thresholds. When present it is used
    # verbatim instead of re-deriving from credits_cost with hardcoded rates
    # (see _cost_cap_seconds). 0 / missing -> fall back to the internal calc.
    try:
        cost_cap_override = int(float(params.get("cost_cap_seconds") or 0))
    except (TypeError, ValueError):
        cost_cap_override = 0
    lora_name = str(params.get("output_lora_name") or "").strip()
    target_model = str(params.get("target_model") or "minimax_h3")
    custom_model_id = str(params.get("custom_model_id") or "").strip()
    base_architecture = str(params.get("base_architecture") or "").strip()
    resolution = int(params.get("resolution") or 768)
    tc = dict(params.get("training_config") or {})
    override = tc.get("custom_yaml_override")

    if _is_blocked_model(target_model) or _is_blocked_model(custom_model_id):
        raise ValueError("FLUX.1 [dev] / FLUX.2 [klein] 9B is blocked in LoRA Studio (non-commercial licence)")

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
                    # 16 本並行でコピーする（2026-09-24）。Volume はファイル単位の往復が重く、
                    # 220 枚を 1 枚ずつコピーすると 58 秒 GPU が待っていた。
                    from concurrent.futures import ThreadPoolExecutor as _StageTPE

                    dests = [dataset / f"{i:04d}{src.suffix.lower()}" for i, src in enumerate(found)]
                    _t_stage = time.time()
                    with _StageTPE(max_workers=16) as _ex:
                        list(_ex.map(lambda sd: shutil.copy2(sd[0], sd[1]), zip(found, dests)))
                    image_paths.extend(dests)
                    print(f"[train] staging copy {time.time() - _t_stage:.1f}s ({len(dests)} files, 16 parallel)", flush=True)
                    staged_from_ingest = True
                    print(
                        f"[train] staged {len(image_paths)} pre-optimized images "
                        f"from {ingest_src} (Smart Ingest — no Supabase download)",
                        flush=True,
                    )

        if staged_from_ingest:
            pass  # images already in /root/dataset
        elif storage_paths:
            # Primary path (Smart Ingest 未使用時のフォールバック): ブラウザが
            # upload_lora_dataset_image でVolumeへ直接アップロード済み
            # （2026-09-19、Supabase Storageから移行）。object key ("<user_id>/
            # <dataset_id>/<file>") をそのままVolume相対パスとして読む。
            for i, key in enumerate(storage_paths):
                data = _read_lora_dataset_upload(str(key))
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
        print(f"[train] stage 1 done in {time.time() - started:.0f}s / {_host_ram_report()}", flush=True)

        # Bundle the FULL training dataset — every staged image TOGETHER WITH
        # its .txt caption (Qwen-generated or user-supplied) — into dataset.zip
        # so the completed screen can offer a 1-hop "download the captioned
        # dataset" button. Persisted to the Volume next to the checkpoints in
        # the publish step below and registered in metadata.checkpoints as
        # is_caption_archive. Images + captions sit side by side once unzipped
        # (0000.png / 0000.txt), so the set is directly re-trainable.
        #
        # 2026-09-24: the ZIP and the Volume persist below ran on the GPU's
        # critical path (18s + 2s on 220 images, B300 idle). They only have to
        # be done by the completion step, so they now run on a background
        # thread while ai-toolkit loads and trains; `_dataset_bg.join()` right
        # before dataset.zip is registered. Images are STORED (PNG/WebP are
        # already compressed — DEFLATE only burned CPU).
        dataset_zip_path = pathlib.Path("/root/dataset.zip")
        _zip_members = sorted(
            p
            for p in dataset.iterdir()
            if p.is_file() and (p.suffix.lower() == ".txt" or p.suffix.lower() in IMAGE_EXTS)
        )
        _persist_pairs = (
            [(p, p.with_suffix(".txt")) for p in image_paths]
            if persist_dir and not reused_from_volume
            else []
        )
        _dataset_bg_result: dict = {"zip_ok": False}

        def _dataset_bg_work() -> None:
            t0 = time.time()
            try:
                n_txt = sum(1 for p in _zip_members if p.suffix.lower() == ".txt")
                n_img = len(_zip_members) - n_txt
                with zipfile.ZipFile(dataset_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                    for m in _zip_members:
                        ct = zipfile.ZIP_DEFLATED if m.suffix.lower() == ".txt" else zipfile.ZIP_STORED
                        zf.write(m, arcname=m.name, compress_type=ct)
                _dataset_bg_result["zip_ok"] = True
                print(
                    f"[train] wrote {dataset_zip_path} ({n_img} image(s) + {n_txt} caption file(s)) "
                    f"in {time.time() - t0:.1f}s (background)",
                    flush=True,
                )
            except Exception as exc:  # noqa: BLE001 — the archive is a nice-to-have
                print(f"[train] dataset.zip build skipped: {exc}", flush=True)
            # Persist images + captions to the Volume so the next run of this
            # dataset_id skips Stage 1 entirely.
            if _persist_pairs:
                t1 = time.time()
                try:
                    persist_dir.mkdir(parents=True, exist_ok=True)
                    for i, (img, txt) in enumerate(_persist_pairs):
                        shutil.copy2(img, persist_dir / f"{i:04d}{img.suffix or '.png'}")
                        shutil.copy2(txt, persist_dir / f"{i:04d}.txt")
                    with _VOL_COMMIT_LOCK:
                        vol.commit()
                    print(
                        f"[train] persisted {len(_persist_pairs)} image+caption pairs to {persist_dir} "
                        f"in {time.time() - t1:.1f}s (background)",
                        flush=True,
                    )
                except Exception as exc:  # noqa: BLE001 — caching is best-effort
                    print(f"[train] caption persist skipped: {exc}", flush=True)

        _dataset_bg = threading.Thread(target=_dataset_bg_work, name="dataset-zip-persist", daemon=True)
        _dataset_bg.start()

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
        with _VOL_COMMIT_LOCK:
            vol.commit()  # make the per-job output dir visible on the Volume
        print(f"[stage2] ai-toolkit output -> {job_output_dir} (on Volume)", flush=True)
        # 画像ごとの学習回数。persist（キャプションキャッシュ）と dataset.zip は
        # フラットな image_paths を前提にしているので、**それらが済んでから**
        # グループ分けする（ファイルを移動するため）。
        _repeats = _normalize_repeats(params, len(image_paths))
        dataset_groups = _group_dataset_by_repeats(image_paths, _repeats)
        if len(dataset_groups) > 1:
            print(
                f"[train] 学習回数の重み付けあり: {len(dataset_groups)} グループ "
                + "(" + " / ".join(f"x{n}" for n, _ in dataset_groups) + ")",
                flush=True,
            )
        # 複数人物（2 人目以降のトリガーがある）ジョブは trigger_word を設定しない（_build_config 参照）。
        _extra_triggers = [str(t).strip() for t in (params.get("extra_triggers") or []) if str(t).strip()]
        if _extra_triggers:
            print(f"[train] 複数人物: trigger_word を設定しない（{trigger} + {', '.join(_extra_triggers)}）", flush=True)
        config_path = _build_config(
            lora_name, trigger, target_model, tc, override, custom_model_id,
            base_architecture, resolution, job_output_dir, dataset_groups,
            inject_trigger=not _extra_triggers,
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
            credits_cost, target_model, total_steps or 0, base_architecture,
            override_s=cost_cap_override,
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
        # 2026-09-23: loras/ 直下の `loras/<lora_name>.safetensors`（ComfyUI が名前で
        # 引くためのエイリアス）は廃止。使う導線が無く（Custom タブ廃止・Director は
        # director_user_loras/ 経由）、final が二重に置かれるだけだった。final が最良とは
        # 限らない（ホスト判断）ので、特定の1本を特別扱いする理由も無い。
        # result_path は loras/<user>/<job>/<name>_final.safetensors を指す。
        os.makedirs(LORA_OUTPUT_DIR, exist_ok=True)

        final_lora = _collect_final_lora(lora_name, job_output_dir)
        dest_path: pathlib.Path | None = None

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
                    shutil.move(str(path), str(dst))  # rename on the same Volume
                    entry["path"] = f"loras/{user_id}/{job_id}/{fname}"
                    if is_final:
                        dest_path = dst
                except Exception as exc:  # noqa: BLE001 — one bad file must not block completion
                    print(f"[train] checkpoint relocate skipped ({fname}): {exc}", flush=True)
            checkpoints.append(entry)
        checkpoints.sort(key=lambda c: c["step"])
        if dest_path is None:
            # user_id / job_id が無い経路（本番では起きない）だけ旧来の平置きに落とす。
            dest_path = pathlib.Path(LORA_OUTPUT_DIR) / f"{lora_name}.safetensors"
            shutil.copy2(final_lora, dest_path)
        print(f"[train] final LoRA -> {dest_path} ({dest_path.stat().st_size / 1024**2:.1f} MB)")

        # NOTE: no more synchronous `checkpoints_all.zip` here. A 14GB
        # ZIP_STORED write on B300 was pure GPU idle. Users download the
        # intermediates individually (each has its own `path`); a bundle ZIP
        # is still produced on-demand by the CPU-only salvage path.

        # 3) dataset.zip (images + captions) -> loras/<user_id>/<job_id>/
        #    dataset.zip, registered alongside the weights so the completed
        #    screen's "キャプション付きデータセットDL (ZIP)" button can pull it
        #    through the same signed-URL path.
        _t_join = time.time()
        _dataset_bg.join(timeout=600)
        if time.time() - _t_join > 1:
            print(f"[train] waited {time.time() - _t_join:.1f}s for the background dataset.zip", flush=True)
        if not _dataset_bg_result["zip_ok"] or _dataset_bg.is_alive():
            dataset_zip_path = None
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

        # 4) R2 への publish は GPU ではやらない（2026-09-23 初回ジョブで 327s の
        #    B300 アイドルを踏んだ）。完了行を書いた直後に CPU 関数
        #    publish_lora_artifacts_r2 を spawn し、そちらが Volume → R2 へ
        #    上げて metadata.checkpoints[].r2_key を焼き込み、Volume 側を消す。
        vol.commit()
        print(f"[train] persisted {len(checkpoints)} checkpoint(s) -> {job_ckpt_dir or '(local, skipped)'}")

        final_vram = _current_effective_vram_gb()
        metadata = {"checkpoints": checkpoints, "gpu_tier": _gpu_tier_label()}
        if final_vram is not None:
            metadata["vram_used_gb"] = final_vram
        # 完了時の瞬間値は学習プロセス終了後なのでほぼ空（実測 0.6GB）。
        # 走行中のピークを別キーで残す（CLAUDE.md §6-3）。
        _peak = _track_vram_peak(final_vram) if final_vram is not None else _VRAM_PEAK["gb"]
        if _peak > 0:
            metadata["vram_peak_gb"] = _peak

        # --- arch 別 knob の校正用メトリクス（_RUN_METRICS の説明参照）---------
        # ここで初めて「どの設定で s/it と prep が何秒だったか」が1行に揃う。
        # ベンチを14 arch ぶん回す代わりに、実ジョブが走るたびにこれが溜まる。
        try:
            _metrics = dict(_RUN_METRICS)
            _metrics.update(
                {
                    "arch": _arch_for_target(target_model, base_architecture),
                    "resolution": int(resolution or 0),
                    "images": len(image_paths),
                    "steps_config": int(total_steps or 0),
                    "raw_yaml": bool(override),
                }
            )
            # batch / compile は生YAML で変わるので、実際に ai-toolkit へ渡した
            # config から読む（GUI モードは batch 1 固定・compile は env 既定）。
            try:
                _cfg = yaml.safe_load(pathlib.Path(config_path).read_text(encoding="utf-8"))
                _proc = (((_cfg or {}).get("config") or {}).get("process") or [{}])[0]
                _tr = _proc.get("train") or {}
                _md = _proc.get("model") or {}
                _metrics.update(
                    {
                        "batch_size": int(_tr.get("batch_size") or 1),
                        "grad_accum": int(_tr.get("gradient_accumulation") or 1),
                        "gradient_checkpointing": bool(_tr.get("gradient_checkpointing")),
                        "compile": bool(_md.get("compile")),
                        "block_compile": bool(_md.get("block_compile")),
                        "cache_text_embeddings": bool(_tr.get("cache_text_embeddings")),
                    }
                )
            except Exception as _cfg_exc:  # noqa: BLE001 — telemetry only
                print(f"[perf] config の読み取りをスキップ: {_cfg_exc!r}", flush=True)
            metadata["metrics"] = _metrics
            print(f"[perf] metrics -> {_metrics}", flush=True)
        except Exception as _mt_exc:  # noqa: BLE001 — telemetry only, never fatal
            print(f"[perf] metrics の記録をスキップ: {_mt_exc!r}", flush=True)

        metadata["host_ram_peak_gb"] = _host_ram_peak_gb()
        print(f"[train] {_host_ram_report()}", flush=True)
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
        _spawn_r2_publish(job_id)
        return {
            "lora_path": str(dest_path),
            "lora_filename": dest_path.name,
            # 2026-09-23: 初回 R2 ジョブは完了 PATCH の後にここで unlink 済みファイルを
            # stat して例外 → except 側が failed + 返金で上書きした。ファイルの有無に
            # 依存しない値を使う。
            "size_bytes": next((c.get("size_bytes", 0) for c in checkpoints if c.get("is_final")), 0),
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

        meta: dict = {
            "refunded": should_refund,
            "custom_yaml": is_custom_yaml,
            "infra_error": infra,
            "gpu_tier": _gpu_tier_label(),
        }
        # 失敗・安全停止のときも VRAM ピークと計測値は残す（OOM 由来の失敗や
        # 見積もりミスを後から切り分けるのに要る）。
        if _VRAM_PEAK["gb"] > 0:
            meta["vram_peak_gb"] = _VRAM_PEAK["gb"]
        if _RUN_METRICS:
            meta["metrics"] = dict(_RUN_METRICS)
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
        if meta.get("checkpoints"):
            _spawn_r2_publish(job_id)
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
_dispatch_base = (
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
# add_local_python_source must be the last step of an image, so the helper modules are added
# per leaf image (dispatch / ingest / publish) rather than on the shared base.
dispatch_image = _dispatch_base.add_local_python_source(*_LORA_WORKER_MODULES)

# Smart Ingest image = dispatch_image (tiny, warm base) + Pillow. Inherits
# dispatch_image rather than rebuilding from debian_slim so this module's
# top-level `import fastapi / modal / yaml` still resolve inside the container.
# 2026-09-23: + boto3 / ull_r2 — dataset uploads now land in R2 (browser →
# presigned PUT, docs/STATUS.md R2 plan step 4) and Smart Ingest reads /
# purges them there. `add_local_python_source` must stay the last step.
ingest_image = _dispatch_base.pip_install("Pillow>=10.2", "boto3>=1.35").add_local_python_source(
    "ull_r2", *_LORA_WORKER_MODULES
)

# R2 publish image = dispatch_image + boto3 + ull_r2 (CPU only, tiny).
publish_image = _dispatch_base.pip_install("boto3>=1.35").add_local_python_source("ull_r2", *_LORA_WORKER_MODULES)


def _spawn_r2_publish(job_id: str) -> None:
    """Fire-and-forget: hand the Volume -> R2 upload to the CPU function.
    Never raises — a spawn failure just leaves the files on the Volume, where
    the download routes still find them."""
    try:
        from ull_r2 import r2_enabled

        if not r2_enabled():
            print(f"[r2] disabled — job {job_id[:8]} stays on the Volume", flush=True)
            return
        publish_lora_artifacts_r2.spawn(job_id)
        print(f"[r2] publish spawned for job {job_id[:8]}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[r2] publish spawn failed for job {job_id[:8]}: {exc!r}", flush=True)


@app.function(
    image=publish_image,
    volumes={MODELS_DIR: vol},
    timeout=3600,
    scaledown_window=2,
    secrets=[
        modal.Secret.from_name("supabase-model-downloads"),
        modal.Secret.from_name("r2-artifacts"),
    ],
)
def publish_lora_artifacts_r2(job_id: str) -> dict:
    """CPU: upload a finished (or salvaged) job's loras/<user>/<job>/ files to
    R2, stamp `r2_key` on metadata.checkpoints, delete the Volume copies.
    Spawned by train_lora_job right after it PATCHes the job row, so the row
    is the source of truth for what to upload (docs/STATUS.md R2 計画 2)."""
    import ull_r2

    if not ull_r2.r2_enabled():
        return {"skipped": "r2 disabled"}
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[r2] vol.reload() skipped: {exc}", flush=True)
    res = _supabase_request(
        "GET", "/rest/v1/generation_jobs", params={"id": f"eq.{job_id}", "select": "user_id,metadata"}
    )
    rows = res.json() if res is not None and res.ok else []
    if not rows:
        print(f"[r2] job {job_id} not found", flush=True)
        return {"error": "job not found"}
    user_id = rows[0]["user_id"]
    meta = rows[0].get("metadata") or {}
    merged = ull_r2.publish_job_meta_from_volume(MODELS_DIR, "loras", user_id, job_id, meta)
    if merged is None:
        return {"uploaded": 0}
    # metadata だけの PATCH（status は触らない → generation_logs のトリガーは発火しない）。r2_key を書いてから
    # Volume 側を消す（2026-09-26、順番が逆だと転送中に「checkpoint not found」になった）。
    _patch_job(job_id, {"metadata": merged})
    # 書けたか読み直して確かめてから消す（_patch_job は失敗を返さない。書けていないのに消すと R2 にしか無いのに
    # 行から辿れなくなる）。確かめられなければ Volume 側は残す（14 日パージで消える）。
    chk = _supabase_request(
        "GET", "/rest/v1/generation_jobs", params={"id": f"eq.{job_id}", "select": "metadata->checkpoints"}
    )
    try:
        saved = (chk.json() or [{}])[0].get("checkpoints") or [] if chk is not None and chk.ok else []
    except Exception:  # noqa: BLE001
        saved = []
    want = {c.get("filename") for c in merged.get("checkpoints") or [] if c.get("r2_key")}
    have = {c.get("filename") for c in saved if c.get("r2_key")}
    if not want or not want <= have:
        print(f"[r2] metadata PATCH not confirmed ({len(have)}/{len(want)}) — keeping Volume copies", flush=True)
        return merged.get("r2_publish", {})
    removed = ull_r2.remove_published_local(MODELS_DIR, "loras", user_id, job_id, merged)
    try:
        vol.commit()  # persist the unlinks
    except Exception as exc:  # noqa: BLE001
        print(f"[r2] vol.commit() skipped: {exc}", flush=True)
    print(f"[r2] removed {removed} Volume copies after metadata PATCH", flush=True)
    return merged.get("r2_publish", {})


# TEST HARNESS: a GPU-less no-op that never touches generation_jobs, so the
# DB row stays 'queued' forever — an artificial, storm-free way to verify
# the client's pending-timeout auto-failover (cancel -> retry -> refund)
# against real, cancellable Modal FunctionCalls. Triggered by _test_stub in
# the dispatch payload (Next.js sets it when LORA_TRAIN_TEST_STUB=1).
@app.function(image=dispatch_image, timeout=900, scaledown_window=2)
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
    scaledown_window=2,
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
    secrets=[
        modal.Secret.from_name("supabase-model-downloads"),
        modal.Secret.from_name("r2-artifacts"),  # dataset uploads live in R2 (2026-09-23)
    ],
    # LoRA worker は全関数一律2秒即切り（CLAUDE.md §1）。
    scaledown_window=2,
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
    PERSIST_ROOT/<dataset_id>/_ingest/<ingest_key>/NNNN<INGEST_EXT> (index-keyed).

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
                purged = _delete_lora_dataset_uploads(storage_paths)
                print(
                    f"[ingest] cache-hit — purged {purged}/{n} source uploads from Volume",
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
        raw = _read_lora_dataset_upload(str(key_path))  # missing upload -> hard fail
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
        save_kw = {"format": INGEST_FMT}
        if INGEST_FMT == "PNG":
            save_kw["compress_level"] = INGEST_PNG_COMPRESS
        else:
            save_kw["quality"] = INGEST_QUALITY
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
        # are now dead weight. Purge them immediately rather than waiting for
        # the 14-day safety-net purge (CLAUDE.md §3). Best-effort, never fatal.
        if os.environ.get("ULL_INGEST_PURGE_SOURCE", "1") != "0":
            purged = _delete_lora_dataset_uploads(storage_paths)
            print(
                f"[ingest] purged {purged}/{n} source uploads from Volume after optimisation",
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
    scaledown_window=2,
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
    _override_raw = dict(item.get("training_config") or {}).get("custom_yaml_override")
    override = bool(_override_raw)

    # Structural pre-flight for raw-YAML jobs: a missing `job` / `config` /
    # `config.process` makes ai-toolkit's toolkit/config.py raise on load —
    # catch it here (CPU, before the GPU spawn) with a clear message + refund
    # instead of burning a container start on a cryptic ValueError.
    _struct_err = _override_structure_error(_override_raw)
    if _struct_err:
        return _fail(_struct_err)

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

        _arch = _arch_for_target(
            str(item.get("target_model") or ""), str(item.get("base_architecture") or "")
        )
        # Next の価格式（loraArchGpuTier）が payload の gpu_tier で tier を指定してくる。
        # 課金がその tier の時給で計算されているので、実行 tier もそれに合わせる（SSOT は Next 側）。
        # 既定の b300 は従来どおり GPU_REQUEST（B300/B200 のフォールバック付き）で回す。
        _req = str(item.get("gpu_tier") or "").strip().lower()
        _tier = _MODAL_GPU_NAME.get(_req, "") if _req and _req != "b300" else ""
        if not _tier:
            _tier = LORA_ARCH_GPU.get(_arch, "")
        _train_fn = train_lora_job.with_options(gpu=_tier) if _tier else train_lora_job
        print(f"[dispatch] arch={_arch} gpu={_tier or GPU_REQUEST}", flush=True)
        call = _train_fn.spawn(item)
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
    scaledown_window=2,
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


@app.function(
    image=dispatch_image,
    timeout=30,
    scaledown_window=2,
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
    scaledown_window=2,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="POST")
def train_lora_cancel(item: dict, request: fastapi.Request):
    _authorize(request)
    res = _cancel_function_call(item.get("modal_call_id") or item.get("call_id") or "")
    return {"ok": True, "cancelled": bool(res.get("success")), **res}


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol},
    # アップロードも600MB-1GB+になりうるので download_lora_checkpoint と
    # 同じ余裕を持たせる。
    timeout=3600,
    scaledown_window=2,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="POST")
async def upload_user_lora(
    user_id: str, filename: str, expires: str, sig: str, request: fastapi.Request, offset: str = "0"
):
    """外部LoRAの直接アップロード。offset>0 のときは末尾追記で再開する
    （2026-09-19導入 — ブラウザがタブのバックグラウンド化・スリープ・
    ネットワーク切断等で1GB級のアップロード中に落ちても、ゼロから送り
    直さず続きから送れるようにするため。ホスト指摘: 「仕掛けたらブラウザ
    を落として良い」という使い方が前提なら、単発fetchで送りっぱなしは
    脆すぎる）。offsetはクライアントが director_lora_upload_status で
    事前に確認した値をそのまま渡す想定——サーバー側で実際のファイルサイズ
    と一致するか必ず検証し、食い違っていれば409で弾いて再確認を促す
    （並行アップロードや古い部分ファイルからの誤った継続を防ぐ）。"""
    if not _verify_upload_token(user_id, filename, expires, sig):
        raise fastapi.HTTPException(status_code=403, detail="invalid or expired upload link")
    if not (
        _CKPT_DL_ID_RE.match(user_id)
        and _CKPT_DL_FILENAME_RE.match(filename)
        and filename.endswith(".safetensors")
    ):
        raise fastapi.HTTPException(status_code=400, detail="invalid parameters")
    try:
        start_offset = int(offset)
        if start_offset < 0:
            raise ValueError
    except ValueError:
        raise fastapi.HTTPException(status_code=400, detail="invalid offset") from None

    dest_dir = pathlib.Path(MODELS_DIR) / DIRECTOR_USER_LORA_SUBDIR / user_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / filename

    try:
        # async def の中で同期版 vol.reload() を呼ぶと AsyncUsageWarning が出る
        # （2026-09-19実機ログで確認）。.aio() 版を使う。
        await vol.reload.aio()
    except Exception as exc:  # noqa: BLE001
        print(f"[director-lora-upload] vol.reload() skipped: {exc}", flush=True)

    current_size = dest_path.stat().st_size if dest_path.is_file() else 0
    if start_offset != current_size:
        raise fastapi.HTTPException(
            status_code=409,
            detail=f"offset mismatch (client={start_offset}, server has={current_size}) — re-check status and retry",
        )

    mode = "ab" if start_offset > 0 else "wb"
    size = start_offset
    try:
        # buffering=_DL_CHUNK: request.stream() から来る小さいチャンク
        # （ASGIサーバー由来で数十KB程度）をそのまま f.write() すると、
        # download 側で経験済みの「Modal Volume (NFS) への書き込みは
        # 1回あたりのオーバーヘッドが大きく、小さい書き込みを大量に行うと
        # 実効速度が数KB/秒まで落ち込む」現象がアップロード側でも起きる
        # （_stream_download の 4 MiB バッファ読み込みと同じ問題の書き込み版）。
        # BufferedWriter に 4 MiB のバッファを持たせ、実際の書き込み
        # syscall を 4 MiB 単位にまとめて解決する。
        with open(dest_path, mode, buffering=_DL_CHUNK) as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > _UPLOAD_MAX_BYTES:
                    dest_path.unlink(missing_ok=True)
                    raise fastapi.HTTPException(status_code=413, detail="file too large (max 2GB)")
                f.write(chunk)
    except fastapi.HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        # ネットワーク切断等の中断——部分ファイルは消さない。次回のステータス
        # 確認・レジュームでこの続きから送れるようにするため（413の桁違い
        # オーバーだけは上でファイル自体を破棄済み）。
        raise fastapi.HTTPException(status_code=500, detail=f"upload interrupted: {exc}") from exc

    await vol.commit.aio()
    rel_path = f"{DIRECTOR_USER_LORA_SUBDIR}/{user_id}/{filename}"
    print(
        f"[director-lora-upload] saved {rel_path} ({size / 1024**2:.1f} MB"
        f"{f', resumed from {start_offset / 1024**2:.1f} MB' if start_offset else ''})",
        flush=True,
    )
    return {"ok": True, "path": rel_path, "size_bytes": size}


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol},
    timeout=300,
    scaledown_window=2,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
# 2026-09-20: ブラウザ側を並列アップロードに変えた（src/lib/loraApi.ts の
# UPLOAD_CONCURRENCY）のに合わせて、1コンテナで同時に受けられるようにする。
# これが無いと同時リクエストの数だけコンテナが立ち、各リクエストが自分の
# コールドスタートを待つので並列化の効きが削れる。実体は受信ストリームと
# Volume commit の I/O 待ちなので、GPU も CPU も食わない。
@modal.concurrent(max_inputs=8)
@modal.fastapi_endpoint(method="POST")
async def upload_lora_dataset_image(
    user_id: str, dataset_id: str, filename: str, expires: str, sig: str, request: fastapi.Request
):
    if not _verify_dataset_upload_token(user_id, dataset_id, expires, sig):
        raise fastapi.HTTPException(status_code=403, detail="invalid or expired upload link")
    if not (
        _CKPT_DL_ID_RE.match(user_id)
        and _CKPT_DL_ID_RE.match(dataset_id)
        and _DATASET_IMG_FILENAME_RE.match(filename)
    ):
        raise fastapi.HTTPException(status_code=400, detail="invalid parameters")

    dest_dir = pathlib.Path(LORA_DATASET_UPLOADS_DIR) / user_id / dataset_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / filename

    # 学習用画像1枚あたりの上限。500枚 * 40MBでも十分な安全弁
    # （通常のスマホ写真・イラストは数MB程度）。
    max_bytes = 40 * 1024 * 1024
    size = 0
    try:
        with open(dest_path, "wb", buffering=_DL_CHUNK) as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > max_bytes:
                    dest_path.unlink(missing_ok=True)
                    raise fastapi.HTTPException(status_code=413, detail="file too large (max 40MB)")
                f.write(chunk)
    except fastapi.HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        dest_path.unlink(missing_ok=True)
        raise fastapi.HTTPException(status_code=500, detail=f"upload failed: {exc}") from exc

    await vol.commit.aio()
    rel_path = f"{user_id}/{dataset_id}/{filename}"
    return {"ok": True, "path": rel_path, "size_bytes": size}


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol},
    timeout=900,
    # 2026-09-20: cpu/memory を明示する。未指定だと Modal の既定（0.125 CPU）
    # で multipart パースと Volume 書き込みを max_inputs 本ぶん捌くことになり、
    # ここが律速になっていた。ホストの上り帯域は 540Mbps あるのに実効
    # 14.3Mbps（2.6%）しか出ず、1リクエスト 14.43秒 のうち Modal 側の
    # execution が 10〜14秒 を占めていた。docs/gpu-benchmarks.md §15。
    cpu=4,
    memory=4096,
    scaledown_window=2,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
# 2026-09-20: 1枚1リクエストだと 400KB の送信に 4.3秒（=0.74Mbps/接続）かかって
# いた。クライアントの並列度を6->10に上げても実効は 7.2->7.7Mbps とほぼ動かず、
# 律速は帯域ではなく1リクエストあたりの固定コスト（ラウンドトリップ＋毎回の
# vol.commit()）だった。複数枚を1リクエストで受けて commit を1回にまとめる。
# 実測の経緯は docs/gpu-benchmarks.md §15。
# 単枚版（upload_lora_dataset_image）はフォールバック経路として残す
# — Vercel だけ先に上がって Modal が未デプロイでもアップロードが壊れないように。
# max_inputs はブラウザ側の BATCH_CONCURRENCY(8) より広く取る。受信と
# Volume 書き込みの I/O 待ちしかしないので、ここで詰まらせるとクライアントの
# 並列がそのまま無駄になる（2026-09-20: 並列4で 14リクエストが3.5ラウンドに
# なり、全体46.7秒のうち実質すべてがこのラウンド数で決まっていた）。
# ハンドラ本体は1リクエスト1〜3秒しか使わない（受信は FastAPI が
# UploadFile を解決する時点で終わっている）ので、32本受けても CPU は余る。
@modal.concurrent(max_inputs=32)
@modal.fastapi_endpoint(method="POST")
async def upload_lora_dataset_batch(
    user_id: str,
    dataset_id: str,
    expires: str,
    sig: str,
    files: list[fastapi.UploadFile] = fastapi.File(...),
):
    if not _verify_dataset_upload_token(user_id, dataset_id, expires, sig):
        raise fastapi.HTTPException(status_code=403, detail="invalid or expired upload link")
    if not (_CKPT_DL_ID_RE.match(user_id) and _CKPT_DL_ID_RE.match(dataset_id)):
        raise fastapi.HTTPException(status_code=400, detail="invalid parameters")
    if not files:
        raise fastapi.HTTPException(status_code=400, detail="no files in batch")
    if len(files) > _DATASET_BATCH_MAX_FILES:
        raise fastapi.HTTPException(
            status_code=400, detail=f"too many files (max {_DATASET_BATCH_MAX_FILES})"
        )

    t_start = time.monotonic()
    dest_dir = pathlib.Path(LORA_DATASET_UPLOADS_DIR) / user_id / dataset_id
    dest_dir.mkdir(parents=True, exist_ok=True)

    max_bytes = 40 * 1024 * 1024  # 1枚あたり。単枚エンドポイントと同じ安全弁
    written: list[dict] = []
    total = 0
    current: pathlib.Path | None = None
    try:
        for upload in files:
            filename = os.path.basename(upload.filename or "")
            if not _DATASET_IMG_FILENAME_RE.match(filename):
                raise fastapi.HTTPException(
                    status_code=400, detail=f"invalid filename: {filename}"
                )
            current = dest_dir / filename
            size = 0
            with open(current, "wb", buffering=_DL_CHUNK) as f:
                while True:
                    chunk = await upload.read(_DL_CHUNK)
                    if not chunk:
                        break
                    size += len(chunk)
                    total += len(chunk)
                    if size > max_bytes:
                        raise fastapi.HTTPException(
                            status_code=413, detail=f"file too large (max 40MB): {filename}"
                        )
                    if total > _DATASET_BATCH_MAX_BYTES:
                        raise fastapi.HTTPException(status_code=413, detail="batch too large")
                    f.write(chunk)
            written.append({"path": f"{user_id}/{dataset_id}/{filename}", "size_bytes": size})
            current = None
    except Exception:
        # 半端に書けたものを残さない。呼び出し側はバッチ単位で中止する。
        if current is not None:
            current.unlink(missing_ok=True)
        for item in written:
            pathlib.Path(LORA_DATASET_UPLOADS_DIR, item["path"]).unlink(missing_ok=True)
        raise

    # 枚数ぶんではなく、このバッチで1回だけ。ここが単枚版との違い。
    t_write = time.monotonic()
    await vol.commit.aio()
    t_commit = time.monotonic()
    # 受信＋書き込みと commit のどちらが効いているかを毎回1行で残す。
    # 「1リクエストの時間はほぼ全部サーバー側」と分かっている以上、次に削る
    # 相手はこの内訳でしか決まらない。
    print(
        f"[upload-batch] {len(files)}枚 {total / 1048576:.1f}MB "
        f"recv+write={t_write - t_start:.2f}s commit={t_commit - t_write:.2f}s",
        flush=True,
    )
    return {"ok": True, "files": written, "size_bytes": total}


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol_ro},
    timeout=60,
    scaledown_window=2,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="GET")
def director_lora_upload_status(user_id: str, filename: str, expires: str, sig: str):
    """upload_user_loraと同じ署名付きトークンで認証する、レジューム用の
    「どこまで届いているか」確認エンドポイント（2026-09-19導入）。
    _verify_upload_tokenのペイロードはHTTPメソッドを含まないため、
    アップロード用に発行した1枚のチケットをこちらにもそのまま使い回せる。"""
    if not _verify_upload_token(user_id, filename, expires, sig):
        raise fastapi.HTTPException(status_code=403, detail="invalid or expired upload link")
    if not (
        _CKPT_DL_ID_RE.match(user_id)
        and _CKPT_DL_FILENAME_RE.match(filename)
        and filename.endswith(".safetensors")
    ):
        raise fastapi.HTTPException(status_code=400, detail="invalid parameters")
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[director-lora-upload-status] vol.reload() skipped: {exc}", flush=True)
    dest_path = pathlib.Path(MODELS_DIR) / DIRECTOR_USER_LORA_SUBDIR / user_id / filename
    size = dest_path.stat().st_size if dest_path.is_file() else 0
    return {"exists": size > 0, "size_bytes": size}


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
    # Read-only: only streams files — a RW mount would let its stale snapshot
    # auto-commit deleted checkpoints back onto the Volume.
    volumes={MODELS_DIR: vol_ro},
    # Checkpoints run 600MB-1GB+ (a rank-32 minimax_h3 LoRA is ~1.18GB) and a
    # slow / unstable mobile link can crawl at <1MB/s, so give the whole
    # transfer a full hour before Modal kills the container mid-stream. The
    # response is Range-aware, so a dropped connection resumes instead of
    # restarting.
    timeout=3600,
    # 2秒即切り（CLAUDE.md §1、LoRA worker）— min_containers は使わず、
    # コールドスタート許容でアイドル課金ゼロを優先する。
    scaledown_window=2,
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
    # min_containers を廃止したので毎回ほぼ確実に新規コンテナ = 新規マウントだが、
    # 稀に別コンテナが直前に書いた最新コミットを取りこぼす窓が残るため、
    # 安全側として引き続き明示的に pull しておく。
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


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol_ro},  # read-only: reads checkpoints, zips into /tmp
    timeout=3600,
    scaledown_window=2,
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


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol_ro},  # read-only: streams files only, never writes
    timeout=3600,
    scaledown_window=2,
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
    volumes={MODELS_DIR: vol_ro},  # 現在のサイズを見るだけ
    timeout=300,
    scaledown_window=2,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="GET")
def admin_upload_volume_status(path: str, expires: str, sig: str, request: fastapi.Request):
    """レジューム用。送信済みバイト数を返す。クライアントはこの値を offset
    としてそのまま PUT に渡す。"""
    if not _verify_admin_token("upload", path, expires, sig):
        raise fastapi.HTTPException(status_code=403, detail="invalid or expired link")
    dest = _admin_upload_dest(path)
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[admin-upload] vol.reload() skipped: {exc}", flush=True)
    size = dest.stat().st_size if dest.is_file() else 0
    return {"ok": True, "path": path, "uploaded_bytes": size}


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol},  # 書き込むので read-only ではない
    timeout=3 * 3600,
    scaledown_window=2,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="PUT")
async def admin_upload_volume_file(
    path: str, expires: str, sig: str, request: fastapi.Request, offset: str = "0"
):
    if not _verify_admin_token("upload", path, expires, sig):
        raise fastapi.HTTPException(status_code=403, detail="invalid or expired link")
    dest = _admin_upload_dest(path)
    try:
        start_offset = int(offset)
        if start_offset < 0:
            raise ValueError
    except ValueError:
        raise fastapi.HTTPException(status_code=400, detail="invalid offset") from None

    try:
        # async def の中で同期版 vol.reload() を呼ぶと AsyncUsageWarning が出る。
        await vol.reload.aio()
    except Exception as exc:  # noqa: BLE001
        print(f"[admin-upload] vol.reload() skipped: {exc}", flush=True)

    dest.parent.mkdir(parents=True, exist_ok=True)
    current_size = dest.stat().st_size if dest.is_file() else 0
    if start_offset != current_size:
        # 並行アップロードや古い部分ファイルからの誤った継続を防ぐ。
        raise fastapi.HTTPException(
            status_code=409,
            detail=f"offset mismatch (client={start_offset}, server has={current_size}) — re-check status and retry",
        )

    mode = "ab" if start_offset > 0 else "wb"
    size = start_offset
    try:
        with open(dest, mode, buffering=_DL_CHUNK) as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > _ADMIN_UPLOAD_MAX_BYTES:
                    dest.unlink(missing_ok=True)
                    raise fastapi.HTTPException(status_code=413, detail="file too large")
                f.write(chunk)
    except fastapi.HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        # 中断しても部分ファイルは消さない（次回 status -> offset で再開する）。
        raise fastapi.HTTPException(status_code=500, detail=f"upload interrupted: {exc}") from exc

    await vol.commit.aio()
    print(
        f"[admin-upload] saved {path} ({size / 1024**3:.2f} GB"
        f"{f', resumed from {start_offset / 1024**3:.2f} GB' if start_offset else ''})",
        flush=True,
    )
    return {"ok": True, "path": path, "size_bytes": size}


@app.function(
    image=dispatch_image,
    # read-only: reads Volume files, writes the ZIP only to /tmp (not the Volume)
    volumes={MODELS_DIR: vol_ro},
    timeout=3600,
    scaledown_window=2,
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


@app.function(
    image=dispatch_image,
    # read-only: resolves + streams job artifacts, builds any on-demand ZIP in
    # /tmp — never writes the Volume.
    volumes={MODELS_DIR: vol_ro},
    timeout=3600,
    scaledown_window=2,
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
    scaledown_window=2,
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
    scaledown_window=2,
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
    #
    # 2026-09-21: sd-scripts ワーカー（modal_sdxl_lora_worker.py、arch="sdxl"）の
    # 出力ツリーも見るようにした。あちらは同じ Volume の別ルート
    # （/models/outputs_sdxl/<key>）に書くので、ここを足さないと SDXL ジョブの
    # salvage が常に空振りしていた。キーの作り方はあちらの _job_output_dir と
    # 同じ（英数と ._- 以外を _ に、120文字で切る）。
    search_roots: list[pathlib.Path] = []
    for key in (call_id, job_id, lora_name):
        if not key:
            continue
        safe_key = re.sub(r"[^A-Za-z0-9._-]", "_", str(key)).strip("_")[:120] or "job"
        for root in (
            pathlib.Path(_job_output_dir(key)),
            pathlib.Path(f"{MODELS_DIR}/outputs_sdxl/{safe_key}"),
        ):
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


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol},
    schedule=modal.Period(days=1),
    timeout=600,
    scaledown_window=2,
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
            # Cross-worker: modal_angle_worker.py (Multi-Angle Studio) shares this
            # same Volume / HF cache. Its Qwen-Image-Edit-2511 base + fal
            # Multi-Angle LoRA are NOT in this worker's TARGET_MODELS, so without
            # listing them here the generic purge below would delete them and
            # force a ~54GB re-download on the angle worker's next cold start.
            "Qwen/Qwen-Image-Edit-2511",
            "fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA",
        }
    )
    return {_hf_cache_slug(r) for r in repos if r and "/" in r}


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol},
    timeout=1800,
    secrets=[modal.Secret.from_name("huggingface-secret")],
    scaledown_window=2,
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
    ONLY that preset used (mistralai/Mistral-Small-3.1-24B-Instruct-2503).
    FLUX.2-dev is now REMOVED from TARGET_MODELS (non-commercial licence,
    blocked by _is_blocked_model), so both slugs already leave the keep-set and
    the generic pass drops them — this flag is now just a redundant explicit
    path. The shared ai-toolkit/flux2_vae is left intact (flux2_klein_4b still
    needs it). There is no longer any way to re-pull FLUX.2-dev.

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


@app.function(
    image=dispatch_image,
    volumes={MODELS_DIR: vol},
    timeout=1800,
    scaledown_window=2,
)
def admin_volume_inventory(depth: int = 2, top: int = 30) -> dict:
    """Volume の **inode 数**（ファイル + ディレクトリ + シンボリックリンクの
    個数）と容量を、上位ディレクトリごとに数える。読むだけ・何も消さない。

        modal run modal_lora_worker.py::admin_volume_inventory
        modal run modal_lora_worker.py::admin_volume_inventory --depth 3 --top 50

    なぜ GB ではなく個数を見るのか（2026-09-20 調査）: Modal Volume は容量に
    上限が無く 1TiB/月まで無料（超過 $0.09/GiB/月）だが、**v1 は inode に上限が
    ある** — 推奨 5万・ハード 50万。超えると attach / 変更のレイテンシが
    ファイル数に線形で伸び、最終的に容量が空いていても ENOSPC になる。
    このワーカーの場合、容量の主役（1.2GB のチェックポイント）は inode では
    1個でしかなく、**軽いファイル（latent キャッシュ・ingest WebP・キャプション
    .txt・HF キャッシュの blob/symlink）の方が個数を食う**という逆転が起きる。
    削除や save_every の刻みを判断する前に、まずこの数字を見ること。

    シンボリックリンクは辿らずに1個として数える（Modal が数えるのと同じ基準。
    HF キャッシュは blobs の実体 + snapshots のリンクで二重に inode を使う）。
    容量の方は同じ inode を重複計上しない（ハードリンク対策）。
    """
    import os

    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[inventory] vol.reload skipped: {exc}", flush=True)

    GB = 1024**3
    root = MODELS_DIR.rstrip("/")
    depth = max(1, min(int(depth), 6))

    buckets: dict[str, dict] = {}
    seen_size_keys: set[tuple[int, int]] = set()
    total_inodes = 0
    total_bytes = 0

    def _bucket_for(path: str) -> str:
        rel = path[len(root) :].replace(os.sep, "/").strip("/")
        if not rel:
            return "/"
        return "/".join(rel.split("/")[:depth])

    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        key = _bucket_for(dirpath)
        b = buckets.setdefault(key, {"path": key, "inodes": 0, "bytes": 0, "dirs": 0, "links": 0})
        # このディレクトリ自身も1 inode（root は数えない）。
        if dirpath != root:
            b["inodes"] += 1
            b["dirs"] += 1
            total_inodes += 1
        # 大きいディレクトリで O(n^2) にならないよう set で判定する。
        dirname_set = set(dirnames)
        for name in filenames + dirnames:
            full = os.path.join(dirpath, name)
            if name in dirname_set and not os.path.islink(full):
                continue  # ディレクトリ本体は os.walk が降りてきたときに数える
            b["inodes"] += 1
            total_inodes += 1
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if os.path.islink(full):
                b["links"] += 1
                continue
            ino_key = (st.st_dev, st.st_ino)
            if st.st_ino and ino_key in seen_size_keys:
                continue
            if st.st_ino:
                seen_size_keys.add(ino_key)
            b["bytes"] += st.st_size
            total_bytes += st.st_size

    rows = sorted(buckets.values(), key=lambda r: r["inodes"], reverse=True)[: max(1, int(top))]
    print(f"[inventory] {root} — inodes={total_inodes:,} / used={total_bytes / GB:.1f} GB", flush=True)
    print(f"[inventory] v1 の目安: 推奨 50,000 / ハード 500,000 inode", flush=True)
    pct = total_inodes / 50_000 * 100
    print(f"[inventory] 推奨上限に対して {pct:.1f}%", flush=True)
    print(f"[inventory] {'path':<48} {'inodes':>10} {'GB':>9} {'dirs':>8} {'links':>8}", flush=True)
    for r in rows:
        print(
            f"[inventory] {r['path'][:48]:<48} {r['inodes']:>10,} "
            f"{r['bytes'] / GB:>9.2f} {r['dirs']:>8,} {r['links']:>8,}",
            flush=True,
        )
    return {
        "ok": True,
        "total_inodes": total_inodes,
        "used_gb": round(total_bytes / GB, 2),
        "pct_of_recommended": round(pct, 1),
        "recommended_limit": 50_000,
        "hard_limit": 500_000,
        "rows": rows,
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
    alpha: int = 16,
    learning_rate: float = 1e-4,
    optimizer: str = "prodigy",
    resolution: int = 768,
    caption: str = "",
    compile: str = "",
):
    """modal run modal_lora_worker.py --data-dir <dir> --lora-name <name>

    ベンチ用オプション:
      --caption "<txt>"  全画像に同じキャプションを付け、27B VLM 段を丸ごとスキップ
      --compile on|off   torch.compile を明示 ON/OFF（既定は環境の LORA_COMPILE）
    """
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

    _tc: dict = {
        "rank": rank,
        "alpha": alpha,
        "learning_rate": learning_rate,
        "steps": steps,
        "optimizer": optimizer,
    }
    _c = compile.strip().lower()
    if _c in ("on", "1", "true", "yes"):
        _tc["compile"] = True
    elif _c in ("off", "0", "false", "no"):
        _tc["compile"] = False

    _payload: dict = {
        "images": images,
        "captions": [],
        "target_model": target_model,
        "custom_model_id": custom_model_id,
        "base_architecture": base_architecture,
        "resolution": resolution,
        "training_config": _tc,
        "output_lora_name": lora_name,
        "trigger_word": trigger_word,
        "job_id": "",
        "user_id": "",
        "credits_cost": 0,
    }
    if caption.strip():
        # 全画像に同一キャプション → custom_captions で 27B VLM 段をスキップ。
        _payload["custom_captions"] = [caption.strip()] * len(images)
        _payload["skip_captioning"] = True

    print(
        f"[main] {len(images)} images ({total / 1024**2:.1f} MB) -> Modal ({GPU_REQUEST}), "
        f"target={target_model}, steps={steps}, compile={_tc.get('compile', 'env-default')}, "
        f"caption={'fixed' if caption.strip() else 'auto(VLM)'}"
    )

    result = train_lora_job.remote(_payload)
    print(f"\n[main] ✅ {result['lora_path']} ({result['size_bytes'] / 1024**2:.1f} MB)")
    print(f"[main] {result['num_images']} images, {result['total_seconds']}s, trigger={result['trigger_word']}")
    for cap in result["sample_captions"]:
        print(f"       - {cap}")