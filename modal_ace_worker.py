"""
ACE-Step worker on Modal — 曲調・声・歌詞から歌入りの曲を作る（2026-10-05 着手・まだ Studio には組み込んでいない）。

目的: 「曲調・声（男女）・歌詞 → すぐ曲」を Studio の 1 タブにし、できた曲を Cinematic Director の「音声の持ち込み」へ渡して
歌唱 MV を作る（docs/STATUS.md「次の一手」A の続き）。まず L4 で 1 曲あたりの時間・原価を測る。

採用モデル（CLAUDE.md §5、docs/model-licenses.md）:
  - ACE-Step 1.5 XL turbo（`ACE-Step/acestep-v15-xl-turbo`）・言語モデル `acestep-5Hz-lm-0.6B` / `-4B`: MIT（2026-10-05 確認）。
    README に「権利処理済みのデータで学習・生成した曲は商用利用可」。地域制限・表示義務なし。
  - 重みは ComfyUI 用のまとめ直し `Comfy-Org/ace_step_1.5_ComfyUI_files`（Apache-2.0、リビジョン固定）。
  - 推論は ComfyUI 本体のノードだけ（TextEncodeAceStepAudio1.5 ほか、カスタムノードなし）。BF16（CLAUDE.md §1）。
    組み方はローカルで歌唱 MV の曲を作った D:\\ComfyUI-ull\\ace_hinata_song_60s.json と同じ（8 step・cfg 1・shift 3）。

ComfyUI は新規ワーカーなので現時点の最新タグ（v0.38.2）から始める（CLAUDE.md §1。本番に入ったら固定）。
GPU の既定は L4（$0.80/h・24GB、Ada）。曲づくりは計算が軽く、Blackwell を使う理由がない（docs/STATUS.md の見込み）。
env `ACE_GPU` で切り替えて測り比べる。

  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_ace_worker.py::probe       # CPU: import とノードの存在確認
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_ace_worker.py::precache    # CPU: 重みを Volume へ
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_ace_worker.py::main --out-dir <dir> [--seconds 60]   # GPU: 試作
"""

import json
import os
import pathlib
import subprocess
import time

import modal

app = modal.App("ull-ace-step")
MODELS_DIR = "/models"
ACE_DIR = f"{MODELS_DIR}/ace_step"
vol = modal.Volume.from_name("ull-wan-models")

COMFY_DIR = "/root/comfy/ComfyUI"
COMFY_PORT = 8188
COMFYUI_REF = os.environ.get("ACE_COMFYUI_REF", "v0.38.2")
GPU = os.environ.get("ACE_GPU", "L4")

HF_REPO = "Comfy-Org/ace_step_1.5_ComfyUI_files"
HF_REVISION = "6707deb277e9e0907fd9c14ce6b6f1d695c6a3fc"
# (リポジトリ内のパス, ComfyUI のモデル種別フォルダ)
WEIGHTS = [
    ("split_files/diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors", "diffusion_models"),
    ("split_files/text_encoders/qwen_0.6b_ace15.safetensors", "text_encoders"),
    ("split_files/text_encoders/qwen_4b_ace15.safetensors", "text_encoders"),
    ("split_files/vae/ace_1.5_vae.safetensors", "vae"),
]

image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("git", "ffmpeg")
    .pip_install(
        "torch",
        "torchvision",
        "torchaudio",
        index_url="https://download.pytorch.org/whl/cu130",
        extra_index_url="https://download.pytorch.org/whl/nightly/cu130",
    )
    .run_commands(
        f"git clone https://github.com/comfyanonymous/ComfyUI.git {COMFY_DIR}",
        f"cd {COMFY_DIR} && git fetch --tags --force && git checkout {COMFYUI_REF}",
        f"cd {COMFY_DIR} && pip install -r requirements.txt",
    )
    .pip_install("requests", "huggingface_hub[hf_transfer]")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1", "PYTHONUNBUFFERED": "1"})
    # 重みは Volume の /models/ace_step/<種別>/ から読む。
    .run_commands(
        f"printf 'ace:\\n  base_path: {ACE_DIR}\\n  diffusion_models: diffusion_models\\n"
        f"  text_encoders: text_encoders\\n  vae: vae\\n' > {COMFY_DIR}/extra_model_paths.yaml"
    )
)


