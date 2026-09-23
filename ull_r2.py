"""Cloudflare R2 (S3 API) artifact store — shared by every Modal worker.

Why R2 (2026-09-23, docs/STATUS.md「R2 を成果物ストレージにする」):
  * Modal Volume `ull-wan-models` is at ~847GB / 1TB and should hold model
    weights only.
  * Streaming a checkpoint through a Modal web endpoint tops out at 3〜7 MB/s;
    a presigned R2 GET does 34〜46 MB/s single-stream, ~70 MB/s with 4 in
    parallel (docs/gpu-benchmarks.md §16.5).
  * Egress is free, storage is $0.015/GB-month, and the 14-day retention is a
    bucket lifecycle rule instead of a purge worker.

Key convention: `<kind>/<user_id>/<job_id>/<file>` — the same relative path
the Volume used (e.g. `loras/<user>/<job>/<name>_final.safetensors`), so a
`metadata.checkpoints[].path` and its `r2_key` read identically.

Credentials come from the Modal secret `r2-artifacts` (R2_ACCOUNT_ID /
R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET). Setting
ARTIFACT_STORE=volume in that secret rolls every worker back to the Volume
path without a redeploy (`r2_enabled()` returns False).

Upload tuning is fixed here on purpose: boto3's default TransferConfig gave
10〜17 MB/s Modal→R2; `multipart_chunksize=64MB, max_concurrency=16` gave
48〜53 MB/s (§16.5). Do not lower it.

Runtime deps: boto3 (any recent). Works on Python 3.11 and 3.13.
"""

from __future__ import annotations

import mimetypes
import os
import pathlib
import time
from typing import Iterable

R2_ENV_KEYS = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")

_MB = 1024 * 1024
_PART_SIZE = 64 * _MB
_CONCURRENCY = 16

_client = None


def artifact_store() -> str:
    """`r2` (default) or `volume`. Read at call time so a secret edit applies
    to the next container without a redeploy."""
    return (os.environ.get("ARTIFACT_STORE") or "r2").strip().lower()


def r2_configured() -> bool:
    return all(os.environ.get(k) for k in R2_ENV_KEYS)


def r2_enabled() -> bool:
    """True when artifacts should go to R2: store switch says so AND the
    credentials are present. Missing creds fail *open* to the Volume path
    (a job must never die because of the storage layer)."""
    return artifact_store() == "r2" and r2_configured()


def bucket() -> str:
    return os.environ["R2_BUCKET"]


def endpoint_url() -> str:
    return f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"


def client():
    """Cached boto3 S3 client pointed at R2. Import is lazy so modules that
    only *might* use R2 (dispatch images without boto3) still import."""
    global _client
    if _client is None:
        import boto3
        from botocore.config import Config

        _client = boto3.client(
            "s3",
            endpoint_url=endpoint_url(),
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                retries={"max_attempts": 5, "mode": "standard"},
                # 64MB parts × 16 threads need more than the default 10 sockets.
                max_pool_connections=_CONCURRENCY + 4,
            ),
        )
    return _client


def transfer_config():
    from boto3.s3.transfer import TransferConfig

    return TransferConfig(
        multipart_threshold=_PART_SIZE,
        multipart_chunksize=_PART_SIZE,
        max_concurrency=_CONCURRENCY,
        use_threads=True,
    )


def _content_type(name: str, explicit: str | None = None) -> str:
    if explicit:
        return explicit
    if name.endswith(".safetensors"):
        return "application/octet-stream"
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def put_file(local_path: str | pathlib.Path, key: str, content_type: str | None = None) -> dict:
    """Upload one file. Returns {key, size_bytes, elapsed_s, mb_s}.
    Raises on failure — callers decide whether to fail open."""
    p = pathlib.Path(local_path)
    size = p.stat().st_size
    t0 = time.time()
    client().upload_file(
        str(p),
        bucket(),
        key,
        ExtraArgs={"ContentType": _content_type(p.name, content_type)},
        Config=transfer_config(),
    )
    dt = max(time.time() - t0, 1e-6)
    return {"key": key, "size_bytes": size, "elapsed_s": round(dt, 2), "mb_s": round(size / _MB / dt, 1)}


