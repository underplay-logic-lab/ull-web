"""「画風を変える（構図そのまま）」用のモデルを ull-wan-models Volume へ置く。CPU のみ（GPU 課金なし・CLAUDE.md §1）。

  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run scripts/modal_precache_restyle.py

採用（2026-10-10 確認・すべて Apache-2.0。Qwen-Image 2.1 は非商用なので使わない・docs/model-licenses.md）:
- Qwen-Image-2512 本体 bf16（Comfy-Org/Qwen-Image_ComfyUI）→ diffusion_models/
- Qwen2.5-VL 7B bf16（同上・2512 の文章読み取り）→ text_encoders/
- Qwen Image VAE（同上）→ vae/
- Qwen3-VL 8B bf16（Comfy-Org/Qwen3-VL・元画像の言語化。Qwen2.5-VL は ComfyUI の TextGenerate で動かない）→ text_encoders/
- Qwen-Image-2512 Fun ControlNet Union 2602（alibaba-pai/Qwen-Image-2512-Fun-Controlnet-Union）→ controlnet/
"""
import os

import modal

app = modal.App("ull-precache-restyle")
vol = modal.Volume.from_name("ull-wan-models")
image = modal.Image.debian_slim(python_version="3.13").pip_install("requests")
MODELS = "/models"
FILES = [
    ("https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_2512_bf16.safetensors",
     "diffusion_models/qwen_image_2512_bf16.safetensors"),
    ("https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b.safetensors",
     "text_encoders/qwen_2.5_vl_7b.safetensors"),
    ("https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors",
     "vae/qwen_image_vae.safetensors"),
    ("https://huggingface.co/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_8b_bf16.safetensors",
     "text_encoders/qwen3vl_8b_bf16.safetensors"),
    ("https://huggingface.co/alibaba-pai/Qwen-Image-2512-Fun-Controlnet-Union/resolve/main/Qwen-Image-2512-Fun-Controlnet-Union-2602.safetensors",
     "controlnet/Qwen-Image-2512-Fun-Controlnet-Union-2602.safetensors"),
]


@app.function(image=image, volumes={MODELS: vol}, timeout=7200, cpu=4, memory=4096, scaledown_window=2)
def precache() -> dict:
    import time

    import requests

    out = {}
    for url, rel in FILES:
        dst = os.path.join(MODELS, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.exists(dst) and os.path.getsize(dst) > 0:
            out[rel] = f"exists {os.path.getsize(dst) / 1e9:.1f}GB"
            print(f"[precache] {rel}: {out[rel]}", flush=True)
            continue
        t = time.time()
        with requests.get(url, stream=True, timeout=(15, 300)) as r:
            r.raise_for_status()
            done = 0
            with open(dst + ".part", "wb", buffering=4 * 1024 * 1024) as f:  # Volume は 4MiB 単位で書く（CLAUDE.md §1）
                for chunk in r.iter_content(chunk_size=4 * 1024 * 1024):
                    f.write(chunk)
                    done += len(chunk)
                    if done % (2 * 1024**3) < 4 * 1024 * 1024:
                        print(f"[precache] {rel}: {done / 1e9:.1f}GB", flush=True)
        os.replace(dst + ".part", dst)
        out[rel] = f"{os.path.getsize(dst) / 1e9:.1f}GB in {time.time() - t:.0f}s"
        print(f"[precache] {rel}: {out[rel]}", flush=True)
    vol.commit()  # まとめて 1 回
    return out


@app.local_entrypoint()
def main():
    print(precache.remote())
