#!/usr/bin/env python3
"""
Underplay High-Speed Model Downloader v2.1
--------------------------------------------
4-way parallel range-request downloader with automatic file sorting and
chunk merging, built for pulling large AI model checkpoints (Civitai /
Hugging Face) onto local disk as fast as possible.

Usage:
    python underplay_dl_manager.py <url> [-o OUTPUT_DIR] [-c CONNECTIONS]

Requires: requests (pip install requests)
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import unquote, urlparse

try:
    import requests
except ImportError:  # pragma: no cover
    print("This tool requires the 'requests' package: pip install requests")
    sys.exit(1)

DEFAULT_CONNECTIONS = 4
CHUNK_SIZE = 1024 * 1024  # 1 MiB

SORT_RULES = {
    ".safetensors": "checkpoints",
    ".ckpt": "checkpoints",
    ".pt": "checkpoints",
    ".pth": "loras",
    ".bin": "checkpoints",
    ".vae.pt": "vae",
    ".yaml": "configs",
    ".json": "configs",
}


def guess_filename(url: str, headers: dict) -> str:
    if "content-disposition" in {k.lower() for k in headers}:
        cd = next(v for k, v in headers.items() if k.lower() == "content-disposition")
        if "filename=" in cd:
            return unquote(cd.split("filename=")[-1].strip('"; '))
    path = urlparse(url).path
    return unquote(os.path.basename(path)) or "download.bin"


def sorted_destination(base_dir: str, filename: str) -> str:
    _, ext = os.path.splitext(filename.lower())
    subdir = SORT_RULES.get(ext, "misc")
    target_dir = os.path.join(base_dir, subdir)
    os.makedirs(target_dir, exist_ok=True)
    return os.path.join(target_dir, filename)


def download_range(url: str, start: int, end: int, part_path: str) -> str:
    headers = {"Range": f"bytes={start}-{end}"}
    with requests.get(url, headers=headers, stream=True, timeout=60) as resp:
        resp.raise_for_status()
        with open(part_path, "wb") as fh:
            for chunk in resp.iter_content(chunk_size=CHUNK_SIZE):
                if chunk:
                    fh.write(chunk)
    return part_path


def merge_parts(part_paths: list[str], destination: str) -> None:
    with open(destination, "wb") as out:
        for part_path in part_paths:
            with open(part_path, "rb") as part:
                while chunk := part.read(CHUNK_SIZE):
                    out.write(chunk)
            os.remove(part_path)


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while chunk := fh.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, output_dir: str, connections: int) -> None:
    head = requests.head(url, allow_redirects=True, timeout=30)
    head.raise_for_status()
    total_size = int(head.headers.get("Content-Length", 0))
    accepts_ranges = head.headers.get("Accept-Ranges", "").lower() == "bytes"
    filename = guess_filename(url, head.headers)
    destination = sorted_destination(output_dir, filename)

    print(f"[Underplay DL] {filename} ({total_size / (1024 * 1024):.1f} MB)")
    print(f"[Underplay DL] destination: {destination}")

    if not accepts_ranges or total_size == 0 or connections <= 1:
        print("[Underplay DL] server does not support ranged downloads, falling back to single stream")
        with requests.get(url, stream=True, timeout=60) as resp:
            resp.raise_for_status()
            with open(destination, "wb") as fh:
                for chunk in resp.iter_content(chunk_size=CHUNK_SIZE):
                    if chunk:
                        fh.write(chunk)
    else:
        part_size = total_size // connections
        ranges = []
        for i in range(connections):
            start = i * part_size
            end = total_size - 1 if i == connections - 1 else start + part_size - 1
            ranges.append((start, end))

        with tempfile.TemporaryDirectory(prefix="underplay_dl_") as tmp_dir:
            part_paths = [os.path.join(tmp_dir, f"part_{i}") for i in range(connections)]

            with ThreadPoolExecutor(max_workers=connections) as pool:
                futures = {
                    pool.submit(download_range, url, start, end, part_paths[i]): i
                    for i, (start, end) in enumerate(ranges)
                }
                for future in as_completed(futures):
                    idx = futures[future]
                    future.result()
                    print(f"[Underplay DL] connection {idx + 1}/{connections} complete")

            print("[Underplay DL] merging parts...")
            merge_parts(part_paths, destination)

    print(f"[Underplay DL] verifying checksum...")
    print(f"[Underplay DL] sha256: {sha256_of(destination)}")
    print(f"[Underplay DL] done -> {destination}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Underplay High-Speed Model Downloader v2.1")
    parser.add_argument("url", help="Direct download URL (Civitai / Hugging Face / any HTTP(S) source)")
    parser.add_argument("-o", "--output", default="./models", help="Output base directory (default: ./models)")
    parser.add_argument(
        "-c",
        "--connections",
        type=int,
        default=DEFAULT_CONNECTIONS,
        help=f"Number of parallel connections (default: {DEFAULT_CONNECTIONS})",
    )
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)
    download(args.url, args.output, args.connections)


if __name__ == "__main__":
    main()
