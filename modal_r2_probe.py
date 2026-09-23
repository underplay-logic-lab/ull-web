"""CPU-only probe: does a Modal container see the `r2-artifacts` secret and can
ull_r2.py round-trip an object? (CLAUDE.md §1 — verify plumbing on CPU before
any GPU job depends on it.)

    PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_r2_probe.py

Writes a 96MB file (multipart, 64MB parts) so the upload path the LoRA
workers use is exercised, then reads it back through a presigned URL,
verifies size, and deletes it. Costs a few seconds of CPU.
"""

from __future__ import annotations

import modal

app = modal.App("ull-r2-probe")

image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install("boto3>=1.35", "requests")
    .add_local_python_source("ull_r2")
)


@app.function(image=image, secrets=[modal.Secret.from_name("r2-artifacts")], timeout=600)
def probe() -> dict:
    import os
    import pathlib
    import time

    import requests

    import ull_r2

    out: dict = {
        "store": ull_r2.artifact_store(),
        "configured": ull_r2.r2_configured(),
        "enabled": ull_r2.r2_enabled(),
        "bucket": os.environ.get("R2_BUCKET"),
    }
    if not ull_r2.r2_enabled():
        return out

    tmp = pathlib.Path("/tmp/r2_probe.bin")
    size = 96 * 1024 * 1024
    with tmp.open("wb") as f:
        f.write(os.urandom(size))
    key = "_probe/modal/r2_probe.bin"

    checkpoints = [{"filename": tmp.name, "step": 1, "size_bytes": size, "is_final": True}]
    stats = ull_r2.publish_job_dir(tmp.parent, checkpoints, "_probe/modal", extra_files=(), remove_local=True)
    out["publish"] = stats
    out["entry"] = checkpoints[0]
    out["local_removed"] = not tmp.exists()

    url = ull_r2.presign_get(key, 300, download_name="probe.bin")
    t0 = time.time()
    r = requests.get(url, stream=True, timeout=120)
    n = 0
    for chunk in r.iter_content(8 * 1024 * 1024):
        n += len(chunk)
    dt = time.time() - t0
    out["download"] = {
        "status": r.status_code,
        "content_disposition": r.headers.get("Content-Disposition"),
        "bytes": n,
        "mb_s": round(n / 1024 / 1024 / max(dt, 1e-6), 1),
        "size_ok": n == size,
    }
    out["deleted"] = ull_r2.delete_prefix("_probe/modal/")
    return out


@app.local_entrypoint()
def main() -> None:
    import json

    print(json.dumps(probe.remote(), indent=1, ensure_ascii=False))
