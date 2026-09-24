"""Stage 1/2 helpers for train_lora_job: captioning, ai-toolkit config/YAML, the progress-watching runner, runtime patches, checkpoint collection, dataset/ingest/latent-cache keys.

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

from lora_worker_core import (  # noqa: F401
    AI_TOOLKIT_DIR,
    CAPTION_INSTRUCTION,
    COMPILE_LOW_VALUE_ARCHES,
    COMPILE_UNSUPPORTED_ARCHES,
    DATASET_DIR,
    DEFAULT_TRAINING_CONFIG,
    LORA_BLOCK_COMPILE,
    LORA_CKPT_IO_GRACE_S,
    LORA_COMPILE_ENABLED,
    LORA_COST_MIN_STEP,
    LORA_GRADIENT_CHECKPOINTING,
    LORA_OUTPUT_DIR,
    LORA_PREP_SILENCE_S,
    LORA_SAFETY_LIMIT_S,
    MODELS_DIR,
    OUTPUT_DIR,
    PERSIST_OUTPUT_ROOT,
    PERSIST_ROOT,
    SafetyLimitError,
    TARGET_MODELS,
    VLM_PATH,
    _LORA_SAMPLING_ON,
    _RUNTIME_QUANT_SHIM,
    _RUN_METRICS,
    _current_effective_vram_gb,
    _effective_batch,
    _is_blocked_model,
    _patch_job,
    _sanitize_caption,
    _track_vram_peak,
    vol,
)

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
    dataset_groups: "list | None" = None,
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
        safe_model = _cloud_safe_model_block(
            user_model, target_model, custom_model_id, base_architecture
        )
        # 実効バッチ（batch_size × grad_accum）。生 YAML だけがこれを 1 以外に
        # できる（GUI モードの _build_config は両方 1 固定）。
        _user_train = proc.get("train") if isinstance(proc.get("train"), dict) else {}
        _eff_batch = _effective_batch(_user_train)

        # gradient_checkpointing（2026-09-20 ホスト判断）:
        #   - YAML が明示していればその値を尊重する。明示するのは OOM 回避の
        #     ときだけのはずで、こちらが潰すと学習そのものが落ちる。
        #   - 未指定なら GUI モードと同じ既定（LORA_GRADIENT_CHECKPOINTING、
        #     既定 False）へ揃える。生 YAML はローカル GPU 前提で書かれている
        #     ことが多く、既定OFFの変更がこの経路だけ素通りしていた。
        # VRAM に余裕がある環境で true のままだと 20〜40% 遅くなり、その分が
        # そのまま原価に乗る（docs/gpu-benchmarks.md §14.13 の本番フルランは
        # これに該当し、5.24 s/it・2000step で約3時間10分かかった）。
        if isinstance(proc.get("train"), dict):
            _yaml_gc = proc["train"].get("gradient_checkpointing")
            if _yaml_gc is None:
                proc["train"]["gradient_checkpointing"] = LORA_GRADIENT_CHECKPOINTING
                print(
                    "[stage2][sanitize] gradient_checkpointing 未指定 -> "
                    f"{LORA_GRADIENT_CHECKPOINTING}（既定）",
                    flush=True,
                )
            elif bool(_yaml_gc):
                print(
                    "[stage2][warn] gradient_checkpointing: true が YAML で明示されて "
                    "います。VRAM が不足していないなら外した方が 20〜40% 速く、"
                    "消費クレジットも下がります（OOM が出る場合だけ有効化を推奨）。",
                    flush=True,
                )
        _yaml_arch = str(safe_model.get("arch") or "").strip()
        if (
            LORA_COMPILE_ENABLED
            and user_model.get("compile") is None
            and _yaml_arch in COMPILE_UNSUPPORTED_ARCHES
        ):
            # GUI モード（_build_config）と同じ既知の非対応 arch ガード。生 YAML
            # 側には入っていなかった。TORCHDYNAMO_SUPPRESS_ERRORS で eager へ
            # 落ちるので致命ではないが、落ちると分かっているコンパイルに数分
            # 払う理由が無い。
            print(
                f"[stage2] torch.compile skipped: arch={_yaml_arch} は既知の "
                "Inductor 非対応（COMPILE_UNSUPPORTED_ARCHES 参照）",
                flush=True,
            )
        elif (
            LORA_COMPILE_ENABLED
            and user_model.get("compile") is None
            and _yaml_arch in COMPILE_LOW_VALUE_ARCHES
        ):
            # warmup を回収できない arch（COMPILE_LOW_VALUE_ARCHES 参照）。
            print(
                f"[stage2] torch.compile skipped: arch={_yaml_arch} は warmup を "
                "回収できない（利得4.6%に対し回収に1,570step 以上。docs §14.8.2）。"
                "YAML に model.compile: true を明示すれば有効化できる",
                flush=True,
            )
        elif LORA_COMPILE_ENABLED and _eff_batch > 1 and user_model.get("compile") is None:
            # 2026-09-20 実測（docs/gpu-benchmarks.md §14.8）: 実効バッチ>1 で
            # compile を有効にすると **学習の途中で再コンパイルが走り、step 6 で
            # 8分以上ログ無しで停止した**。compile_dynamic=True でも shape 変化を
            # 吸収しきれていない。ユーザーからは「固まった」ようにしか見えず、
            # しかも課金は推定GPU秒ベースなので見積もりからも外れる。
            # 実効バッチ1では再現しないため、バッチを上げた生 YAML のときだけ
            # 既定を eager に倒す（YAML が compile を明示していればそれを尊重）。
            print(
                f"[stage2] torch.compile skipped: effective_batch={_eff_batch} "
                "（>1 では学習途中の再コンパイルで数分止まる実測があるため eager で回す。"
                "YAML に model.compile: true を明示すれば有効化できる）",
                flush=True,
            )
        elif LORA_COMPILE_ENABLED:
            # torch.compile 標準（CLAUDE.md §1）。生 YAML が明示的に compile を
            # 指定していればそれを尊重し、未指定のときだけ有効化する。
            safe_model.setdefault("compile", bool(user_model.get("compile", True)))
            safe_model.setdefault("compile_dynamic", bool(user_model.get("compile_dynamic", True)))
            # _cloud_safe_model_block() は arch=minimax_h3 のとき model ブロックを
            # ゼロから作り直すため、YAML の compile 系オプションは compile /
            # compile_dynamic 以外すべて落ちていた。とくに `block_compile: true`
            # を書いても無言で無視され whole-model compile のままになる
            # （= docs §14.8 の「再コンパイル1回 ≒ 8分」を回避できない）。
            # ai-toolkit `ModelConfig` に実在するキーだけ通す。
            for _ck in ("block_compile", "compile_mode", "compile_fullgraph", "cache_size_limit"):
                if user_model.get(_ck) is not None:
                    safe_model.setdefault(_ck, user_model[_ck])
            # 未指定なら GUI モードと同じ既定（LORA_BLOCK_COMPILE、既定 ON）。
            if "block_compile" not in safe_model:
                safe_model["block_compile"] = LORA_BLOCK_COMPILE
            # CLAUDE.md §1: mode="reduce-overhead"（CUDA Graphs）は禁止。
            if str(safe_model.get("compile_mode") or "").strip() == "reduce-overhead":
                print(
                    "[stage2][sanitize] compile_mode: reduce-overhead は禁止"
                    "（CLAUDE.md §1）-> default へ落とす",
                    flush=True,
                )
                safe_model["compile_mode"] = "default"
            if safe_model.get("block_compile"):
                print(
                    "[stage2] torch.compile: block_compile 有効 — ブロック単位で "
                    "コンパイルする（shape/分岐が変わったときの再コンパイルが "
                    "DiT 全体ではなく1ブロック分で済む。docs §14.8）",
                    flush=True,
                )
        proc["model"] = safe_model

        datasets = proc.get("datasets")
        if isinstance(datasets, list) and datasets and isinstance(datasets[0], dict):
            base_ds = datasets[0]
            if dataset_groups and len(dataset_groups) > 1:
                # 画像ごとの学習回数が指定されている場合は、YAML が書いた
                # dataset 設定をテンプレートとして倍率ぶん複製する。
                proc["datasets"] = [
                    {**base_ds, "folder_path": folder, "num_repeats": n}
                    for n, folder in dataset_groups
                ]
            else:
                base_ds["folder_path"] = DATASET_DIR
        else:
            _tmpl = {
                "folder_path": DATASET_DIR,
                "caption_ext": "txt",
                "cache_latents_to_disk": True,
                "resolution": [768],
            }
            proc["datasets"] = (
                [{**_tmpl, "folder_path": folder, "num_repeats": n} for n, folder in dataset_groups]
                if dataset_groups and len(dataset_groups) > 1
                else [_tmpl]
            )

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


# 画像ごとの学習回数（kohya のフォルダ名 "10_name" 相当）の上限。
# modal_sdxl_lora_worker.py の MAX_IMAGE_REPEATS と同じ値に保つこと。
MAX_IMAGE_REPEATS = 50


def _normalize_repeats(params: dict, count: int) -> list[int]:
    """payload の `repeats`（storage_paths と同じ並び）を検証する。
    未指定・長さ不一致の要素は 1（重み付けなし）。"""
    raw = params.get("repeats") or []
    out: list[int] = []
    for i in range(count):
        v = raw[i] if isinstance(raw, list) and i < len(raw) else 1
        try:
            n = int(v)
        except (TypeError, ValueError):
            n = 1
        out.append(max(1, min(MAX_IMAGE_REPEATS, n)))
    return out


def _group_dataset_by_repeats(image_paths: list, repeats: list) -> list:
    """DATASET_DIR 直下の画像を学習回数ごとのサブフォルダへ移し、
    [(num_repeats, folder_path), ...] を返す（2026-09-21追加）。

    ai-toolkit の `DatasetConfig` は **dataset エントリごとに `num_repeats`**
    を持つ（toolkit/config_modules.py の DatasetConfig.num_repeats、既定1）。
    したがって倍率ごとに folder_path を分けて datasets を複数並べればよい。
    kohya のフォルダ名規約（"10_name"）と同じことを config 側で表現する形。

    ⚠️ 課金には影響しない。総ステップ数は `train.steps` で固定で、num_repeats
    が変えるのは構成比だけ。
    ⚠️ 副作用: 画像のパスが変わるので **latent キャッシュは作り直しになる**
    （キャッシュはファイルパス基準）。重み付けを使わないジョブは従来どおり
    フラットなままなので影響を受けない。
    """
    groups: dict = {}
    for path, n in zip(image_paths, repeats):
        groups.setdefault(n, []).append(path)
    if len(groups) <= 1:
        return [(next(iter(groups), 1), DATASET_DIR)]

    out: list = []
    for n in sorted(groups):
        sub = pathlib.Path(DATASET_DIR) / f"r{n:02d}"
        sub.mkdir(parents=True, exist_ok=True)
        for path in groups[n]:
            txt = path.with_suffix(".txt")
            shutil.move(str(path), str(sub / path.name))
            if txt.is_file():
                shutil.move(str(txt), str(sub / txt.name))
        out.append((n, str(sub)))
        print(f"[train] repeats x{n}: {len(groups[n])} 枚 -> {sub}", flush=True)
    return out


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
    dataset_groups: "list | None" = None,
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
        # dataset_groups は 2026-09-21 の学習回数実装で本文だけ参照して引数に無く、
        # 生 YAML のジョブが NameError で落ちていた（2026-09-24 発見）。
        sanitized = _sanitize_override_yaml(
            override, lora_name, target_model, custom_model_id, base_architecture, output_dir, trigger,
            dataset_groups=dataset_groups,
        )
        config_path.write_text(sanitized, encoding="utf-8")
        print(f"[stage2] wrote sanitized custom_yaml_override -> {config_path}")
        return config_path

    if target_model == "custom":
        if not custom_model_id or not base_architecture:
            raise ValueError("target_model='custom' requires custom_model_id and base_architecture")
        if _is_blocked_model(custom_model_id):
            raise ValueError("FLUX.1 [dev] / FLUX.2 [klein] 9B is blocked (non-commercial licence)")
        path = custom_model_id
        # A bare filename resolves against the Volume; an "owner/name" HF repo
        # id, an absolute path, or a URL is passed through untouched.
        if "/" not in path and not path.startswith("http"):
            path = f"{MODELS_DIR}/{path}"
        target = {"arch": base_architecture, "unet": path}
        print(f"[stage2] universal loader: arch={base_architecture} model={path}")
    else:
        if _is_blocked_model(target_model):
            raise ValueError("FLUX.1 [dev] / FLUX.2 [klein] 9B is blocked (non-commercial licence)")
        target = TARGET_MODELS.get(target_model)
        if not target:
            raise ValueError(
                f"unknown target_model {target_model!r} and no custom_yaml_override — "
                f"known: {', '.join(TARGET_MODELS)}, or use target_model='custom'"
            )

    rank = int(tc.get("rank", DEFAULT_TRAINING_CONFIG["rank"]))
    alpha = int(tc.get("alpha", DEFAULT_TRAINING_CONFIG["alpha"]))
    steps = int(tc.get("steps", DEFAULT_TRAINING_CONFIG["steps"]))
    optimizer = str(tc.get("optimizer", DEFAULT_TRAINING_CONFIG["optimizer"]))
    if optimizer == "prodigy":
        # Prodigy is a learning-rate-FREE optimizer (D-adaptation): it estimates
        # its own step size from the training trajectory and treats the `lr`
        # argument purely as a multiplier on that estimate. The universal
        # convention (Prodigy's own README, and every trainer that wires it up —
        # Kohya-ss sd-scripts included) is to pass lr=1.0; an AdamW-scale value
        # (1e-5〜2e-4, which is what this app's LR dropdown/DEFAULT_TRAINING_
        # CONFIG historically meant) would cripple it to near-zero step size.
        # Force this regardless of what the caller sent (GUI mode's LR control
        # is AdamW-oriented and not wired to hide/adjust itself per optimizer
        # server-side is the one place that's guaranteed correct either way).
        lr = 1.0
    else:
        lr = float(tc.get("learning_rate", DEFAULT_TRAINING_CONFIG["learning_rate"]))
    # Intermediate checkpoints every 500 steps (or every 25% for short runs),
    # so the user can pick the least over-fit step afterward. Keep them all.
    save_every = min(250, max(100, steps // 4))
    # 2026-09-20: 刻みを 500 → 250 に細かくし、代わりに **保存回数を20回で頭打ち**
    # にする（ホスト判断「500は広すぎる。当たりがどこか分からないし、ベストが
    # 欲しくて刻みたい人はいる」）。ai-toolkit 側の max_step_saves_to_keep=20 と
    # 同じ数に揃えてある。
    #
    # 容量: rank64 MiniMax H3 は1個1.2GB なので最大 21個 ≒ 25GB/ジョブ。Modal の
    # Volume は 1TiB/月まで無料、超過分は $0.09/GiB/月 なので、14日保持だと
    # 最悪でも約 $0.84（¥125）/ジョブ。刻みを細かくする価値の方が大きいと判断した。
    # ⚠️ ただし Volume(v1) は **ファイル数** に上限がある（推奨5万・ハード50万
    # inode、超えると attach 遅延が線形に伸びる）。効いてくるならバイト数より先に
    # こちらなので、増やす方向に触るときはファイル数を確認すること。
    if steps > 5000:
        save_every = ((steps + 999) // 1000) * 50
    res = resolution if resolution in (512, 768, 1024) else 768

    # low_vram off — the Blackwell tiers (b300/b200) have the headroom to
    # keep everything resident at full speed instead of offloading.
    model_block = {"name_or_path": target["unet"], "arch": target["arch"], "quantize": False, "low_vram": False}
    # torch.compile: training_config.compile が明示指定（True/False）ならそれを
    # 最優先（ベンチ用 — 環境変数はコンテナ側で再評価されるため CLI から効かない）。
    # 未指定なら LORA_COMPILE_ENABLED（= LORA_DISABLE_COMPILE!=1、既定 ON）。
    _compile_explicit = tc.get("compile")
    _compile_on = bool(_compile_explicit) if _compile_explicit is not None else LORA_COMPILE_ENABLED
    # 既知の compile 非対応 arch は、明示指定が無ければ最初から compile しない。
    # 下の TORCHDYNAMO_SUPPRESS_ERRORS があれば eager へ落ちて学習自体は通るが、
    # 失敗すると分かっているコンパイルに数分の GPU 時間を捨てることになるため。
    if _compile_explicit is None and target["arch"] in COMPILE_UNSUPPORTED_ARCHES:
        print(
            f"[stage2] torch.compile skipped: arch={target['arch']} は既知の "
            f"Inductor 非対応（COMPILE_UNSUPPORTED_ARCHES 参照）",
            flush=True,
        )
        _compile_on = False
    # compile は通るが warmup を回収できない arch も、明示指定が無ければ eager。
    elif _compile_explicit is None and target["arch"] in COMPILE_LOW_VALUE_ARCHES:
        print(
            f"[stage2] torch.compile skipped: arch={target['arch']} は warmup を "
            f"回収できない（利得4.6%に対し回収に1,570step 以上。"
            f"COMPILE_LOW_VALUE_ARCHES / docs §14.8.2 参照）",
            flush=True,
        )
        _compile_on = False
    if _compile_on:
        # torch.compile 標準（CLAUDE.md §1）。compile_dynamic は ai-toolkit 既定
        # で true なので明示不要だが、意図を残すため書いておく。
        model_block["compile"] = True
        model_block["compile_dynamic"] = True
        # ブロック単位 compile（LORA_BLOCK_COMPILE、既定 ON）。速度は同等で、
        # shape / 分岐が変わったときの再コンパイル単価が桁で下がる（§14.8）。
        if LORA_BLOCK_COMPILE:
            model_block["block_compile"] = True
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
                    # 画像ごとの学習回数（kohya の "10_name" フォルダ相当）が
                    # 指定されていれば、倍率ごとに dataset を並べる
                    # （ai-toolkit の DatasetConfig.num_repeats）。
                    # 指定が無ければ従来どおり単一 dataset。
                    "datasets": [
                        {
                            "folder_path": folder,
                            "caption_ext": "txt",
                            "caption_dropout_rate": 0.05,
                            "shuffle_tokens": False,
                            "cache_latents_to_disk": True,
                            "resolution": [res],
                            **({"num_repeats": n} if n != 1 else {}),
                        }
                        for n, folder in (dataset_groups or [(1, DATASET_DIR)])
                    ],
                    "train": {
                        "batch_size": 1,
                        "steps": steps,
                        "gradient_accumulation_steps": 1,
                        "train_unet": True,
                        "train_text_encoder": False,
                        # 既定 False。LORA_GRADIENT_CHECKPOINTING のコメント参照。
                        "gradient_checkpointing": LORA_GRADIENT_CHECKPOINTING,
                        "noise_scheduler": "flowmatch",
                        "optimizer": optimizer,
                        "lr": lr,
                        "dtype": "bf16",
                        # 2026-09-20: サンプル生成を全面的に止めた（ホスト判断
                        # 「sample生成は不要。使ったことがない」）。
                        #
                        # 学習前のベースライン1枚と学習後の最終1枚が生成されて
                        # いたが、どちらもユーザーには渡らない中間生成物で、
                        # 実測（modal_lora_benchmark.py smoke, B300）では両方
                        # 合わせて1ジョブあたり10分以上・約¥200を消費していた。
                        # torch.compile 有効時はサンプルが学習と別 shape なので
                        # 専用のコンパイルまで余計に引いていたのが効いている。
                        #
                        # disable_sampling / skip_first_sample はこの ai-toolkit
                        # リビジョンの toolkit/config_modules.py に実在すること
                        # をソースで確認済み（2026-09-20）。存在しないキーを
                        # 渡すと全ジョブが落ちるので、変更する際は必ず同じ確認を
                        # してから。LORA_ENABLE_SAMPLING=1 で元に戻せる。
                        "disable_sampling": not _LORA_SAMPLING_ON,
                        "skip_first_sample": not _LORA_SAMPLING_ON,
                    },
                    "model": model_block,
                    "sample": {
                        "sampler": "flowmatch",
                        # サンプリングは上の disable_sampling で止めているので、
                        # このブロックは基本的に使われない。念のため
                        # sample_every も絶対に発火しない値にしておく
                        # （LORA_ENABLE_SAMPLING=1 で戻したときは、compile 有効
                        # なら最終1回だけ・eager なら save_every ごと）。
                        "sample_every": (
                            (steps if _compile_on else save_every)
                            if _LORA_SAMPLING_ON
                            else steps + 1
                        ),
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

    # image 側で TORCHDYNAMO_SUPPRESS_ERRORS=1 を焼いてあり（compile 失敗を
    # eager フォールバックにしてジョブを完走させる。CLAUDE.md §1）、それを
    # 一時的に外して原因を見たいときの逃げ道。デバッグ用なので既定は無効。
    if os.environ.get("LORA_COMPILE_STRICT", "").strip().lower() in ("1", "true", "yes"):
        child_env.pop("TORCHDYNAMO_SUPPRESS_ERRORS", None)
        print("[stage2] LORA_COMPILE_STRICT=1 — compile 失敗を握り潰さず落とす", flush=True)

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
    # 2026-09-14: 既定を無効化（85.5GBのbaked bf16 2点をVolumeから削除する判断と
    # セット）。1ジョブあたり+10分の逆量子化コストを毎回払う代わりに、baked
    # コピーを二度と作らない。ULL_H3_BAKE=1 で明示的に再度オプトインできる。
    if os.environ.get("ULL_H3_BAKE", "0") == "0":
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
# 2026-09-14: DiT側と同じ理由で既定を無効化（baked bf16版をVolumeから削除する
# 判断とセット）。ULL_H3_TE_BAKE=1 で明示的に再度オプトインできる。
_ULL_H3_TE_DISABLED = os.environ.get("ULL_H3_TE_BAKE", "0") == "0"


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
            meta["vram_peak_gb"] = _track_vram_peak(vram)
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
                    # 2026-09-21: 総ステップ数が config と一致するなら 100 未満でも
                    # 学習バーとして受ける。生YAML の短いラン（50step 等）が
                    # 学習として認識されず、進捗・prep 内訳・**s/it 予測による
                    # cost-guard 監視までまるごと無効**になっていた
                    # （GUI は route.ts が steps>=200 にクランプするので無影響）。
                    _is_train = (
                        m
                        and not cache_m
                        and (
                            int(m.group(2)) >= 100
                            or (total_steps and int(m.group(2)) == total_steps)
                        )
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
                                # 同じ数字を job 行にも残す（knob 校正用）。
                                _RUN_METRICS.update(
                                    {
                                        "prep_s": round(training_start - sub_start, 1),
                                        "model_load_s": (
                                            round(_load_s, 1) if _load_s is not None else None
                                        ),
                                        "latent_cache_s": round(_cache_s, 1),
                                        "jit_s": round(_jit_s, 1),
                                    }
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
        # steady-state の s/it を残す。cost-guard の予測に使っているのと同じ
        # trimmed 平均（外れ値＝チェックポイント保存やサンプル生成を落とす）。
        try:
            _spi_final = _trimmed_spi(rate_hist)
            if _spi_final and _spi_final > 0:
                _RUN_METRICS["s_per_it"] = round(float(_spi_final), 4)
            if state["step"] > 0:
                _RUN_METRICS["steps_observed"] = int(state["step"])
        except Exception as _mx:  # noqa: BLE001 — telemetry only, never fatal
            print(f"[perf] s/it の記録をスキップ: {_mx!r}", flush=True)

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


def _override_structure_error(override) -> "str | None":
    """Fast structural check of a raw ai-toolkit YAML override, mirroring
    collectLoraYamlStructureErrors() on the web side and the checks
    toolkit/config.py does before anything else. Returns a Japanese error
    string when the override can never load (missing `job` / `config` /
    `config.process`), else None. The Next.js route already blocks these
    before the credit debit — this is the last-line CPU-side guard so such a
    job never reaches the GPU (the "config file must have a job key"
    ValueError that used to burn a container start)."""
    if not override:
        return None
    try:
        import yaml

        data = override if isinstance(override, dict) else yaml.safe_load(override)
    except Exception:  # noqa: BLE001 — a syntax error is reported by _sanitize_override_yaml
        return None
    if not isinstance(data, dict):
        return "無効な YAML 設定です: 有効な設定オブジェクト（マッピング）ではありません。"
    job = data.get("job")
    if job is None or (isinstance(job, str) and not job.strip()):
        return "無効な YAML 設定です: ルートレベルに `job: extension` が必要です。"
    if not isinstance(job, str):
        return "無効な YAML 設定です: `job` は文字列で指定してください（通常は `job: extension`）。"
    config = data.get("config")
    if config is None:
        return "無効な YAML 設定です: ルートレベルに `config`（オブジェクト）が必要です。"
    if not isinstance(config, dict):
        return "無効な YAML 設定です: `config` はオブジェクト（マッピング）で指定してください。"
    process = config.get("process")
    if not isinstance(process, list) or len(process) == 0:
        return "無効な YAML 設定です: `config.process` の定義が見つかりません（1要素以上のリストが必要です）。"
    return None


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
# 2026-09-24: WEBP q95 -> PNG (lossless). Lossy WebP always subsamples chroma
# 4:2:0, which softens the colour of line-art edges and is baked into every
# epoch. The downscale is kept: ai-toolkit only does a single Pillow BICUBIC
# resize (antialiased), so 4K -> 1.5x -> bucket costs ~nothing in quality
# while the GPU side decodes far fewer pixels on the first run.
INGEST_FMT = "PNG"
INGEST_EXT = ".png"
INGEST_QUALITY = 95            # WEBP / JPEG only
INGEST_WEBP_METHOD = 6         # WEBP only
INGEST_PNG_COMPRESS = 1        # fast; size barely matters inside the Volume
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
    if INGEST_FMT == "PNG":
        return f"e{long_edge}_png_v{INGEST_VERSION}"
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
