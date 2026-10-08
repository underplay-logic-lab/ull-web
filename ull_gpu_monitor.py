"""
ull_gpu_monitor.py — ULL Studio 共通の GPU 監視（2026-10-08 導入）。

CLAUDE.md §1「時間のかかる GPU ジョブには、GPU 使用率・VRAM を定期的にログへ出す監視スレッドを標準で仕込む」と
§6「非同期は完了時に vram_peak_gb を残す」を全ワーカーで同じ形にするための部品。
2026-10-08 に Director（modal_wan_animate_blackwell.py）がピークを残しておらず、1MP×68 秒のピーク（約 213GB）を
Modal のダッシュボードで目で読むしかなかったのがきっかけ。

使い方（GPU ジョブの本体を囲む）:
    from ull_gpu_monitor import GpuMonitor
    with GpuMonitor("director") as mon:
        ...                       # 生成
    result["vram_peak_gb"] = mon.peak_gb

- 10 秒ごとに 1 行: `[gpu_monitor] director t=123s util=97% vram=152.3GB peak=213.0GB temp=68C`
- ピークは 1 秒ごとに見る（デバイス全体の使用量＝ComfyUI などの子プロセスの分も入る）。
- nvidia-smi だけを使う（torch を呼ぶと親プロセスに CUDA の文脈が作られ VRAM を余計に使うため）。
- 監視は best-effort。nvidia-smi が無い・失敗しても本体は止めない（peak_gb は None のまま）。

各 Modal image への添付:
    image = image.add_local_python_source("ull_gpu_monitor")
"""

from __future__ import annotations

import subprocess
import threading
import time

_QUERY = "utilization.gpu,memory.used,temperature.gpu"


def _sample() -> tuple[int, float, int] | None:
    """(使用率 %, 使用中 VRAM GB, 温度 C)。複数 GPU なら合計／最大。取れなければ None。"""
    try:
        out = subprocess.run(
            ["nvidia-smi", f"--query-gpu={_QUERY}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        ).stdout
    except Exception:  # noqa: BLE001 — 監視は止めない
        return None
    rows = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 3:
            continue
        try:
            rows.append((int(float(parts[0])), float(parts[1]) / 1024, int(float(parts[2]))))
        except ValueError:
            continue
    if not rows:
        return None
    return max(r[0] for r in rows), sum(r[1] for r in rows), max(r[2] for r in rows)


class GpuMonitor:
    def __init__(self, tag: str = "", log_every: float = 10.0, sample_every: float = 1.0):
        self.tag = tag
        self.log_every = log_every
        self.sample_every = sample_every
        self.peak_gb: float | None = None
        self._stop = threading.Event()
        self._thr: threading.Thread | None = None
        self._t0 = 0.0

    def _note(self, s):
        if s is not None and (self.peak_gb is None or s[1] > self.peak_gb):
            self.peak_gb = round(s[1], 1)

    def _loop(self):
        last_log = 0.0
        while not self._stop.wait(self.sample_every):
            s = _sample()
            self._note(s)
            now = time.time() - self._t0
            if s is not None and now - last_log >= self.log_every:
                last_log = now
                print(
                    f"[gpu_monitor] {self.tag} t={now:.0f}s util={s[0]}% vram={s[1]:.1f}GB "
                    f"peak={self.peak_gb}GB temp={s[2]}C",
                    flush=True,
                )

    def __enter__(self) -> "GpuMonitor":
        self._t0 = time.time()
        self._note(_sample())
        self._thr = threading.Thread(target=self._loop, name=f"gpu-monitor-{self.tag}", daemon=True)
        self._thr.start()
        return self

    def __exit__(self, *_exc) -> bool:
        self._stop.set()
        if self._thr:
            self._thr.join(timeout=10)
        self._note(_sample())
        print(f"[gpu_monitor] {self.tag} done t={time.time() - self._t0:.0f}s peak={self.peak_gb}GB", flush=True)
        return False