@app.function(image=image, cpu=2, memory=4096, timeout=600, scaledown_window=2, volumes={MODELS_DIR: vol})
def probe() -> dict:
    """GPU なしで確かめる: torch の import・ComfyUI の版・使うノードが本体にあるか・重みの有無。
    ComfyUI 本体は import 時に GPU を要求するので、ノードはソースを見て確かめる。"""
    import torch

    src = pathlib.Path(COMFY_DIR, "comfy_extras", "nodes_ace.py").read_text(encoding="utf-8")
    nodes = {n: (f'node_id="{n}"' in src) for n in ("TextEncodeAceStepAudio1.5", "EmptyAceStep1.5LatentAudio")}
    ref = subprocess.run(["git", "-C", COMFY_DIR, "describe", "--tags"], capture_output=True, text=True).stdout.strip()
    weights = {
        name: os.path.getsize(p) if os.path.exists(p := f"{ACE_DIR}/{kind}/{pathlib.Path(name).name}") else None
        for name, kind in WEIGHTS
    }
    out = {"torch": torch.__version__, "cuda_build": torch.version.cuda, "comfyui": ref, "nodes": nodes, "weights": weights}
    print(json.dumps(out, ensure_ascii=False, indent=1), flush=True)
    return out


@app.function(image=image, cpu=4, memory=8192, timeout=3600, scaledown_window=2, volumes={MODELS_DIR: vol})
def precache() -> dict:
    """重み 4 本（約 20GB）を Volume へ。既にあれば飛ばす。commit は最後に 1 回。"""
    import shutil

    from huggingface_hub import hf_hub_download

    done = {}
    for name, kind in WEIGHTS:
        dst = pathlib.Path(ACE_DIR, kind, pathlib.Path(name).name)
        if dst.exists() and dst.stat().st_size > 0:
            done[dst.name] = "exists"
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        t = time.time()
        p = hf_hub_download(HF_REPO, name, revision=HF_REVISION, cache_dir="/tmp/hf")
        with open(p, "rb") as fi, open(dst, "wb") as fo:
            shutil.copyfileobj(fi, fo, length=4 * 1024 * 1024)  # Volume は 4MiB 単位で書く（CLAUDE.md §1）
        done[dst.name] = f"{dst.stat().st_size / 1e9:.2f}GB in {time.time() - t:.0f}s"
        print(f"[precache] {dst} {done[dst.name]}", flush=True)
    vol.commit()
    return done


def build_workflow(p: dict) -> dict:
    """ace_hinata_song_60s.json と同じ組み方。p: tags / lyrics / seconds / bpm / keyscale / language / timesignature / seed。"""
    seconds = float(p.get("seconds", 60))
    seed = int(p.get("seed", 1))
    return {
        "104": {"class_type": "UNETLoader", "inputs": {"unet_name": "acestep_v1.5_xl_turbo_bf16.safetensors", "weight_dtype": "default"}},
        "106": {"class_type": "VAELoader", "inputs": {"vae_name": "ace_1.5_vae.safetensors"}},
        "105": {
            "class_type": "DualCLIPLoader",
            "inputs": {
                "clip_name1": "qwen_0.6b_ace15.safetensors",
                "clip_name2": "qwen_4b_ace15.safetensors",
                "type": "ace",
                "device": "default",
            },
        },
        "98": {"class_type": "EmptyAceStep1.5LatentAudio", "inputs": {"seconds": seconds, "batch_size": 1}},
        "94": {
            "class_type": "TextEncodeAceStepAudio1.5",
            "inputs": {
                "clip": ["105", 0],
                "tags": p.get("tags", ""),
                "lyrics": p.get("lyrics", ""),
                "seed": seed,
                "bpm": int(p.get("bpm", 120)),
                "duration": seconds,
                "timesignature": str(p.get("timesignature", "4")),
                "language": p.get("language", "ja"),
                "keyscale": p.get("keyscale", "C major"),
                "generate_audio_codes": True,
                "cfg_scale": 2.0,
                "temperature": 0.85,
                "top_p": 0.9,
                "top_k": 0,
                "min_p": 0.0,
            },
        },
        "47": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["94", 0]}},
        "78": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["104", 0], "shift": 3}},
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["78", 0],
                "positive": ["94", 0],
                "negative": ["47", 0],
                "latent_image": ["98", 0],
                "seed": seed,
                "steps": 8,
                "cfg": 1,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1,
            },
        },
        "18": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["3", 0], "vae": ["106", 0]}},
        "111": {"class_type": "SaveAudio", "inputs": {"audio": ["18", 0], "filename_prefix": "ace/song"}},
    }


