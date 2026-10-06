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
# 本体（2026-10-06）: turbo（8 step・CFG なし・蒸留）／sft（50 step・CFG 7・shift 3、公式の「最高品質」）。
# turbo は 10 曲に 1 曲しか使えない崩れ方だった（ホスト評価）→ sft で同じ歌詞・同じシードを比べる。
# 推奨値は公式 ACE-Step-1.5 の docs/en/API.md（inference_steps: base 32〜64・guidance_scale 7.0・shift 3.0）と
# acestep/core/generation/handler/generate_music.py（turbo は CFG を 1.0 に固定する）。
# ⚠️ env はコンテナに届かない（Modal は手元の env を引き継がない）。ACE_DIT は手元の main が読み、
# params["dit"] としてコンテナへ渡す（2026-10-06、env だけで切り替えたら turbo のまま 10 本回った）。
DIT = os.environ.get("ACE_DIT", "turbo")
DIT_SETTINGS = {
    "turbo": {"unet": "acestep_v1.5_xl_turbo_bf16.safetensors", "steps": 8, "cfg": 1.0, "shift": 3},
    "sft": {"unet": "acestep_v1.5_xl_sft_bf16.safetensors", "steps": 50, "cfg": 7.0, "shift": 3},
}
if DIT not in DIT_SETTINGS:
    raise ValueError(f"ACE_DIT must be one of {list(DIT_SETTINGS)}")

HF_REPO = "Comfy-Org/ace_step_1.5_ComfyUI_files"
HF_REVISION = "6707deb277e9e0907fd9c14ce6b6f1d695c6a3fc"
# (リポジトリ内のパス, ComfyUI のモデル種別フォルダ)
WEIGHTS = [
    ("split_files/diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors", "diffusion_models"),
    # XL SFT（`ACE-Step/acestep-v15-xl-sft`・MIT、2026-10-06 確認）。
    ("split_files/diffusion_models/acestep_v1.5_xl_sft_bf16.safetensors", "diffusion_models"),
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


# --- 尺（2026-10-05）--------------------------------------------------------------------
# ComfyUI の ACE-Step は指定した長さで必ず打ち切る（comfy/text_encoders/ace15.py: 曲の設計図のトークン数＝長さ×5 で固定）。
# 60 秒のままだと、ひなたの曲（16 行・128 BPM）は最後の行の途中で切れた。歌の部分だけで 16 行×2 小節×1.875 秒＝60 秒あり、
# 前奏・後奏が入らないため。→ 歌詞から長さを見積もり、少し長めにする（余った分は後奏になる）。
# 歌詞 1 行 ≒ 4 小節（2026-10-06）。2 小節（ひなたの曲・BPM 128 でぎりぎり歌い切れた 1 例）では、屋上の 4 行・BPM 120・40 秒が
# 歌の途中で時間切れになった（ホスト指摘）。余った分は後奏になり末尾の無音は切るので、長めに見積もる方が安全（1 曲 1 円未満）。
LINE_BARS = 4
INTRO_BARS = 4
OUTRO_BARS = 4
DURATION_MARGIN = 1.1
MAX_SECONDS = 240.0


def lyric_lines(lyrics: str) -> list[str]:
    return [ln for ln in lyrics.splitlines() if ln.strip() and not ln.strip().startswith("[")]


def estimate_seconds(lyrics: str, bpm: int, timesignature: str = "4") -> float:
    """歌詞の行数と BPM から、歌い切って後奏まで入る長さ（5 秒単位で切り上げ）。歌詞が無ければ 60 秒。"""
    import math

    lines = lyric_lines(lyrics)
    if not lines:
        return 60.0
    beats = int(timesignature) if str(timesignature).isdigit() else 4
    bar_s = beats * 60.0 / max(40, int(bpm))
    secs = (len(lines) * LINE_BARS + INTRO_BARS + OUTRO_BARS) * bar_s * DURATION_MARGIN
    return float(min(MAX_SECONDS, max(30, math.ceil(secs / 5) * 5)))


def prepare_params(p: dict) -> dict:
    """seconds が 0・"auto"・未指定なら歌詞から決める。歌詞の最後に [Outro] が無ければ足す（終わり方を作らせる）。"""
    q = dict(p)
    lyrics = str(q.get("lyrics", "")).rstrip()
    if lyric_lines(lyrics) and not lyrics.splitlines()[-1].strip().lower().startswith("[outro"):
        lyrics += "\n\n[Outro]"
    q["lyrics"] = lyrics
    tags = str(q.get("tags", "")).strip()
    if "ending" not in tags.lower():
        tags = f"{tags}, natural ending with a short outro" if tags else "natural ending with a short outro"
    q["tags"] = tags
    sec = q.get("seconds")
    q["auto_seconds"] = not sec or sec == "auto" or float(sec) <= 0
    if q["auto_seconds"]:
        q["seconds"] = estimate_seconds(lyrics, int(q.get("bpm", 120)), str(q.get("timesignature", "4")))
    return q


def finish_audio(src: str, dst: str) -> dict:
    """末尾の無音を切って 1.5 秒のフェードアウトを付ける（ffmpeg）。最後の 1 秒が大きい音のまま＝途中で切れた疑いも測る。"""
    import re

    def run(args):
        return subprocess.run(args, capture_output=True, text=True)

    dur = float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src]).stdout.strip())
    # 最後の 1 秒と全体の音量（dB）。差が小さい＝最後まで大きい音のまま終わっている。
    def vol(extra):
        out = run(["ffmpeg", "-v", "info", *extra, "-i", src, "-af", "volumedetect", "-f", "null", "-"]).stderr
        m = re.search(r"mean_volume: (-?[\d.]+) dB", out)
        return float(m.group(1)) if m else None

    whole_db = vol([])
    tail_db = vol(["-sseof", "-1"])
    # 末尾の無音（-50dB 以下が 0.5 秒以上）の始まり。
    sil = run(["ffmpeg", "-v", "info", "-i", src, "-af", "silencedetect=noise=-50dB:d=0.5", "-f", "null", "-"]).stderr
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", sil)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", sil)]
    end_at = dur
    if starts and (len(ends) < len(starts) or ends[-1] >= dur - 0.05):
        end_at = max(5.0, starts[-1] + 0.3)
    fade = min(1.5, end_at / 4)
    r = run([
        "ffmpeg", "-v", "error", "-y", "-i", src, "-t", f"{end_at:.3f}",
        "-af", f"afade=t=out:st={end_at - fade:.3f}:d={fade:.3f}", dst,
    ])
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg finish failed: {r.stderr[-1000:]}")
    abrupt = whole_db is not None and tail_db is not None and tail_db > whole_db - 6
    return {
        "raw_s": round(dur, 2),
        "final_s": round(end_at, 2),
        "trimmed_s": round(dur - end_at, 2),
        "tail_db": tail_db,
        "whole_db": whole_db,
        "ended_abruptly": abrupt,
    }


