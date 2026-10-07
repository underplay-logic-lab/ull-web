"""動画の部分修正（2026-10-07〜）の前後処理: 元の動画を整える → 作り直す窓を切り出す → 結果を元の動画に貼り戻す。

ComfyUI で処理するのは「窓」だけ（作り直す区間＋前の助走＋後ろの余白）。窓の中では残す部分の潜在をマスク 0 で
そのまま残し（comfy_nodes/ull_time_mask）、作り直す区間とのつなぎ目は潜在の中でなじませる。貼り戻しの切れ目は
窓の「残す部分」の中に置くので、そこは元と同じ絵（差は VAE を往復した分だけ）。

GPU を使わない純粋な処理（ffmpeg / ffprobe）だけ。Director ワーカー（modal_wan_animate_blackwell.py）から呼ぶ。
手元でも `python ull_video_fix.py <動画> <開始秒>` で窓の計算と切り出し・貼り戻しを試せる（窓の結果の代わりに切り出した窓をそのまま使う）。
"""
from __future__ import annotations

import json
import math
import subprocess

FPS = 24
CANVAS_MULTIPLE = 32  # nodes_minimax_h3.CANVAS_MULTIPLE（縦横は 32 の倍数）
# 残す側の切れ目を、作り直す区間からこれだけ離す（境目の潜在 1〜2 コマ＝最大 7 フレームより外）
SPLICE_MARGIN_FRAMES = 12


def align_frame_count(n: int) -> int:
    """nodes_minimax_h3.align_frame_count と同じ（17k+5 に切り上げ）。"""
    n = max(5, n)
    while n % 17 != 5:
        n += 1
    return n


def _run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed ({p.returncode}): {p.stderr[-1500:]}")
    return p.stdout


def probe(path: str) -> dict:
    out = json.loads(_run([
        "ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path,
    ]))
    v = next((s for s in out["streams"] if s.get("codec_type") == "video"), None)
    if v is None:
        raise ValueError("動画の映像が読めませんでした")
    has_audio = any(s.get("codec_type") == "audio" for s in out["streams"])
    duration = float(out["format"].get("duration") or v.get("duration") or 0)
    return {"width": int(v["width"]), "height": int(v["height"]), "duration": duration, "has_audio": has_audio}


