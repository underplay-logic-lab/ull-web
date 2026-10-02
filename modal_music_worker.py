"""
Music worker on Modal（評価用）— MiniMax Music 3 で BGM を生成する。

目的（2026-10-02）: ①チャンネルの操作動画の共通 BGM を作る ②Cinematic Director に「動画の長さちょうどの BGM」を
付ける機能になるかを判断する（音質・所要時間・歌なしの作りやすさ）。まだ Studio には組み込んでいない。

採用モデル（CLAUDE.md §5）:
  - MiniMax Music 3（`MiniMaxAI/MiniMax-Music3`、約 57GB）: MiniMax-Music3 Community License（2026-10-02 確認）。
    商用可・地域制限なし・年商 2,000 万ドル超は要許可。**サービスに組み込むなら UI に "MiniMax-Music3" を目立つように
    表示する義務**（CLAUDE.md §2 のモデル名非表示と衝突 → 機能化する前にホスト判断）。生成物を公開するときは機械生成と明示。
  - 推論は diffusers の ModularPipeline（公式手順のコミットに固定）。既定 bf16（CLAUDE.md §1 の BF16 既定と同じ）。
    オフロードは精度を変えず遅くなるだけなので、家庭用 GPU との差は「速さ」になる。

ComfyUI を使わない独立ワーカーなので、image は最小構成（Python 3.13 + torch cu130。RTX PRO 6000 = Blackwell）。
重みは LoRA ワーカーの HF キャッシュ掃除（training/hf_cache/hub）の対象外の `/models/music/hf_cache` に置く。

  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_music_worker.py::probe          # CPU: import の確認
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_music_worker.py::precache       # CPU: 重みを Volume へ
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_music_worker.py::main --out-dir <dir>   # GPU: 試作
"""

import io
import os
import pathlib
import time

import modal

app = modal.App("ull-music-eval")
MODELS_DIR = "/models"
vol = modal.Volume.from_name("ull-wan-models")
HF_HOME = f"{MODELS_DIR}/music/hf_cache"
REPO = os.environ.get("MUSIC_REPO", "MiniMaxAI/MiniMax-Music3")
DIFFUSERS_REF = "dafe3733fcfdbf3c48915fe77be3aef65b5d6a2d"  # 公式手順の固定コミット

image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("git", "ffmpeg")
    .pip_install(
        "torch",
        "torchaudio",
        index_url="https://download.pytorch.org/whl/cu130",
        extra_index_url="https://download.pytorch.org/whl/nightly/cu130",
    )
    .pip_install(
        f"git+https://github.com/huggingface/diffusers@{DIFFUSERS_REF}",
        "transformers",
        "accelerate",
        "soundfile",
        "huggingface_hub[hf_transfer]",
        "numpy",
    )
    .env({"HF_HOME": HF_HOME, "HF_HUB_ENABLE_HF_TRANSFER": "1", "PYTHONUNBUFFERED": "1"})
)


@app.function(image=image, cpu=2, memory=4096, timeout=600, scaledown_window=2)
def probe() -> dict:
    """GPU なしで import 連鎖を確かめる。"""
    import diffusers
    import torch
    import transformers
    from diffusers import ModularPipeline  # noqa: F401

    out = {"torch": torch.__version__, "diffusers": diffusers.__version__, "transformers": transformers.__version__}
    print(f"[probe] {out}", flush=True)
    return out


@app.function(
    image=image,
    cpu=4,
    memory=8192,
    timeout=60 * 60,
    volumes={MODELS_DIR: vol},
    secrets=[modal.Secret.from_name("huggingface-secret")],
    scaledown_window=2,
)
def precache() -> dict:
    """重みを Volume の HF キャッシュへ 1 回だけ引く（GPU を DL で遊ばせない）。"""
    from huggingface_hub import snapshot_download

    t = time.time()
    path = snapshot_download(REPO)
    size = sum(p.stat().st_size for p in pathlib.Path(path).rglob("*") if p.is_file())
    vol.commit()
    print(f"[precache] {REPO} -> {path} ({size / 1e9:.1f} GB, {time.time() - t:.0f}s)", flush=True)
    return {"path": path, "gb": round(size / 1e9, 1)}


