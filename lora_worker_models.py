"""Base-model presence checks and Volume layout helpers (Qwen-Image, MiniMax H3, HF repo snapshots).

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
    HF_HUB_CACHE_DIR,
    MODELS_DIR,
    TARGET_MODELS,
    _hf_token,
)

# ai-toolkit's default UMT5 tokenizer/config repo (weights come from the comfy
# file above; this is just tokenizer.json / config.json, a few MB).
_WAN_TOKENIZER_REPO = "ai-toolkit/umt5_xxl_encoder"


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
    # Lightricks/LTX-2（2026-09-21 追加）: リポジトリ直下に同じ 19B の精度違いが
    # 6本ぶら下がっていて、合計 158.94GB が我々の構成では**一度も読まれない**。
    # 内訳と根拠は docs/gpu-benchmarks.md §14.8.3。
    #   ltx-2-19b-dev / -distilled (各40.31GB)、-dev-fp8 / -distilled-fp8 (各25.22GB)、
    #   -dev-fp4 (18.62GB)、-distilled-lora-384 (7.15GB)、
    #   spatial/temporal upscaler (1.17GB)、latent_upsampler/ (0.93GB)、デモ mp4
    #
    # 理由: ai-toolkit の LTX2Model.load_model() が単一ファイル（mono checkpoint）
    # 経路に入るのは name_or_path が ".safetensors" で終わるときだけ。我々の
    # TARGET_MODELS["ltx_video"] は {"unet": "Lightricks/LTX-2"}（リポジトリID）
    # なので、必ず Diffusers サブフォルダ（transformer/ text_encoder/ vae/
    # audio_vae/ connectors/ vocoder/ tokenizer/）側を読む。latent_upsampler は
    # ltx2.py 内に参照が1箇所も無い。
    #
    # ⚠️ ai-toolkit を上げたらこの前提を再確認すること（mono checkpoint を既定に
    # する変更が入ると、ここで除外したファイルが必要になる）。
    # `*` は fnmatch でパス区切りも食うので、サブフォルダ側を巻き込まないよう
    # 先頭を "ltx-2-" で固定している。
    "Lightricks/LTX-2": [
        "ltx-2-*.safetensors",
        "latent_upsampler/*",
        "*.mp4",
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
