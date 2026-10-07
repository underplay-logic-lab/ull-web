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
  - VAE（音に戻す部分）は公式（2026-10-08 に戻した）。10-06〜07 は ScragVAE（`scragnog/Ace-Step-1.5-ScragVAE`・MIT・rev 0547ba3）。
  - 歌っているかの判定（2026-10-06）: Demucs `htdemucs`（MIT）で声を取り出し、Whisper `openai/whisper-large-v3-turbo`（MIT、
    2026-10-06 確認）で聞き取って歌詞と照合する。fp16（量子化しない）。
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

WHISPER_REPO = "openai/whisper-large-v3-turbo"
WHISPER_REVISION = "41f01f3fe87f28c78e2fbf8b568835947dd65ed9"  # MIT（2026-10-06 確認）
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
    # 歌が入っているかの判定（2026-10-06）: Demucs（htdemucs・MIT）で歌を分けて割合を測る。重みはビルド時に焼く（CPU）。
    # torch / torchaudio は上で入れた cu130 版が条件を満たすので入れ替わらない（入れ替わったら probe で分かる）。
    .pip_install("demucs==4.1.0")
    .run_commands('python -c "from demucs.pretrained import get_model; get_model(\'htdemucs\')"')
    # Whisper（歌詞を歌っているかの判定）と、日本語をひらがなにそろえる pykakasi。重みはビルド時に焼く（CPU）。
    .pip_install("pykakasi")
    .run_commands(
        f'python -c "from huggingface_hub import snapshot_download; snapshot_download(\'{WHISPER_REPO}\', revision=\'{WHISPER_REVISION}\')"'
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
    from demucs.pretrained import get_model

    get_model("htdemucs")  # ビルド時に焼いた重みが読めるか（ネットに取りに行かない）
    import pykakasi  # noqa: F401
    from huggingface_hub import snapshot_download

    snapshot_download(WHISPER_REPO, revision=WHISPER_REVISION, local_files_only=True)  # 焼いた Whisper の重み
    out = {"torch": torch.__version__, "cuda_build": torch.version.cuda, "comfyui": ref, "nodes": nodes, "weights": weights, "demucs": "ok"}
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
# 2026-10-07: 4 → 2。実測で 1 行 ≒ 2 小節（8 行・BPM 108 が 1 分弱で歌い終わる・ひなたの 16 行は 68 秒で歌い切る）。
# 4 小節だと長さが約 2 倍になり、①歌い終わってから長い伴奏が続いて途中で切れる ②**歌が入らない曲が増える**（同じ歌詞・シードで
# 120 秒はほぼ歌なし・75 秒は 8 本すべて歌った。D:/ComfyUI-ull/results/ace_len75/）。2 番 140 秒・3 番 205 秒も全部歌った（ace_parts/）。
LINE_BARS = 2
INTRO_BARS = 4
# 後奏 8 小節（2026-10-06）: 4 小節だと「歌い終わった瞬間に終わる」「無理やり歌い切る」があった（ホスト指摘）。
OUTRO_BARS = 8
# 余裕 1.2 倍（2026-10-06）: 1.1 倍では打ち切りが出た。1.5 倍にしたら、ComfyUI は指定の長さぴったりに設計図を作らせる
# （comfy/text_encoders/ace15.py の min_tokens = max_tokens = 長さ×5）ので、余った長さをサビの繰り返しで埋め、
# 最後の歌の直後に終わった（ホスト指摘）。長さは歌詞の構成（間奏・後奏のタグも数える）で決め、余裕は控えめにする。
DURATION_MARGIN = 1.2
INSTRUMENTAL_BARS = 8  # [Instrumental]（間奏）1 つあたり
MAX_SECONDS = 360.0  # 3 番まで（約 340 秒）が入る長さ（2026-10-06）


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
    interludes = sum(1 for ln in lyrics.splitlines() if ln.strip().lower().startswith("[instrumental"))
    secs = (len(lines) * LINE_BARS + INTRO_BARS + OUTRO_BARS + interludes * INSTRUMENTAL_BARS) * bar_s * DURATION_MARGIN
    return float(min(MAX_SECONDS, max(30, math.ceil(secs / 5) * 5)))


def prepare_params(p: dict) -> dict:
    """seconds が 0・"auto"・未指定なら歌詞から決める。歌詞の最後に [Outro] が無ければ足す（終わり方を作らせる）。"""
    q = dict(p)
    lyrics = str(q.get("lyrics", "")).rstrip()
    # 後奏は「楽器だけ・フェードアウト」と明示する（公式ガイド: タグに説明を足せる `[Chorus - anthemic]`）。
    # 素の [Outro] だと、最後の歌の直後に終わる曲があった（2026-10-06）。
    outro = "[Outro - instrumental, fade out]"
    if lyric_lines(lyrics):
        body = lyrics.splitlines()
        if body and body[-1].strip().lower().startswith("[outro"):
            body[-1] = outro
            lyrics = "\n".join(body)
        else:
            lyrics += f"\n\n{outro}"
    q["lyrics"] = lyrics
    tags = str(q.get("tags", "")).strip()
    # 歌を前に出す（ひなたの曲のタグにあった・2026-10-08 から自動で足す）。
    if "vocal-forward" not in tags.lower():
        tags = f"{tags}, vocal-forward mix" if tags else "vocal-forward mix"
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
    # 末尾の無音のあと、最後の 1 秒未満にだけ小さな音（ノイズ）が残ることがある（2026-10-07、75 秒の曲で 69.8〜74.6 秒が無音・
    # 最後の 0.4 秒だけ音）。それも末尾の無音として切る（ホスト指摘「急に終わって無音が 5 秒くらい続く」）。
    if starts and (len(ends) < len(starts) or ends[-1] >= dur - 1.0):
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


# 歌が入っているか（2026-10-06）: 出来た曲を Demucs（htdemucs）で歌と伴奏に分け、0.5 秒ごとに「歌が伴奏の -12dB 以上」の割合。
# 手元の試作（D:/ComfyUI-ull/tools/vocal_check2.py）で、声の無い曲 0.4%・普通の曲 48% / 73% とはっきり分かれた。
# 30%（2026-10-06）: 10% だとハミングだけの曲（14.6%）が通った（ホスト指摘）。普通に歌った曲は 48〜81%。
VOCAL_MIN_RATIO = 0.30
# 歌詞の一致率（2026-10-06）: 声の割合だけでは全編ハミングを見抜けない（ハミングも「声」）。取り出した声を Whisper で聞き取り、
# 歌詞と両方ひらがな（英語は英字）にして文字 2-gram の一致率を見る。手元の試作（D:/ComfyUI-ull/tools/lyric_check.py）で
# ちゃんと歌った曲 70〜79%・声なし 1.9%・ハミングだけ 1.1%。Whisper は歌の無いところで決まり文句をでっち上げるが歌詞と一致しない。
LYRIC_MIN_MATCH = 0.30
# 作り直しの上限（何番までか別）。長いほど外れが多い（2 番の構成で 6 回中 4 回）。上限まで外れたら一番歌っていた回を残す。
VOCAL_RETRIES = {1: 2, 2: 3, 3: 4}
_DEMUCS = None
_WHISPER = None
_KAKASI = None


def _vocal_stem(path: str):
    """Demucs で声のパートを取り出す: (声のモノラル波形, 元のモノラル波形, サンプルレート)。"""
    import numpy as np
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    global _DEMUCS
    if _DEMUCS is None:
        _DEMUCS = get_model("htdemucs").eval().to("cuda" if torch.cuda.is_available() else "cpu")
    m = _DEMUCS
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "2", "-ar", str(m.samplerate), "-f", "f32le", "-"], capture_output=True
    ).stdout
    wav = torch.from_numpy(np.frombuffer(raw, dtype=np.float32).copy()).view(-1, 2).T
    dev = next(m.parameters()).device
    with torch.no_grad():
        src = apply_model(m, wav[None].to(dev), device=dev, split=True, overlap=0.1)[0].cpu()
    return src[m.sources.index("vocals")].mean(0).numpy(), wav.mean(0).numpy(), m.samplerate