def put_bytes(data: bytes, key: str, content_type: str | None = None) -> dict:
    t0 = time.time()
    client().put_object(
        Bucket=bucket(), Key=key, Body=data, ContentType=_content_type(key, content_type)
    )
    dt = max(time.time() - t0, 1e-6)
    return {"key": key, "size_bytes": len(data), "elapsed_s": round(dt, 2), "mb_s": round(len(data) / _MB / dt, 1)}


def get_bytes(key: str) -> bytes:
    return client().get_object(Bucket=bucket(), Key=key)["Body"].read()


def get_file(key: str, local_path: str | pathlib.Path) -> int:
    """Download one object to disk (multipart, same tuning). Returns bytes."""
    p = pathlib.Path(local_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    client().download_file(bucket(), key, str(p), Config=transfer_config())
    return p.stat().st_size


def head(key: str) -> int | None:
    """Object size in bytes, or None when it does not exist."""
    try:
        return int(client().head_object(Bucket=bucket(), Key=key)["ContentLength"])
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "response", {}).get("Error", {}).get("Code", "") if hasattr(exc, "response") else ""
        if code in ("404", "NoSuchKey", "NotFound"):
            return None
        raise


def presign_get(key: str, expires_s: int = 900, download_name: str | None = None) -> str:
    """Presigned GET. `download_name` forces Content-Disposition: attachment so
    a browser navigation downloads instead of rendering."""
    params: dict = {"Bucket": bucket(), "Key": key}
    if download_name:
        params["ResponseContentDisposition"] = f'attachment; filename="{download_name}"'
    return client().generate_presigned_url("get_object", Params=params, ExpiresIn=int(expires_s))


def list_keys(prefix: str) -> list[dict]:
    """[{key, size_bytes, last_modified}] under `prefix` (paginated)."""
    out: list[dict] = []
    paginator = client().get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket(), Prefix=prefix):
        for obj in page.get("Contents", []) or []:
            out.append(
                {
                    "key": obj["Key"],
                    "size_bytes": int(obj.get("Size", 0)),
                    "last_modified": obj["LastModified"].isoformat() if obj.get("LastModified") else None,
                }
            )
    return out