@app.cls(
    image=image,
    gpu="RTX-PRO-6000",
    volumes={MODELS_DIR: vol},
    timeout=60 * 30,
    scaledown_window=30,
)
class Music:
    @modal.enter()
    def load(self):
        import torch
        from diffusers import ModularPipeline

        t = time.time()
        self.pipe = ModularPipeline.from_pretrained(REPO)
        self.pipe.load_components(torch_dtype=torch.bfloat16)
        self.pipe.to("cuda")
        print(f"[music] loaded in {time.time() - t:.0f}s, VRAM={torch.cuda.memory_allocated() / 1e9:.1f}GB", flush=True)

    @modal.method()
    def generate(self, prompt: str, lyrics: str = "", duration: float = 60.0, seed: int = 7) -> dict:
        import numpy as np
        import soundfile as sf
        import torch

        torch.cuda.reset_peak_memory_stats()
        t = time.time()
        audio = self.pipe(
            prompt=prompt,
            lyrics=lyrics,
            audio_duration=float(duration),
            generator=torch.Generator("cuda").manual_seed(seed),
            output="audios",
        )[0]
        took = time.time() - t
        arr = audio.detach().float().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
        if arr.ndim == 2 and arr.shape[0] in (1, 2):
            arr = arr.T  # (channels, samples) -> (samples, channels)
        sr = int(getattr(getattr(self.pipe, "config", None), "sample_rate", 0) or 32000)
        buf = io.BytesIO()
        sf.write(buf, arr, sr, format="WAV", subtype="PCM_16")
        peak = torch.cuda.max_memory_allocated() / 1e9
        print(f"[music] {duration:.0f}s audio in {took:.1f}s (peak VRAM {peak:.1f}GB) sr={sr} shape={arr.shape}", flush=True)
        return {"wav": buf.getvalue(), "seconds": took, "peak_vram_gb": round(peak, 1), "sr": sr}


# チャンネルの操作動画向け（歌なし・静かめ・ブランドは黒 × 明朝の落ち着いた雰囲気）。
PROMPTS = [
    ("piano", "Calm minimalist piano with soft ambient pads, slow tempo around 70 BPM, gentle and modern, clean mix, "
              "instrumental only, no vocals, background music for a quiet product tutorial video"),
    ("lofi", "Lo-fi chill hop with warm Rhodes electric piano, soft vinyl crackle, mellow brushed drums, around 80 BPM, "
             "relaxed and cozy, instrumental only, no vocals"),
    ("ambient", "Elegant ambient electronic with airy synth pads and a subtle pulsing arpeggio, quiet and cinematic, "
                "around 90 BPM, instrumental only, no vocals"),
]


@app.local_entrypoint()
def main(out_dir: str = "./music_out", duration: float = 60.0, seed: int = 7, lyrics: str = "[Instrumental]"):
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    m = Music()
    for name, prompt in PROMPTS:
        r = m.generate.remote(prompt, lyrics=lyrics, duration=duration, seed=seed)
        p = out / f"{name}_s{seed}.wav"
        p.write_bytes(r["wav"])
        print(f"{p}  {r['seconds']:.1f}s  peak {r['peak_vram_gb']}GB", flush=True)


@app.local_entrypoint()
def batch(jobs: str, out_dir: str = "./music_out"):
    """jobs: JSON ファイル [{"name", "prompt", "lyrics", "duration", "seed"}]。ComfyUI 既定例の形式
    （Global Metadata / Vocal Details / Arrangement の指示文＋セクションタグ付きの歌詞）で書く。"""
    import json

    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    m = Music()
    for j in json.loads(pathlib.Path(jobs).read_text(encoding="utf-8")):
        r = m.generate.remote(j["prompt"], lyrics=j.get("lyrics", ""), duration=j.get("duration", 60.0), seed=j.get("seed", 7))
        p = out / f"{j['name']}.wav"
        p.write_bytes(r["wav"])
        print(f"{p}  {r['seconds']:.1f}s  peak {r['peak_vram_gb']}GB", flush=True)