def _normalize_lyrics(text: str, language: str) -> str:
    """照合用に文字をそろえる。日本語はひらがなだけ、それ以外は英字の小文字だけ。"""
    import re

    if language == "ja":
        global _KAKASI
        if _KAKASI is None:
            import pykakasi

            _KAKASI = pykakasi.kakasi()
        text = "".join(x["hira"] for x in _KAKASI.convert(text))
        return re.sub(r"[^ぁ-ゖー]", "", text)
    return re.sub(r"[^a-z]", "", text.lower())


def lyric_match(path: str, lyrics: str, language: str = "ja") -> dict:
    """歌詞を歌っているか: 声の割合（Demucs）と、聞き取った文字と歌詞の一致率（Whisper）。"""
    import numpy as np
    import torch
    from scipy.signal import resample_poly

    voc, mix, sr = _vocal_stem(path)
    win = sr // 2
    n = len(voc) // win
    ratio = 0.0
    if n:
        rest = mix - voc
        v = np.sqrt((voc[: n * win].reshape(n, win) ** 2).mean(1) + 1e-12)
        r = np.sqrt((rest[: n * win].reshape(n, win) ** 2).mean(1) + 1e-12)
        ratio = float((20 * np.log10(v / (r + 1e-9)) > -12).mean())

    global _WHISPER
    if _WHISPER is None:
        from transformers import pipeline

        _WHISPER = pipeline(
            "automatic-speech-recognition",
            model=WHISPER_REPO,
            revision=WHISPER_REVISION,
            torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
            device="cuda" if torch.cuda.is_available() else "cpu",
        )
    v16 = resample_poly(voc, 16000, sr).astype(np.float32)
    out = _WHISPER(
        {"raw": v16, "sampling_rate": 16000},
        chunk_length_s=30,
        batch_size=8,
        generate_kwargs={"language": language, "task": "transcribe"},
    )
    heard = out.get("text", "") if isinstance(out, dict) else ""
    sung = "\n".join(l for l in lyrics.splitlines() if not l.strip().startswith("["))
    ref, got = _normalize_lyrics(sung, language), _normalize_lyrics(heard, language)
    rg = {ref[i : i + 2] for i in range(len(ref) - 1)}
    hg = {got[i : i + 2] for i in range(len(got) - 1)}
    match = len(rg & hg) / max(1, len(rg))
    return {"match": match, "vocal_ratio": ratio, "heard": heard[:200]}


