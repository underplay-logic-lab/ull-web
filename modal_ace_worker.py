"""
ACE-Step worker on Modal — 曲調・声・歌詞から歌入りの曲を作る（2026-10-05 着手・2026-10-06 Studio「曲づくり」タブの本番）。

本番（2026-10-06）: Next.js の /api/song/generate が generation_jobs（workflow_type "song"）を作り、song_async（CPU）へ投げる。
GPU の AceStep.run_job が N 曲を続けて作り、MP3 にして R2 へ直接上げ、行を completed にする（失敗は failed＋全額返金）。
本体は XL SFT（50 step・CFG 7）、GPU は L40S（10 曲までの比較で原価と待ち時間の釣り合いが一番良い、docs/STATUS.md）。

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

import fastapi
import modal

app = modal.App("ull-ace-step")
MODELS_DIR = "/models"
ACE_DIR = f"{MODELS_DIR}/ace_step"
vol = modal.Volume.from_name("ull-wan-models")

COMFY_DIR = "/root/comfy/ComfyUI"
COMFY_PORT = 8188
COMFYUI_REF = os.environ.get("ACE_COMFYUI_REF", "v0.38.2")
# 既定は L40S（2026-10-06 実測: 100 秒の曲 1 本 L4 約 53 秒・L40S 19.7 秒・RTX PRO 6000 12.1 秒。起動込み 3 本で L40S が最速かつ安い側）。
GPU = os.environ.get("ACE_GPU", "L40S")
# 本体（2026-10-06）: turbo（8 step・CFG なし・蒸留）／sft（50 step・CFG 7・shift 3、公式の「最高品質」）。
# turbo は 10 曲に 1 曲しか使えない崩れ方だった（ホスト評価）→ sft で同じ歌詞・同じシードを比べる。
# 推奨値は公式 ACE-Step-1.5 の docs/en/API.md（inference_steps: base 32〜64・guidance_scale 7.0・shift 3.0）と
# acestep/core/generation/handler/generate_music.py（turbo は CFG を 1.0 に固定する）。
# ⚠️ env はコンテナに届かない（Modal は手元の env を引き継がない）。ACE_DIT は手元の main が読み、
# params["dit"] としてコンテナへ渡す（2026-10-06、env だけで切り替えたら turbo のまま 10 本回った）。
DIT = os.environ.get("ACE_DIT", "sft")
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
    .pip_install("requests", "huggingface_hub[hf_transfer]", "boto3>=1.35", "fastapi[standard]")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1", "PYTHONUNBUFFERED": "1"})
    # 重みは Volume の /models/ace_step/<種別>/ から読む。
    .run_commands(
        f"printf 'ace:\\n  base_path: {ACE_DIR}\\n  diffusion_models: diffusion_models\\n"
        f"  text_encoders: text_encoders\\n  vae: vae\\n' > {COMFY_DIR}/extra_model_paths.yaml"
    )
    .add_local_python_source("ull_r2")
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
# 後奏 8 小節（2026-10-06）: 4 小節だと「歌い終わった瞬間に終わる」「無理やり歌い切る」があった（ホスト指摘）。
OUTRO_BARS = 8
# 余裕 1.5 倍（2026-10-06）: 1.1 倍・後奏 8 小節の 100 秒でも 6 本中 3 本が末尾まで鳴ったまま（＝打ち切り）だった。
# モデルは前奏・間奏・後奏を長めに取る。余った分は末尾の無音として切るので、長めにする方が安全（1 曲 ¥1 弱の増え）。
DURATION_MARGIN = 1.5
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
        ending = "instrumental outro after the last line, gentle fade-out ending"
        tags = f"{tags}, {ending}" if tags else ending
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
    # 末尾の無音（-42dB 以下が 0.5 秒以上）の始まり。-50dB だと -45dB 前後の小さな残り音を切り残し、
    # 「急に切れて無音が続く」になった（2026-10-06、40 秒・seed 11 で 29.6 秒以降が -45dB）。
    sil = run(["ffmpeg", "-v", "info", "-i", src, "-af", "silencedetect=noise=-42dB:d=0.5", "-f", "null", "-"]).stderr
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", sil)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", sil)]
    end_at = dur
    if starts and (len(ends) < len(starts) or ends[-1] >= dur - 0.05):
        end_at = max(5.0, starts[-1] + 0.3)
    # 末尾に無音が無く、最後の 1 秒も大きい音のまま＝曲の途中で打ち切られた。ぶつ切りに聞こえないよう長めにフェードする（2026-10-06）。
    # モデル自身がゆっくりフェードして終わると無音の区間が 0.5 秒に満たず「無音なし」になるので、最後の音量も見る。
    cut_off = end_at >= dur - 0.05 and (whole_db is None or tail_db is None or tail_db > whole_db - 20)
    fade = min(4.0 if cut_off else 1.5, end_at / 4)
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
        "cut_off": cut_off,
    }


def build_workflow(p: dict) -> dict:
    """ace_hinata_song_60s.json と同じ組み方。p: tags / lyrics / seconds / bpm / keyscale / language / timesignature / seed。"""
    seconds = float(p.get("seconds", 60))
    seed = int(p.get("seed", 1))
    d = DIT_SETTINGS[p.get("dit") or "sft"]
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


def add_reference_audio(w: dict, ref_name: str) -> dict:
    """同じ声で別の曲（2026-10-06・試作）: ComfyUI 本体の ReferenceTimbreAudio（実験扱い）で参照音声を条件に足す。
    ⚠️ comfy/model_base.py（ACE-Step 1.5 の extra_conds）は参照音声があると is_covers=True にして、歌詞から作る
    曲の設計図（audio codes）を渡さない＝「カバー」寄りになる。声だけ移るのか曲ごと似るのかは実測で見る。"""
    w["120"] = {"class_type": "LoadAudio", "inputs": {"audio": ref_name}}
    w["121"] = {"class_type": "VAEEncodeAudio", "inputs": {"audio": ["120", 0], "vae": ["106", 0]}}
    w["122"] = {"class_type": "ReferenceTimbreAudio", "inputs": {"conditioning": ["94", 0], "latent": ["121", 0]}}
    w["123"] = {"class_type": "ReferenceTimbreAudio", "inputs": {"conditioning": ["47", 0], "latent": ["121", 0]}}
    w["3"]["inputs"]["positive"] = ["122", 0]
    w["3"]["inputs"]["negative"] = ["123", 0]
    return w


@app.cls(
    image=image,
    gpu=GPU,
    volumes={MODELS_DIR: vol},
    timeout=1800,
    scaledown_window=30,  # GPU ワーカーの標準（CLAUDE.md §1）。連続で曲を作るときにコールドスタートを避ける
    max_containers=4,
    # 本番のジョブ（run_job）: generation_jobs の更新・返金（Supabase）と、曲の置き場所（R2）。
    secrets=[modal.Secret.from_name("supabase-model-downloads"), modal.Secret.from_name("r2-artifacts")],
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
        """曲を 1 本作って FLAC のバイト列と所要時間を返す（試作用。本番は run_job）。"""
        res = self._make_song(params)
        res["audio"] = pathlib.Path(res.pop("path")).read_bytes()
        return res

    def _make_song(self, params: dict) -> dict:
        """曲を 1 本作り、仕上げた FLAC の置き場所（path）と所要時間を返す。"""
        import uuid

        import requests

        params = prepare_params(params)
        workflow = build_workflow(params)
        if params.get("ref_audio"):
            ref_name = f"ref_{uuid.uuid4().hex[:8]}.flac"
            pathlib.Path(COMFY_DIR, "input").mkdir(parents=True, exist_ok=True)
            pathlib.Path(COMFY_DIR, "input", ref_name).write_bytes(params["ref_audio"])
            workflow = add_reference_audio(workflow, ref_name)
        out_dir = pathlib.Path(COMFY_DIR, "output")
        pre = {str(p) for p in out_dir.rglob("*") if p.is_file()}
        t = time.time()
        r = requests.post(
            f"http://127.0.0.1:{COMFY_PORT}/prompt",
            json={"prompt": workflow, "client_id": str(uuid.uuid4())},
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
        print(
            f"[ace] {params['seconds']}s ({'auto' if params['auto_seconds'] else 'fixed'}) song in {elapsed}s "
            f"(boot {self.boot_s}s) -> {info}",
            flush=True,
        )
        return {
            "path": finished,
            "filename": pathlib.Path(finished).name,
            "elapsed_s": elapsed,
            "boot_s": self.boot_s,
            # GPU の名前はコンテナでは分からない（env が届かない）ので、手元の main が渡したものを返す。
            "gpu": params.get("gpu") or GPU,
            "dit": params.get("dit") or "sft",
            "seconds": params["seconds"],
            "auto_seconds": params["auto_seconds"],
            **info,
        }


    @modal.method()
    def run_job(self, job: dict) -> dict:
        """本番（2026-10-06）: 同じ曲調・歌詞でシードを変えて count 曲を作り、MP3 で R2 へ上げて generation_jobs を completed に。
        job: job_id / user_id / credits_cost / count / seed / params（tags・lyrics・bpm・keyscale・language・timesignature）。
        1 曲でも失敗したら failed にして全額返金（途中まで出来た曲は使わない＝課金と結果を一致させる）。"""
        job_id, user_id = job["job_id"], job["user_id"]
        count = max(1, min(10, int(job.get("count", 3))))
        seed = int(job.get("seed", 1))
        _patch_job(job_id, {"status": "processing", "started_at": _now_iso(), "progress_message": f"0/{count} 曲"})
        try:
            import ull_r2

            if not ull_r2.r2_enabled():
                raise RuntimeError("R2 is not enabled")
            rels, key_map, songs = [], {}, []
            for k in range(count):
                res = self._make_song({**job["params"], "seed": seed + k, "dit": "sft"})
                mp3 = res["path"].replace(".flac", ".mp3")
                r = subprocess.run(
                    ["ffmpeg", "-v", "error", "-y", "-i", res["path"], "-c:a", "libmp3lame", "-b:a", "256k", mp3],
                    capture_output=True, text=True,
                )
                if r.returncode != 0:
                    raise RuntimeError(f"mp3 encode failed: {r.stderr[-500:]}")
                rel = f"song_results/{user_id}/{job_id}_{k + 1}.mp3"
                key = ull_r2.key_for_rel(rel, user_id)
                ull_r2.put_file(mp3, key, content_type="audio/mpeg")
                rels.append(rel)
                key_map[rel] = key
                songs.append({"seed": seed + k, "seconds": res["final_s"], "elapsed_s": res["elapsed_s"]})
                _patch_job(job_id, {
                    "progress_message": f"{k + 1}/{count} 曲",
                    "progress_percent": int((k + 1) * 100 / count),
                    "metadata": {"vram_used_gb": _vram_used_gb()},
                })
            meta = {
                "gpu_tier": job.get("gpu_label") or GPU,
                "audio_paths": rels,
                "songs": songs,
                "r2_keys": list(rels),  # ull_r2.stamp_r2_keys と同じく rel パス（実キーは r2_key_map）
                "r2_key_map": key_map,
                "artifact_store": "r2",
                "boot_s": self.boot_s,
            }
            gb = _vram_used_gb()
            if gb is not None:
                meta["vram_used_gb"] = gb
            _patch_job(job_id, {"status": "completed", "completed_at": _now_iso(), "progress_percent": 100, "metadata": meta})
            print(f"[song] job {job_id[:8]} done: {count} song(s)", flush=True)
            return {"ok": True, "count": count}
        except Exception as exc:
            print(f"[song] job {job_id[:8]} failed: {exc!r}", flush=True)
            _patch_job(job_id, {
                "status": "failed",
                "error_message": str(exc)[:2000],
                "completed_at": _now_iso(),
                "metadata": {"gpu_tier": job.get("gpu_label") or GPU, "refunded": True},
            })
            _refund(user_id, int(job.get("credits_cost") or 0))
            raise


# --- 本番の受け口（2026-10-06）-------------------------------------------------------------------
def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _sb(method: str, path: str, **kw):
    """Supabase（service role）。失敗は呼び出し側で扱う。"""
    import requests

    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("Supabase env not configured")
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", **kw.pop("headers", {})}
    return requests.request(method, f"{url}{path}", headers=headers, timeout=10, **kw)


def _patch_job(job_id: str, fields: dict) -> None:
    """generation_jobs の 1 行を更新（3 回まで再試行・失敗しても止めない）。"""
    for attempt in range(3):
        try:
            r = _sb("PATCH", "/rest/v1/generation_jobs", params={"id": f"eq.{job_id}"},
                    json={**fields, "updated_at": _now_iso()}, headers={"Prefer": "return=minimal"})
            if r.ok:
                return
            print(f"[song] patch {job_id[:8]} HTTP {r.status_code}: {r.text[:200]}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[song] patch {job_id[:8]} failed: {exc!r}", flush=True)
        time.sleep(0.6 * (attempt + 1))


def _refund(user_id: str, amount: int) -> None:
    """失敗したジョブの全額返金（読んでから足す。Director のワーカーと同じ作法）。"""
    if not user_id or amount <= 0:
        return
    try:
        rows = _sb("GET", "/rest/v1/profiles", params={"id": f"eq.{user_id}", "select": "credits"}).json()
        current = (rows[0].get("credits") if rows else None) or 0
        _sb("PATCH", "/rest/v1/profiles", params={"id": f"eq.{user_id}"}, json={"credits": current + amount},
            headers={"Prefer": "return=minimal"})
    except Exception as exc:  # noqa: BLE001
        print(f"[song] refund {amount} to {user_id[:8]} failed: {exc!r}", flush=True)


def _vram_used_gb():
    """Active VRAM バッジ用（全系統 vram_used_gb で統一、CLAUDE.md §6-3）。"""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True
        ).stdout.strip().splitlines()
        return round(float(out[0]) / 1024, 1) if out else None
    except Exception:  # noqa: BLE001
        return None


@app.function(image=image, cpu=1, memory=1024, scaledown_window=2, secrets=[modal.Secret.from_name("wan-animate-auth")])
@modal.fastapi_endpoint(method="POST")
def song_async(item: dict, request: fastapi.Request):
    """Next.js から呼ぶ受け口（GPU なし）: 認証して run_job を spawn し、すぐ返す。"""
    import hmac

    expected = os.environ.get("MODAL_AUTH_TOKEN", "")
    provided = request.headers.get("x-modal-secret") or ""
    if not expected or not hmac.compare_digest(provided, expected):
        raise fastapi.HTTPException(status_code=401, detail="Unauthorized")
    if not item.get("job_id") or not item.get("user_id") or not isinstance(item.get("params"), dict):
        raise fastapi.HTTPException(status_code=400, detail="job_id / user_id / params are required")
    call = AceStep().run_job.spawn({**item, "gpu_label": GPU})
    return {"ok": True, "job_id": item["job_id"], "call_id": call.object_id}


@app.local_entrypoint()
def main(out_dir: str = "./ace_out", seconds: float = 0.0, seed: int = 1, workflow: str = "", count: int = 1, ref: str = ""):
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
        "gpu": GPU,
        **({"ref_audio": pathlib.Path(ref).read_bytes()} if ref else {}),
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
