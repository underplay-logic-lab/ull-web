"""One-shot / idempotent R2 bucket configuration for ULL Studio artifacts.

    python scripts/r2_bucket_setup.py            # apply
    python scripts/r2_bucket_setup.py --show     # print current config only

Reads R2_* from .env.local (or the environment). Applies:
  * Lifecycle: every object expires 14 days after creation (CLAUDE.md §3
    「14日間完全自動パージ」— replaces modal_retention_purge.py for R2), and
    abandoned multipart uploads are aborted after 1 day (a 16-way 64MB
    multipart that dies mid-way would otherwise sit around billed).
  * CORS: GET/HEAD/PUT from any origin with Range + ETag exposed, so the
    browser can fetch presigned URLs directly (needed for the in-browser
    transfer panel and parallel Range downloads; docs/STATUS.md R2 plan #8).
    Presigned URLs are the auth, so "*" origin is safe here.

Both calls go through the S3 API (PutBucketLifecycleConfiguration /
PutBucketCors), which R2 supports.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _load_env_local() -> None:
    env = ROOT / ".env.local"
    if not env.is_file():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^(R2_[A-Z_]+)=(.*)$", line.strip())
        if m and not os.environ.get(m.group(1)):
            os.environ[m.group(1)] = m.group(2).strip().strip('"').strip("'")


RETENTION_DAYS = 14

LIFECYCLE = {
    "Rules": [
        {
            "ID": "ull-artifacts-14d",
            "Status": "Enabled",
            "Filter": {"Prefix": ""},
            "Expiration": {"Days": RETENTION_DAYS},
        },
        {
            "ID": "ull-abort-multipart-1d",
            "Status": "Enabled",
            "Filter": {"Prefix": ""},
            "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1},
        },
    ]
}

CORS = {
    "CORSRules": [
        {
            "ID": "ull-browser-direct",
            "AllowedOrigins": ["*"],
            "AllowedMethods": ["GET", "HEAD", "PUT"],
            "AllowedHeaders": ["*"],
            "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition"],
            "MaxAgeSeconds": 3600,
        }
    ]
}


def main() -> int:
    _load_env_local()
    import ull_r2

    if not ull_r2.r2_configured():
        print("R2_* not configured (need R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)")
        return 1
    s3 = ull_r2.client()
    b = ull_r2.bucket()
    show_only = "--show" in sys.argv

    if not show_only:
        s3.put_bucket_lifecycle_configuration(Bucket=b, LifecycleConfiguration=LIFECYCLE)
        print(f"lifecycle applied to {b}")
        s3.put_bucket_cors(Bucket=b, CORSConfiguration=CORS)
        print(f"cors applied to {b}")

    try:
        lc = s3.get_bucket_lifecycle_configuration(Bucket=b)
        print("lifecycle:", json.dumps(lc.get("Rules"), indent=1, default=str))
    except Exception as exc:  # noqa: BLE001
        print("lifecycle: (none)", exc)
    try:
        cors = s3.get_bucket_cors(Bucket=b)
        print("cors:", json.dumps(cors.get("CORSRules"), indent=1, default=str))
    except Exception as exc:  # noqa: BLE001
        print("cors: (none)", exc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