def vocal_ratio(path: str) -> float:
    import numpy as np
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    global _DEMUCS
    if _DEMUCS is None:
        _DEMUCS = get_model("htdemucs").eval().to("cuda" if torch.cuda.is_available() else "cpu")
    m = _DEMUCS
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "2", "-ar", str(m.samplerate), "-f", "f32le", "-"], capture_output=True
    ).stdout
    wav = torch.from_numpy(np.frombuffer(raw, dtype=np.float32).copy()).view(-1, 2).T
    dev = next(m.parameters()).device
    with torch.no_grad():
        src = apply_model(m, wav[None].to(dev), device=dev, split=True, overlap=0.1)[0].cpu()
    voc = src[m.sources.index("vocals")].mean(0).numpy()
    rest = wav.mean(0).numpy() - voc
    win = m.samplerate // 2
    n = len(voc) // win
    if n == 0:
        return 0.0
    v = np.sqrt((voc[: n * win].reshape(n, win) ** 2).mean(1) + 1e-12)
    r = np.sqrt((rest[: n * win].reshape(n, win) ** 2).mean(1) + 1e-12)
    return float((20 * np.log10(v / (r + 1e-9)) > -12).mean())


def build_workflow(p: dict) -> dict:
    """ace_hinata_song_60s.json と同じ組み方。p: tags / lyrics / seconds / bpm / keyscale / language / timesignature / seed。"""
    seconds = float(p.get("seconds", 60))
    seed = int(p.get("seed", 1))
    d = DIT_SETTINGS[p.get("dit") or "sft"]
    return {
        "104": {"class_type": "UNETLoader", "inputs": {"unet_name": d["unet"], "weight_dtype": "default"}},
        # 10-06〜10-07 は ScragVAE（音に厚みがある）だった。Volume には残っている（scripts/ace_scragvae_convert.py で変換したもの）。
        # 2026-10-08: 公式 VAE に戻した（ホスト「シャカシャカした音が減った」・同じ潜在で聴き比べ D:/ComfyUI-ull/results/ace_vae_dit/）。
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
            rels, wav_rels, key_map, songs = [], [], {}, []
            retried = 0
            for k in range(count):
                # 声の無い曲（設計図の段階で歌なしになる外れ）はシードを変えて最大 VOCAL_RETRIES 回まで作り直す（原価はこちら持ち）。
                max_retries = VOCAL_RETRIES.get(int(job.get("parts") or 1), 2)
                best = None
                for attempt in range(max_retries + 1):
                    s_try = seed + k + attempt * 1000
                    # 2026-10-08: SFT → turbo（ホスト「声は明らかに turbo が良い・SFT は AI っぽい妙な高音」。ひなたの曲も turbo＋公式 VAE。
                    # 10-06 に SFT へ替えた理由「まともな曲の割合」は、長さの見積もりが約 2 倍だった影響が大きかった＝LINE_BARS で直した）。
                    r_try = self._make_song({**job["params"], "seed": s_try, "dit": "turbo"})
                    chk = lyric_match(r_try["path"], job["params"].get("lyrics", ""), job["params"].get("language", "ja"))
                    ratio_try = chk["match"]
                    print(
                        f"[song] #{k + 1} seed {s_try} lyric {ratio_try:.1%} vocal {chk['vocal_ratio']:.1%} heard={chk['heard'][:40]!r}",
                        flush=True,
                    )
                    if best is None or ratio_try > best[2]:
                        best = (s_try, r_try, ratio_try, chk)
                    if ratio_try >= LYRIC_MIN_MATCH:
                        break
                    if attempt < max_retries:
                        retried += 1
                s, res, ratio, chk = best
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
                # WAV も（2026-10-06）: 劣化前の FLAC から 48kHz・16bit。MP3 から作ると音質が MP3 のままになるので、ここで作る。
                wav = res["path"].replace(".flac", ".wav")
                r = subprocess.run(
                    ["ffmpeg", "-v", "error", "-y", "-i", res["path"], "-ar", "48000", "-c:a", "pcm_s16le", wav],
                    capture_output=True, text=True,
                )
                if r.returncode != 0:
                    raise RuntimeError(f"wav encode failed: {r.stderr[-500:]}")
                wav_rel = f"song_results/{user_id}/{job_id}_{k + 1}.wav"
                wav_key = ull_r2.key_for_rel(wav_rel, user_id)
                ull_r2.put_file(wav, wav_key, content_type="audio/wav")
                wav_rels.append(wav_rel)
                key_map[wav_rel] = wav_key
                songs.append({
                    "seed": s,
                    "seconds": res["final_s"],
                    "elapsed_s": res["elapsed_s"],
                    "lyric_match": round(ratio, 3),
                    "vocal_ratio": round(chk["vocal_ratio"], 3),
                    "cut_off": res.get("cut_off"),
                })
                _patch_job(job_id, {
                    "progress_message": f"{k + 1}/{count} 曲",
                    "progress_percent": int((k + 1) * 100 / count),
                    "metadata": {"vram_used_gb": _vram_used_gb()},
                })
            meta = {
                "gpu_tier": job.get("gpu_label") or GPU,
                "audio_paths": rels,
                "audio_wav_paths": wav_rels,
                "songs": songs,
                "r2_keys": list(rels) + list(wav_rels),  # ull_r2.stamp_r2_keys と同じく rel パス（実キーは r2_key_map）
                "r2_key_map": key_map,
                "artifact_store": "r2",
                "boot_s": self.boot_s,
                "vocal_retries": retried,
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