def delete_keys(keys: Iterable[str]) -> int:
    keys = [k for k in keys if k]
    n = 0
    for i in range(0, len(keys), 1000):
        chunk = keys[i : i + 1000]
        client().delete_objects(Bucket=bucket(), Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": True})
        n += len(chunk)
    return n


def delete_prefix(prefix: str) -> int:
    return delete_keys(o["key"] for o in list_keys(prefix))


# ---------------------------------------------------------------------------
# LoRA-style job folder publish
# ---------------------------------------------------------------------------
def publish_job_meta_from_volume(
    models_dir: str | pathlib.Path,
    kind: str,
    user_id: str,
    job_id: str,
    meta: dict,
    *,
    log=print,
) -> dict | None:
    """CPU-side publish driven by a generation_jobs row: every
    `meta.checkpoints[]` entry that has a Volume `path` but no `r2_key` yet is
    uploaded from `<models_dir>/<path>` (plus LICENSE.txt if present), and a
    NEW metadata dict with `r2_key`s / `artifact_store` / `r2_prefix` is
    returned for the caller to PATCH back. Returns None when nothing changed.

    Why CPU (2026-09-23): the first R2 job uploaded 2.4GB from the B300
    container at 2〜33 MB/s = 327s of idle GPU (~$0.65) — the same "GPU idle
    on I/O" class as the old checkpoints_all.zip. The GPU function now writes
    the row and returns; this runs on a $0.0x CPU container afterwards.
    Until it finishes, the Next.js routes fall back to the Modal/Volume path
    (files are still there), so the user never sees a gap.
    """
    checkpoints = list(meta.get("checkpoints") or [])
    todo = [c for c in checkpoints if c.get("path") and not c.get("r2_key")]
    job_dir = pathlib.Path(models_dir) / kind / user_id / job_id
    if not todo and not (job_dir / "LICENSE.txt").is_file():
        return None
    prefix = f"{kind}/{user_id}/{job_id}"
    stats = publish_job_dir(job_dir, todo, prefix, log=log)
    if not stats.get("uploaded") and not stats.get("extra_keys"):
        return None
    merged = dict(meta)
    merged["checkpoints"] = checkpoints  # entries were stamped in place
    merged["artifact_store"] = "r2"
    merged["r2_prefix"] = prefix
    if stats.get("extra_keys"):
        merged["r2_extra_keys"] = sorted(set(list(meta.get("r2_extra_keys") or []) + stats["extra_keys"]))
    merged["r2_publish"] = {
        "uploaded": stats["uploaded"],
        "failed": stats["failed"],
        "bytes": stats["bytes"],
        "elapsed_s": stats["elapsed_s"],
    }
    return merged


def publish_job_dir(
    job_dir: str | pathlib.Path,
    checkpoints: list[dict],
    key_prefix: str,
    *,
    extra_files: Iterable[str] = ("LICENSE.txt",),
    remove_local: bool = True,
    log=print,
) -> dict:
    """Upload every `checkpoints[i]` file (and `extra_files`) that exists in
    `job_dir` to `<key_prefix>/<filename>`, stamping `r2_key` / `store="r2"`
    on each entry in place. Files that uploaded (and size-verified) are
    unlinked locally when `remove_local`, so the Volume stops accumulating.

    Fail-open by design: an entry whose upload fails keeps its Volume `path`
    and gets no `r2_key`; the Next.js routes fall back to the Modal endpoint
    for exactly those files. Returns {uploaded, failed, skipped, extra_keys,
    bytes, elapsed_s}.
    """
    job_dir = pathlib.Path(job_dir)
    prefix = key_prefix.strip("/")
    stats = {"uploaded": 0, "failed": 0, "skipped": 0, "extra_keys": [], "bytes": 0, "elapsed_s": 0.0}
    if not r2_enabled():
        log(f"[r2] disabled (ARTIFACT_STORE={artifact_store()!r}, configured={r2_configured()}) — Volume only", flush=True)
        return stats

    t0 = time.time()

    def _one(local: pathlib.Path, key: str) -> bool:
        try:
            r = put_file(local, key)
            remote = head(key)
            if remote != local.stat().st_size:
                raise RuntimeError(f"size mismatch after upload: local={local.stat().st_size} remote={remote}")
            log(f"[r2] put {key} ({r['size_bytes'] / _MB:.1f} MB, {r['mb_s']} MB/s)", flush=True)
            stats["bytes"] += r["size_bytes"]
            if remove_local:
                try:
                    local.unlink()
                except Exception as rm_exc:  # noqa: BLE001
                    log(f"[r2] local unlink skipped ({local.name}): {rm_exc}", flush=True)
            return True
        except Exception as exc:  # noqa: BLE001 — never let storage kill a finished job
            log(f"[r2] put FAILED {key}: {exc!r} — keeping Volume copy", flush=True)
            return False

    for entry in checkpoints:
        fname = entry.get("filename")
        if not fname:
            stats["skipped"] += 1
            continue
        local = job_dir / fname
        if not local.is_file():
            stats["skipped"] += 1
            continue
        key = f"{prefix}/{fname}"
        if _one(local, key):
            entry["r2_key"] = key
            entry["store"] = "r2"
            stats["uploaded"] += 1
        else:
            stats["failed"] += 1

    for name in extra_files:
        local = job_dir / name
        if local.is_file():
            key = f"{prefix}/{name}"
            if _one(local, key):
                stats["extra_keys"].append(key)
            else:
                stats["failed"] += 1

    stats["elapsed_s"] = round(time.time() - t0, 1)
    mb = stats["bytes"] / _MB
    log(
        f"[r2] publish {prefix}: {stats['uploaded']} ok / {stats['failed']} failed / "
        f"{stats['skipped']} skipped, {mb:.0f} MB in {stats['elapsed_s']}s"
        + (f" ({mb / max(stats['elapsed_s'], 1e-6):.1f} MB/s)" if mb else ""),
        flush=True,
    )
    return stats


# ---------------------------------------------------------------------------
# Generated artifacts (migration plan step 3, 2026-09-23): 超解像 / Director /
# Multi-Angle / 特化ワークフロー. These rows keep a Volume-relative path in
# a plain column (`upscale_jobs.result_url`, `generation_jobs.video_url`,
# `angle_jobs.images[]`) rather than a `checkpoints[]` list, so the publish
# is keyed by path: the R2 key *is* the relative path, and the row's
# metadata gets `r2_keys: [<rel_path>, ...]` listing what has been moved.
# The Next.js routes presign a key only when it appears in `r2_keys`, and
# fall back to the Modal endpoint otherwise (files still on the Volume).
# ---------------------------------------------------------------------------
def publish_volume_files(
    models_dir: str | pathlib.Path,
    rel_paths: Iterable[str],
    *,
    remove_local: bool = True,
    log=print,
) -> dict:
    """Upload `<models_dir>/<rel_path>` to key `<rel_path>` for every path.
    Returns {keys: [uploaded rel paths], failed: [...], skipped: [...],
    bytes, elapsed_s}. Fail-open per file, never raises."""
    stats: dict = {"keys": [], "failed": [], "skipped": [], "bytes": 0, "elapsed_s": 0.0}
    paths = [str(p).strip().strip("/") for p in rel_paths if p]
    if not paths:
        return stats
    if not r2_enabled():
        log(f"[r2] disabled (ARTIFACT_STORE={artifact_store()!r}, configured={r2_configured()}) — Volume only", flush=True)
        return stats
    t0 = time.time()
    root = pathlib.Path(models_dir)
    for rel in paths:
        if ".." in rel.split("/"):
            stats["skipped"].append(rel)
            continue
        local = root / rel
        if not local.is_file():
            stats["skipped"].append(rel)
            continue
        try:
            r = put_file(local, rel)
            remote = head(rel)
            if remote != local.stat().st_size:
                raise RuntimeError(f"size mismatch after upload: local={local.stat().st_size} remote={remote}")
            log(f"[r2] put {rel} ({r['size_bytes'] / _MB:.1f} MB, {r['mb_s']} MB/s)", flush=True)
            stats["bytes"] += r["size_bytes"]
            stats["keys"].append(rel)
            if remove_local:
                try:
                    local.unlink()
                except Exception as rm_exc:  # noqa: BLE001
                    log(f"[r2] local unlink skipped ({rel}): {rm_exc}", flush=True)
        except Exception as exc:  # noqa: BLE001 — never let storage kill a finished job
            log(f"[r2] put FAILED {rel}: {exc!r} — keeping Volume copy", flush=True)
            stats["failed"].append(rel)
    stats["elapsed_s"] = round(time.time() - t0, 1)
    mb = stats["bytes"] / _MB
    log(
        f"[r2] publish {len(stats['keys'])} ok / {len(stats['failed'])} failed / "
        f"{len(stats['skipped'])} skipped, {mb:.0f} MB in {stats['elapsed_s']}s"
        + (f" ({mb / max(stats['elapsed_s'], 1e-6):.1f} MB/s)" if mb else ""),
        flush=True,
    )
    return stats


def stamp_r2_keys(meta: dict | None, stats: dict) -> dict | None:
    """Merge `publish_volume_files()` stats into a metadata dict (new dict;
    the input is not mutated). Returns None when nothing was uploaded."""
    if not stats.get("keys"):
        return None
    merged = dict(meta or {})
    merged["r2_keys"] = sorted(set(list(merged.get("r2_keys") or []) + list(stats["keys"])))
    merged["artifact_store"] = "r2"
    merged["r2_publish"] = {
        "uploaded": len(stats["keys"]),
        "failed": len(stats["failed"]),
        "bytes": stats["bytes"],
        "elapsed_s": stats["elapsed_s"],
    }
    return merged
