"""
ULL Studio: 汎用一時アップロード（studio_uploads/）。

Director・Multi-Angle・超解像（画像/動画）・特化ワークフローの5経路が共有
していた Supabase Storage バケット "upscale-uploads"（src/lib/studioUploads.ts
の STUDIO_UPLOAD_BUCKET）を置き換える（2026-09-19導入、CLAUDE.md §1
「大容量バイナリはSupabaseを経由させずModal側で直接やり取りする」標準の
適用）。Supabase Freeプランの月間送信量5GB（DB/Storage/Realtime/Auth等の
合算）を消費しないよう、ブラウザ⇔Modal間で直接アップロード/配信する。

署名方式は modal_lora_worker.py::upload_user_lora / download_lora_checkpoint
と同じHMAC-SHA256（鍵: MODAL_AUTH_TOKEN、wan-animate-auth secret）。
Next.js側: src/lib/studioUploads.server.ts / studioUploads.ts。

このアプリはCPU専用（GPU不使用）— CLAUDE.md §1「GPUは本番の推論・学習
でのみ使う」の原則どおり、fastapi[standard]のみの軽量image。
"""

import hashlib
import hmac
import os
import pathlib
import re
import time

import fastapi
import modal

app = modal.App("ull-studio-uploads")

MODELS_DIR = "/models"
STUDIO_UPLOADS_SUBDIR = "studio_uploads"
# 超解像動画入力等、数百MB級を見込んだ上限（実測に基づく厳密な壁ではなく、
# 異常に巨大なペイロードを弾く安全弁。動画の実際の妥当性は各ワーカー側の
# duration/frame_count検証が担う）。
UPLOAD_MAX_BYTES = 1024 * 1024 * 1024  # 1GB

_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,160}$")

image = modal.Image.debian_slim(python_version="3.13").pip_install("fastapi[standard]")
vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)

# Modal Volume (NFS) は小さい書き込み/読み込みを大量に行うと実効速度が
# 数KB/秒まで落ち込む（CLAUDE.md §1実測）。4 MiB単位でバッファする。
_DL_CHUNK = 4 * 1024 * 1024


def _hmac_secret() -> str:
    return os.environ.get("MODAL_AUTH_TOKEN", "")


def _verify_token(user_id: str, filename: str, expires: str, sig: str) -> bool:
    """upload/download 共通の署名検証。Next.js側の発行は
    src/lib/studioUploads.server.ts::createStudioUploadTicket。"""
    secret = _hmac_secret()
    if not secret or not sig:
        return False
    try:
        if int(expires) < time.time():
            return False
    except ValueError:
        return False
    payload = f"studio-upload:{user_id}:{filename}:{expires}"
    expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


def _authorize_server(request: fastapi.Request) -> None:
    """delete専用 — ブラウザには公開せず、Next.jsサーバーだけが呼ぶ単純
    Bearer認証（MODAL_AUTH_TOKENをそのまま渡す。サーバー間通信のみ）。"""
    secret = _hmac_secret()
    auth = request.headers.get("authorization", "")
    if not secret or auth != f"Bearer {secret}":
        raise fastapi.HTTPException(status_code=403, detail="unauthorized")


@app.function(
    image=image,
    volumes={MODELS_DIR: vol},
    timeout=600,
    scaledown_window=2,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="POST")
async def upload(user_id: str, filename: str, expires: str, sig: str, request: fastapi.Request):
    """ブラウザから直接呼ばれる。Next.jsが発行した署名付きチケットで認証。"""
    if not _verify_token(user_id, filename, expires, sig):
        raise fastapi.HTTPException(status_code=403, detail="invalid or expired upload link")
    if not (_UUID_RE.match(user_id) and _FILENAME_RE.match(filename)):
        raise fastapi.HTTPException(status_code=400, detail="invalid parameters")

    dest_dir = pathlib.Path(MODELS_DIR) / STUDIO_UPLOADS_SUBDIR / user_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / filename

    size = 0
    try:
        with open(dest_path, "wb", buffering=_DL_CHUNK) as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > UPLOAD_MAX_BYTES:
                    dest_path.unlink(missing_ok=True)
                    raise fastapi.HTTPException(status_code=413, detail="file too large (max 1GB)")
                f.write(chunk)
    except fastapi.HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        dest_path.unlink(missing_ok=True)
        raise fastapi.HTTPException(status_code=500, detail=f"upload failed: {exc}") from exc

    vol.commit()
    rel_path = f"{STUDIO_UPLOADS_SUBDIR}/{user_id}/{filename}"
    print(f"[studio-upload] saved {rel_path} ({size / 1024**2:.1f} MB)", flush=True)
    return {"ok": True, "path": rel_path, "size_bytes": size}


@app.function(
    image=image,
    # 読み取り専用: 配信専用エンドポイントなので RW マウントは不要
    # （download_lora_checkpoint と同じ考え方）。
    volumes={MODELS_DIR: vol},
    timeout=600,
    scaledown_window=2,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="GET")
def download(user_id: str, filename: str, expires: str, sig: str):
    """署名付きURL。2通りの用途で使う:
    (a) Next.js サーバーが自分で fetch してバイト列を取得する
        (studioUploads.server.ts::downloadStudioUpload)
    (b) 生成先Modal worker（例: modal_seedvr2_worker.py::_load_input_bytes）
        が image_url/video_url としてそのままfetchする
    """
    if not _verify_token(user_id, filename, expires, sig):
        raise fastapi.HTTPException(status_code=403, detail="invalid or expired download link")
    if not (_UUID_RE.match(user_id) and _FILENAME_RE.match(filename)):
        raise fastapi.HTTPException(status_code=400, detail="invalid parameters")
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[studio-upload-download] vol.reload() skipped: {exc}", flush=True)
    file_path = pathlib.Path(MODELS_DIR) / STUDIO_UPLOADS_SUBDIR / user_id / filename
    if not file_path.is_file():
        raise fastapi.HTTPException(status_code=404, detail="not found")

    def _iter():
        with open(file_path, "rb", buffering=_DL_CHUNK) as fh:
            while True:
                chunk = fh.read(_DL_CHUNK)
                if not chunk:
                    break
                yield chunk

    return fastapi.responses.StreamingResponse(
        _iter(),
        media_type="application/octet-stream",
        headers={"Content-Length": str(file_path.stat().st_size)},
    )


@app.function(
    image=image,
    volumes={MODELS_DIR: vol},
    timeout=60,
    scaledown_window=2,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="POST")
def delete(item: dict, request: fastapi.Request):
    """後片付け用（ジョブdispatch後のfire-and-forget削除）。ブラウザには
    公開せず、Next.jsサーバー間だけが呼ぶ。"""
    _authorize_server(request)
    paths = item.get("paths") or []
    removed = 0
    for rel in paths:
        rel = str(rel or "").strip().lstrip("/")
        if not rel.startswith(f"{STUDIO_UPLOADS_SUBDIR}/") or ".." in rel:
            continue
        p = pathlib.Path(MODELS_DIR) / rel
        try:
            if p.is_file():
                p.unlink()
                removed += 1
        except OSError as exc:
            print(f"[studio-upload-delete] failed {rel}: {exc}", flush=True)
    if removed:
        try:
            vol.commit()
        except Exception as exc:  # noqa: BLE001
            print(f"[studio-upload-delete] vol.commit skipped: {exc}", flush=True)
    return {"ok": True, "removed": removed}