@app.cls(
    image=image,
    gpu=GPU,
    volumes={MODELS_DIR: vol},
    timeout=1800,
    scaledown_window=30,  # GPU ワーカーの標準（CLAUDE.md §1）。連続で曲を作るときにコールドスタートを避ける
    max_containers=2,
)
class AceStep:
    @modal.enter()
    def start(self):
        import urllib.request

        t = time.time()
        self.proc = subprocess.Popen(
            ["python", "main.py", "--listen", "127.0.0.1", "--port", str(COMFY_PORT)], cwd=COMFY_DIR
        )
        deadline = time.time() + 300
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"ComfyUI exited early (code {self.proc.returncode})")
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{COMFY_PORT}/system_stats", timeout=2)
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.5)
        else:
            raise RuntimeError("ComfyUI did not come up within 300s")
        self.boot_s = round(time.time() - t, 1)
        print(f"[ace] ComfyUI up in {self.boot_s}s", flush=True)

    @modal.method()
    def generate(self, params: dict) -> dict:
        """曲を 1 本作って FLAC のバイト列と所要時間を返す。"""
        import uuid

        import requests

        out_dir = pathlib.Path(COMFY_DIR, "output")
        pre = {str(p) for p in out_dir.rglob("*") if p.is_file()}
        t = time.time()
        r = requests.post(
            f"http://127.0.0.1:{COMFY_PORT}/prompt",
            json={"prompt": build_workflow(params), "client_id": str(uuid.uuid4())},
            timeout=30,
        )
        if not r.ok:
            raise RuntimeError(f"ComfyUI rejected the workflow ({r.status_code}): {r.text[:3000]}")
        pid = r.json()["prompt_id"]
        while True:
            h = requests.get(f"http://127.0.0.1:{COMFY_PORT}/history/{pid}", timeout=30).json()
            if pid in h:
                status = h[pid].get("status", {})
                if status.get("status_str") == "error":
                    raise RuntimeError(f"workflow failed: {json.dumps(status, ensure_ascii=False)[:3000]}")
                break
            if time.time() - t > 1500:
                raise TimeoutError("ACE-Step workflow timed out")
            time.sleep(0.25)
        elapsed = round(time.time() - t, 2)
        new = sorted((p for p in out_dir.rglob("*") if p.is_file() and str(p) not in pre), key=os.path.getmtime)
        if not new:
            raise RuntimeError("workflow finished but produced no audio")
        data = new[-1].read_bytes()
        print(f"[ace] {params.get('seconds')}s song in {elapsed}s (boot {self.boot_s}s) -> {new[-1].name}", flush=True)
        return {"audio": data, "filename": new[-1].name, "elapsed_s": elapsed, "boot_s": self.boot_s, "gpu": GPU}


@app.local_entrypoint()
def main(out_dir: str = "./ace_out", seconds: float = 60.0, seed: int = 1, workflow: str = "", count: int = 1):
    """試作: ローカルの ACE ワークフロー（既定はひなたの曲）から曲調・歌詞を読み、同じ条件で 1 本作る。"""
    src = workflow or r"D:\ComfyUI-ull\ace_hinata_song_60s.json"
    w = json.loads(pathlib.Path(src).read_text(encoding="utf-8"))
    w = w.get("prompt", w)
    enc = next(v["inputs"] for v in w.values() if v["class_type"] == "TextEncodeAceStepAudio1.5")
    params = {
        "tags": enc["tags"],
        "lyrics": enc["lyrics"],
        "seconds": seconds,
        "bpm": enc.get("bpm", 120),
        "keyscale": enc.get("keyscale", "C major"),
        "language": enc.get("language", "ja"),
        "timesignature": enc.get("timesignature", "4"),
        "seed": seed,
    }
    dst = pathlib.Path(out_dir).expanduser()
    dst.mkdir(parents=True, exist_ok=True)
    worker = AceStep()
    # count > 1: 同じコンテナで続けて作る（2 本目以降＝重みを読み込み済みの「連続で作るとき」の時間）。
    for k in range(count):
        t = time.time()
        res = worker.generate.remote({**params, "seed": seed + k})
        total = time.time() - t
        out = dst / f"ace_{GPU}_{int(seconds)}s_seed{seed + k}_{res['filename']}"
        out.write_bytes(res["audio"])
        print(
            f"[main] #{k + 1} gpu={res['gpu']} generate={res['elapsed_s']}s boot={res['boot_s']}s "
            f"total(含コールド)={total:.0f}s -> {out}"
        )
