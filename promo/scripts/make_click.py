# 操作動画のクリック音（public/audio/click.wav）を合成する。素材を借りないのでライセンスの心配がない（2026-10-02）。
#   python scripts/make_click.py
import pathlib
import wave

import numpy as np

sr = 48000
n = int(sr * 0.06)
t = np.arange(n) / sr
rng = np.random.default_rng(1)
# マウスのクリックに近い音: ごく短いノイズの立ち上がり＋高めの音の短い減衰
noise = np.diff(rng.standard_normal(n) * np.exp(-t / 0.0015), prepend=0)  # 差分で低域を削る
tone = np.sin(2 * np.pi * 3200 * t) * np.exp(-t / 0.006) * 0.5
body = np.sin(2 * np.pi * 900 * t) * np.exp(-t / 0.012) * 0.25
x = noise * 0.6 + tone + body
x = x / np.max(np.abs(x)) * 0.8
out = pathlib.Path(__file__).resolve().parent.parent / "public" / "audio" / "click.wav"
out.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(out), "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes((x * 32767).astype(np.int16).tobytes())
print(out)
