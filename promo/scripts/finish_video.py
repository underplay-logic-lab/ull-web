# 操作動画の仕上げ: 書き出した部分（クリック音だけ入り）をつなぎ、共通の BGM を 1 本通しで重ねる（2026-10-02）。
# 部分ごとに BGM を付けると、つなぎ目で曲が頭から鳴り直してフェードも入るため、BGM は最後にまとめて敷く。
# 部分は edit.json の "bgm": null で、4K（--scale=2 --crf=16）で書き出しておく:
#   npx remotion render Tutorial out/a.mp4 --props='{"session":"<名前>"}' --scale=2 --crf=16
#   python scripts/finish_video.py out/<完成>.mp4 out/a.mp4 [out/b.mp4 ...]
# Remotion 同梱の ffmpeg にはフェード等のフィルタが無いので、音の重ね合わせは numpy で行う。
import pathlib
import subprocess
import sys

import numpy as np
import soundfile as sf

ROOT = pathlib.Path(__file__).resolve().parent.parent
BGM = ROOT / "public" / "audio" / "bgm.wav"
BGM_VOLUME = 0.22
FADE_IN, FADE_OUT = 1.5, 2.5


def ff(*args):
    subprocess.run(["npx", "remotion", "ffmpeg", "-v", "error", "-y", *args], cwd=ROOT, check=True, shell=sys.platform == "win32")


def main(out, *parts):
    tmp = ROOT / "out" / "_finish"
    tmp.mkdir(parents=True, exist_ok=True)
    lst = tmp / "concat.txt"
    lst.write_text("".join(f"file '{(ROOT / p).resolve().as_posix()}'\n" for p in parts), encoding="utf-8")
    joined, clicks, mixed = tmp / "joined.mp4", tmp / "clicks.wav", tmp / "mix.wav"
    ff("-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(joined))
    ff("-i", str(joined), "-vn", "-c:a", "pcm_s16le", "-ar", "48000", str(clicks))

    clk, sr = sf.read(clicks, dtype="float32")
    bgm, bsr = sf.read(BGM, dtype="float32")
    clk = clk if clk.ndim == 2 else np.stack([clk, clk], 1)
    bgm = bgm if bgm.ndim == 2 else np.stack([bgm, bgm], 1)
    if bsr != sr:
        x = np.linspace(0, len(bgm) - 1, int(len(bgm) * sr / bsr))
        bgm = np.stack([np.interp(x, np.arange(len(bgm)), bgm[:, c]) for c in range(2)], 1).astype("float32")
    n = len(clk)
    b = np.concatenate([bgm] * int(np.ceil(n / len(bgm))))[:n] * BGM_VOLUME
    t = np.arange(n) / sr
    fade = np.minimum(np.clip(t / FADE_IN, 0, 1), np.clip((n / sr - t) / FADE_OUT, 0, 1))[:, None]
    sf.write(mixed, np.clip(clk + b * fade, -1, 1), sr, subtype="PCM_16")

    ff("-i", str(joined), "-i", str(mixed), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
       "-shortest", str(ROOT / out))
    print(f"保存: {out}（{n / sr:.1f} 秒）")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("使い方: python scripts/finish_video.py out/<完成>.mp4 out/a.mp4 [out/b.mp4 ...]")
    main(sys.argv[1], *sys.argv[2:])
