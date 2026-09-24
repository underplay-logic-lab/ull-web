"""Helpers for the web endpoints: HMAC token checks, dataset-upload I/O, streaming downloads, admin Volume utilities.

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
    MODELS_DIR,
)

# Physically cancels a spawned training FunctionCall so a pending-timeout
# refund never leaves a zombie job on Modal's queue. Best-effort — a call
# that's already done / gone / invalid just reports cancelled:false.
# Accepts either {"call_id": ...} or {"modal_call_id": ...}. Tiny image;
# no longer kept warm (min_containers removed — 2秒即切り, CLAUDE.md §1)
# so a cold call may add a second or two before it answers.
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


def _verify_upload_token(user_id: str, filename: str, expires: str, sig: str) -> bool:
    """_verify_download_token と同じHMAC方式（方向が逆＝アップロード用）。
    Next.js側の署名は src/app/api/director/loras/upload-token/route.ts。"""
    secret = os.environ.get("MODAL_AUTH_TOKEN", "")
    if not secret or not sig:
        return False
    try:
        if int(expires) < time.time():
            return False
    except ValueError:
        return False
    payload = f"upload:{user_id}:{filename}:{expires}"
    expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


# ULL Cinematic Director: ユーザーが外部で用意したLoRA(.safetensors)を
# Supabase Storageを一切経由せず直接Volumeへアップロードする（2026-09-18
# 導入）。Supabaseの Free プラン グローバルアップロード上限（プロジェクト
# 全体で50MB固定・Storageのバケット単位file_size_limitとは別物で引き上げ
# 不可）が実運用サイズのLoRA（rank32のminimax_h3で約1.18GB、
# download_lora_checkpointのコメント参照）を弾いてしまうため、Storageを
# 完全に迂回する設計にした。副次効果として、Supabaseの月間転送量
# （データベース/Storage/Realtime/Auth等を横断した合算クォータ）も一切
# 消費しない——Director側の外部LoRA機能がSupabase側の帯域を圧迫しない。
_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024  # 2GB
DIRECTOR_USER_LORA_SUBDIR = "director_user_loras"


# ULL LoRA Studio: 学習用データセット画像の直アップロード（2026-09-19導入）。
# Supabase Storage バケット "lora_datasets" を廃止し、ここへ移行した
# （CLAUDE.md §1標準）。既存の Smart Ingest Engine（ingest_and_optimize_
# dataset_cpu、_derive_dataset_id）は "<user_id>/<dataset_id>/<file>" という
# パス形さえ保たれていれば無改修で動くため、Supabase の bucket+key を
# Volume の相対パスに置き換えるだけで済む——キャプション永続キャッシュの
# dataset_id キー付けなど、デリケートな不変条件には一切触れていない。
#
# 1データセットあたり最大500枚（MAX_IMAGES、/api/studio/lora/train/route.ts
# と同じ値）を1枚ずつPOSTするため、upload_user_loraのようなファイル名ごとの
# 署名ではなく、dataset_id 単位でまとめて署名する（Next.jsへの往復を1回に
# 抑える）。filename 自体は署名対象に含めないが、正規表現で安全な文字と
# 画像拡張子のみに制限しているため、user_id/dataset_id 配下から出られない。
LORA_DATASET_UPLOADS_SUBDIR = "lora_dataset_uploads"
LORA_DATASET_UPLOADS_DIR = f"{MODELS_DIR}/{LORA_DATASET_UPLOADS_SUBDIR}"
_DATASET_IMG_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,140}\.(?:png|jpe?g|webp)$", re.IGNORECASE)


def _verify_dataset_upload_token(user_id: str, dataset_id: str, expires: str, sig: str) -> bool:
    """署名は Next.js 側 src/lib/loraDatasetUpload.server.ts が発行する。"""
    secret = os.environ.get("MODAL_AUTH_TOKEN", "")
    if not secret or not sig:
        return False
    try:
        if int(expires) < time.time():
            return False
    except ValueError:
        return False
    payload = f"lora-dataset-upload:{user_id}:{dataset_id}:{expires}"
    expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)




def _read_lora_dataset_upload(key: str) -> bytes:
    """アップロード済みデータセット画像を読む（"<user_id>/<dataset_id>/
    <filename>"）。Smart Ingest（_one）と train_lora_job/train_sdxl_lora_job
    のフォールバック経路の両方が使う。

    2026-09-23: ブラウザは R2 へ直接 PUT する（docs/STATUS.md R2 計画 4）ので、
    Volume に無ければ R2 から読む。Volume 側は UPLOAD_STORE=volume で戻した
    ときと、切替前にアップロードされた分のため。"""
    if ".." in key:
        raise ValueError(f"illegal storage key: {key!r}")
    p = pathlib.Path(LORA_DATASET_UPLOADS_DIR) / key
    if p.is_file():
        return p.read_bytes()
    try:
        import ull_r2
    except ImportError:
        ull_r2 = None
    if ull_r2 is not None and ull_r2.r2_configured():
        try:
            # 2026-09-24: ユーザー別の配置（<email>_<id8>/lora_dataset_uploads/…）→ 旧配置の順に探す。
            return ull_r2.get_upload_bytes(LORA_DATASET_UPLOADS_SUBDIR, key)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"dataset upload not found on Volume or R2: {key} ({exc})") from exc
    raise RuntimeError(f"dataset upload not found on Volume: {key}")


def _delete_lora_dataset_uploads(keys: list) -> int:
    """ベストエフォート削除。Smart Ingestが最適化コピーをVolumeへ焼き
    終えた直後に呼ぶ——アップロード原本はもう不要（_purge_storage_objects
    のVolume版）。失敗してもジョブは止めない。R2 側も同じキーで消す
    （存在しないキーの削除は無害）。"""
    removed = 0
    clean = [str(k) for k in (keys or []) if k and ".." not in str(k)]
    for k in clean:
        p = pathlib.Path(LORA_DATASET_UPLOADS_DIR) / k
        try:
            if p.is_file():
                p.unlink()
                removed += 1
        except OSError:
            pass
    if clean:
        try:
            import ull_r2

            if ull_r2.r2_configured():
                removed += ull_r2.delete_keys(
                    kk for k in clean for kk in ull_r2.upload_keys(LORA_DATASET_UPLOADS_SUBDIR, k)
                )
        except Exception as exc:  # noqa: BLE001
            print(f"[dataset-upload] R2 delete skipped: {exc}", flush=True)
    return removed


# 1リクエストで受ける枚数と総バイトの上限。ブラウザ側（src/lib/loraApi.ts の
# UPLOAD_BATCH_SIZE）は10枚で送るので、32は再送や将来の引き上げ込みの安全弁。
_DATASET_BATCH_MAX_FILES = 32
_DATASET_BATCH_MAX_BYTES = 256 * 1024 * 1024


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


# --- admin: ローカルPC -> Volume の直アップロード（2026-09-21追加）-----------
# それまで admin からモデルを持ち込む手段が「HuggingFace / Civitai の URL を
# 入れて Modal 側に落とさせる」リモートダウンローダしか無く、**手元の
# .safetensors（Civitai に無いマージモデル等）を送り込めなかった**
# （ホスト指摘）。
#
# 設計は upload_user_lora（Director の外部LoRA）と同じ:
#   * ブラウザ -> Modal 直（CLAUDE.md §1。Vercel のボディ上限 4.5MB を避ける）
#   * MODAL_AUTH_TOKEN はブラウザに渡さず、Next.js が短命の HMAC 署名を発行
#   * offset 指定で**途中から再開できる**（7GB 級を送る前提。タブのスリープや
#     回線断でゼロからやり直しにならないように）
#   * 4 MiB バッファ書き込み（Volume は小さい書き込みを大量に投げると実効
#     数KB/秒まで落ちる）
# 保存先は _ADMIN_UPLOAD_DIRS のホワイトリストに限定する。任意パスを開けると
# custom_nodes や training/hf_cache を上書きできてしまうため。
_ADMIN_UPLOAD_DIRS = (
    "diffusion_models",
    "checkpoints",
    "text_encoders",
    "clip",
    "clip_vision",
    "vae",
    "loras",
    "upscale_models",
)
_ADMIN_UPLOAD_NAME_RE = re.compile(
    r"^[A-Za-z0-9._-]{1,180}\.(?:safetensors|ckpt|pt|pth|bin|gguf)$"
)
# 単一ファイルの上限。SDXL のフルチェックポイントが約7GB、H3 系の DiT が
# 20〜40GB なので、そのあたりまでは通す。
_ADMIN_UPLOAD_MAX_BYTES = 64 * 1024 * 1024 * 1024  # 64GB


def _admin_upload_dest(path: str) -> pathlib.Path:
    """"<subdir>/<filename>" を検証して絶対パスへ。ホワイトリスト外の
    ディレクトリ、危険なファイル名、traversal はすべて 400。"""
    rel = str(path or "").strip().strip("/")
    parts = rel.split("/")
    if len(parts) != 2:
        raise fastapi.HTTPException(
            status_code=400, detail="path must be '<subdir>/<filename>'"
        )
    subdir, filename = parts
    if subdir not in _ADMIN_UPLOAD_DIRS:
        raise fastapi.HTTPException(
            status_code=400, detail=f"subdir must be one of {list(_ADMIN_UPLOAD_DIRS)}"
        )
    if not _ADMIN_UPLOAD_NAME_RE.match(filename):
        raise fastapi.HTTPException(status_code=400, detail="invalid filename")
    return _safe_volume_path(f"{subdir}/{filename}")


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