def safe_dims(w: int, h: int, max_pixels: int) -> tuple[int, int]:
    """縦横比を保ち max_pixels 以下で 32 の倍数に（拡大はしない）。"""
    scale = min(1.0, math.sqrt(max_pixels / max(1, w * h)))
    snap = lambda n: max(CANVAS_MULTIPLE, int(n * scale) // CANVAS_MULTIPLE * CANVAS_MULTIPLE)  # noqa: E731
    return snap(w), snap(h)


def normalize(src: str, dst: str, max_pixels: int, max_seconds: float) -> dict:
    """24fps 固定・縦横 32 の倍数・音声 48kHz ステレオ（無音の動画には無音を付ける）にそろえる。
    Director の出力（既に 24fps・32 の倍数）は寸法が変わらない。"""
    info = probe(src)
    if info["duration"] > max_seconds + 0.5:
        raise ValueError(f"動画が長すぎます（{info['duration']:.1f} 秒・上限 {max_seconds:.0f} 秒）")
    w, h = safe_dims(info["width"], info["height"], max_pixels)
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", src]
    if not info["has_audio"]:
        cmd += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
    cmd += [
        "-vf", f"fps={FPS},scale={w}:{h}:flags=lanczos,format=yuv420p",
        "-map", "0:v:0", "-map", "0:a:0" if info["has_audio"] else "1:a:0",
        "-c:v", "libx264", "-preset", "medium", "-crf", "14",
        "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2",
        "-shortest", "-movflags", "+faststart", dst,
    ]
    _run(cmd)
    frames = count_frames(dst)
    return {"width": w, "height": h, "frames": frames, "had_audio": info["has_audio"]}


def count_frames(path: str) -> int:
    out = _run([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
        "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path,
    ])
    return int(out.strip().split(",")[0])


def plan_window(
    total_frames: int,
    start_s: float,
    end_s: float | None,
    max_window_s: float,
    preroll_s: float = 3.0,
    postroll_s: float = 2.0,
    seam_start: str = "blend",
    seam_end: str = "blend",
) -> dict:
    """作り直す区間 [rs, re) と、ComfyUI で処理する窓 [ws, ws+frames) を決める（フレーム単位）。

    - 窓は 17k+5 フレーム（モデルの長さの刻み）。動画の末尾を越える分は最後のコマを伸ばして埋め、貼り戻しで捨てる。
    - 窓が max_window_s を超えるなら、作り直す区間の終わりを手前に詰める（残りは元のまま・後ろの境目も潜在でなじむ）。
    - 貼り戻しの切れ目 cut_a / cut_b は区間から SPLICE_MARGIN_FRAMES 離した「残す部分」の中。
    - seam_start / seam_end = "cut" はその側に元の映像を渡さない（助走・余白なし）＝新しいショットとして作り、境目は映画のカットになる。
      終わり側のカットは、窓が 17k+5 に切り上がって区間の後ろへはみ出した分も作り直し（マスク 1）、貼り戻しで捨てる。
    """
    n = total_frames
    if n < FPS:
        raise ValueError("動画が短すぎます（1 秒以上）")
    rs = int(round(start_s * FPS))
    if rs < 0 or rs >= n - 1:
        raise ValueError(f"開始秒が動画の長さ（{n / FPS:.1f} 秒）の範囲外です")
    re = n if end_s is None or end_s < 0 else min(n, int(round(end_s * FPS)))
    if re <= rs:
        raise ValueError("終了秒は開始秒より後にしてください")
    if seam_start not in ("blend", "cut") or seam_end not in ("blend", "cut"):
        raise ValueError("seam must be 'blend' or 'cut'")
    pre_f = 0 if seam_start == "cut" else int(round(preroll_s * FPS))
    post_f = 0 if seam_end == "cut" else int(round(postroll_s * FPS))
    max_f = int(max_window_s * FPS)
    ws = max(0, rs - pre_f)
    while True:
        we = n if re == n else min(n, re + post_f)
        frames = align_frame_count(we - ws)
        if frames <= max_f or re - rs <= FPS:
            break
        re = rs + max(FPS, (re - rs) - (frames - max_f) - 1)  # 区間を詰めて末尾を残す側へ
    if frames > max_f:
        raise ValueError("作り直す区間が短すぎるか窓の上限が小さすぎます")
    pad = max(0, ws + frames - n)
    to_end = re == n
    end_cut = seam_end == "cut" and not to_end
    return {
        "total_frames": n,
        "regen_start": rs,
        "regen_end": re,
        "to_end": to_end,
        "win_start": ws,
        "win_frames": frames,
        "pad_frames": pad,
        # ComfyUI の窓の中での秒（ULLVideoTimeMask / ULLH3AudioTimeMask に渡す）
        "rel_start_s": (rs - ws) / FPS,
        "rel_end_s": -1.0 if to_end or end_cut else (re - ws) / FPS,
        "win_seconds": frames / FPS,
        "seam_start": seam_start,
        "seam_end": "cut" if end_cut else "blend",
        "cut_a": rs if seam_start == "cut" else max(ws, rs - SPLICE_MARGIN_FRAMES),
        "cut_b": n if to_end else re if end_cut else min(ws + frames - pad, re + SPLICE_MARGIN_FRAMES),
    }


def detect_cuts(path: str, plan: dict, threshold: float = 0.12) -> list[float]:
    """貼り戻した動画の、作り直した区間の中にあるカット（場面の急な切り替わり）の秒を返す。
    「カット」を選んだ境目そのもの（前後 2 フレーム）は意図したものなので数えない。
    2026-10-07 の試験: 終了点が元の動きと食い違うと、モデルが区間の中にカットを入れて帳尻を合わせた（scene 0.15 超）。
    うまくいった 3 本は 0.10 でも 0 件。"""
    out = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", path, "-an", "-vf", f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    ).stderr
    a, b = plan["cut_a"], plan["cut_b"]
    skip = []
    if plan.get("seam_start") == "cut":
        skip.append(a)
    if plan.get("seam_end") == "cut":
        skip.append(b)
    cuts = []
    for line in out.splitlines():
        if "pts_time:" not in line:
            continue
        t = float(line.split("pts_time:")[1].split()[0])
        f = int(round(t * FPS))
        if a <= f <= b and not any(abs(f - s) <= 2 for s in skip):
            cuts.append(round(t, 2))
    return cuts


def cut_window(norm: str, plan: dict, out_video: str, out_audio: str, out_ref_png: str) -> None:
    """窓を切り出す（映像は無音の mp4、音声は wav）。参照用に作り直しの直前のコマも png で書き出す。"""
    ws, frames, pad = plan["win_start"], plan["win_frames"], plan["pad_frames"]
    t0, dur = ws / FPS, frames / FPS
    vf = f"trim=start_frame={ws}:end_frame={ws + frames - pad},setpts=PTS-STARTPTS"
    if pad:
        vf += f",tpad=stop_mode=clone:stop={pad}"
    _run(["ffmpeg", "-y", "-v", "error", "-i", norm, "-vf", vf, "-an",
          "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p", out_video])
    _run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t0:.6f}", "-i", norm, "-vn",
          "-af", f"apad=whole_dur={dur:.6f}", "-t", f"{dur:.6f}", "-ar", "48000", "-ac", "2", out_audio])
    ref_f = max(0, plan["regen_start"] - 1)
    _run(["ffmpeg", "-y", "-v", "error", "-i", norm, "-vf", f"select=eq(n\\,{ref_f})", "-frames:v", "1", out_ref_png])