def build_workflow(p: dict) -> dict:
    """ace_hinata_song_60s.json と同じ組み方。p: tags / lyrics / seconds / bpm / keyscale / language / timesignature / seed。"""
    seconds = float(p.get("seconds", 60))
    seed = int(p.get("seed", 1))
    d = DIT_SETTINGS[p.get("dit") or "turbo"]
    return {
        "104": {"class_type": "UNETLoader", "inputs": {"unet_name": d["unet"], "weight_dtype": "default"}},
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
        "78": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["104", 0], "shift": d["shift"]}},
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["78", 0],
                "positive": ["94", 0],
                "negative": ["47", 0],
                "latent_image": ["98", 0],
                "seed": seed,
                "steps": d["steps"],
                "cfg": d["cfg"],
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

        params = prepare_params(params)
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
        finished = str(new[-1].with_name(new[-1].stem + "_final.flac"))
        info = finish_audio(str(new[-1]), finished)
        data = pathlib.Path(finished).read_bytes()
        print(
            f"[ace] {params['seconds']}s ({'auto' if params['auto_seconds'] else 'fixed'}) song in {elapsed}s "
            f"(boot {self.boot_s}s) -> {info}",
            flush=True,
        )
        return {
            "audio": data,
            "filename": pathlib.Path(finished).name,
            "elapsed_s": elapsed,
            "boot_s": self.boot_s,
            "gpu": GPU,
            "dit": params.get("dit") or "turbo",
            "seconds": params["seconds"],
            "auto_seconds": params["auto_seconds"],
            **info,
        }


@app.local_entrypoint()
def main(out_dir: str = "./ace_out", seconds: float = 0.0, seed: int = 1, workflow: str = "", count: int = 1):
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
        "dit": DIT,
    }
    dst = pathlib.Path(out_dir).expanduser()
    dst.mkdir(parents=True, exist_ok=True)
    worker = AceStep()
    # count > 1: 同じコンテナで続けて作る（2 本目以降＝重みを読み込み済みの「連続で作るとき」の時間）。
    for k in range(count):
        t = time.time()
        res = worker.generate.remote({**params, "seed": seed + k})
        total = time.time() - t
        tag = "auto" if res["auto_seconds"] else f"{int(seconds)}s"
        out = dst / f"ace_{GPU}_{res['dit']}_{tag}{int(res['seconds'])}s_seed{seed + k}_{res['filename']}"
        out.write_bytes(res["audio"])
        print(
            f"[main] #{k + 1} gpu={res['gpu']} generate={res['elapsed_s']}s boot={res['boot_s']}s "
            f"total(含コールド)={total:.0f}s set={res['seconds']}s raw={res['raw_s']}s final={res['final_s']}s "
            f"tail={res['tail_db']}dB whole={res['whole_db']}dB abrupt={res['ended_abruptly']} -> {out}"
        )