def splice(norm: str, window_out: str, plan: dict, keep_audio: bool, dst: str) -> None:
    """元の動画[0, cut_a) ＋ 窓の結果[cut_a, cut_b) ＋ 元の動画[cut_b, 終わり) をつなぐ。
    keep_audio なら音声は元の動画のまま通す（窓の結果の音声は使わない）。"""
    ws, a, b, n = plan["win_start"], plan["cut_a"], plan["cut_b"], plan["total_frames"]
    parts_v, parts_a, labels = [], [], []
    segs = []
    if a > 0:
        segs.append((0, 0, a))
    segs.append((1, a - ws, b - ws))
    if b < n:
        segs.append((0, b, n))
    for i, (src, f0, f1) in enumerate(segs):
        parts_v.append(f"[{src}:v]trim=start_frame={f0}:end_frame={f1},setpts=PTS-STARTPTS[v{i}]")
        if not keep_audio:
            parts_a.append(
                f"[{src}:a]atrim=start={f0 / FPS:.6f}:end={f1 / FPS:.6f},asetpts=PTS-STARTPTS,"
                f"aresample=48000,aformat=channel_layouts=stereo[a{i}]"
            )
            labels.append(f"[v{i}][a{i}]")
        else:
            labels.append(f"[v{i}]")
    k = len(segs)
    if keep_audio:
        fc = ";".join(parts_v) + ";" + "".join(labels) + f"concat=n={k}:v=1:a=0[v]"
        maps = ["-map", "[v]", "-map", "0:a:0", "-c:a", "copy"]
    else:
        fc = ";".join(parts_v + parts_a) + ";" + "".join(labels) + f"concat=n={k}:v=1:a=1[v][a]"
        maps = ["-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "256k"]
    _run(["ffmpeg", "-y", "-v", "error", "-i", norm, "-i", window_out, "-filter_complex", fc, *maps,
          "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
          "-r", str(FPS), "-frames:v", str(n), "-movflags", "+faststart", dst])


if __name__ == "__main__":  # 手元の確認用
    import os
    import sys
    import tempfile

    src, start = sys.argv[1], float(sys.argv[2])
    end = float(sys.argv[3]) if len(sys.argv) > 3 else None
    d = tempfile.mkdtemp(prefix="vfix_")
    norm = os.path.join(d, "norm.mp4")
    info = normalize(src, norm, max_pixels=960 * 544, max_seconds=600)
    plan = plan_window(info["frames"], start, end, max_window_s=25)
    print(json.dumps({**info, **plan}, ensure_ascii=False, indent=1))
    win_v, win_a, ref = (os.path.join(d, x) for x in ("win.mp4", "win.wav", "ref.png"))
    cut_window(norm, plan, win_v, win_a, ref)
    print("window frames:", count_frames(win_v), "audio:", _run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", win_a]).strip())
    # 窓の結果の代わりに、窓の映像＋音声をそのまま混ぜたものを貼り戻す（つなぎ目のずれが無いかの確認）
    fake = os.path.join(d, "fake_out.mp4")
    _run(["ffmpeg", "-y", "-v", "error", "-i", win_v, "-i", win_a, "-c:v", "copy", "-c:a", "aac", "-shortest", fake])
    for keep in (True, False):
        out = os.path.join(d, f"spliced_keep{int(keep)}.mp4")
        splice(norm, fake, plan, keep, out)
        print(out, count_frames(out), "frames", f"{probe(out)['duration']:.3f}s")
