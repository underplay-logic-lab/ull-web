"use client";

// 360 度パノラマ（正距円筒）を見回す軽い表示（2026-10-10・背景づくり用）。三次元の部品は使わず、canvas で 1 画素ずつ引き当てる。
// ドラッグで向きを変える。画角は 80 度に固定（2026-10-10 ホスト「画角は無い方が良い・画質が悪くなるだけ」。8192 幅のパノラマで
// 80 度を 1920 幅に切り出すとほぼ等倍）。「この向きで保存」は同じ計算を 1920×1080 でやり直して PNG にする。
// パノラマ 1 枚から切り出すので、どの向きでも部屋の物の位置は一致する（統一感の確認がこの表示の目的）。

import { useCallback, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";

type View = { yaw: number; pitch: number; fov: number };
const FOV = 80;

/** 正距円筒の画素（src）から、向き view の透視投影を out（w×h）に描く。最近傍で十分（保存時は大きく描くので粗さは出ない）。 */
function renderPerspective(src: ImageData, out: ImageData, view: View) {
  const { width: W, height: H, data: s } = src;
  const { width: w, height: h, data: d } = out;
  const f = (0.5 * w) / Math.tan((view.fov * Math.PI) / 360);
  const cy = Math.cos((view.yaw * Math.PI) / 180);
  const sy = Math.sin((view.yaw * Math.PI) / 180);
  const cp = Math.cos((view.pitch * Math.PI) / 180);
  const sp = Math.sin((view.pitch * Math.PI) / 180);
  let o = 0;
  for (let j = 0; j < h; j++) {
    const y0 = j - h / 2;
    for (let i = 0; i < w; i++) {
      const x0 = i - w / 2;
      const n = Math.hypot(x0, y0, f);
      const x = x0 / n;
      const y = y0 / n;
      const z = f / n;
      // 上下（pitch）→ 左右（yaw）の順に回す
      const y1 = y * cp - z * sp;
      const z1 = y * sp + z * cp;
      const x2 = x * cy + z1 * sy;
      const z2 = -x * sy + z1 * cy;
      const lon = Math.atan2(x2, z2);
      const lat = Math.asin(Math.max(-1, Math.min(1, y1)));
      let u = Math.floor((lon / (2 * Math.PI) + 0.5) * W) % W;
      if (u < 0) u += W;
      const v = Math.min(H - 1, Math.max(0, Math.floor((lat / Math.PI + 0.5) * (H - 1))));
      const p = (v * W + u) * 4;
      d[o] = s[p];
      d[o + 1] = s[p + 1];
      d[o + 2] = s[p + 2];
      d[o + 3] = 255;
      o += 4;
    }
  }
}

export function PanoramaViewer({ src, filenameBase, onError }: { src: string; filenameBase: string; onError?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pixelsRef = useRef<ImageData | null>(null);
  const [view, setView] = useState<View>({ yaw: 0, pitch: 0, fov: FOV });
  const [ready, setReady] = useState(false);
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);

  // パノラマを読み込み、画素を取り出しておく（署名 URL は別オリジンなので crossOrigin を付ける。R2 の CORS は GET 許可済み）。
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!alive) return;
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      pixelsRef.current = ctx.getImageData(0, 0, c.width, c.height);
      setReady(true);
    };
    img.onerror = () => alive && onError?.();
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src, onError]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const px = pixelsRef.current;
    if (!canvas || !px || !ready) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const out = ctx.createImageData(canvas.width, canvas.height);
    renderPerspective(px, out, view);
    ctx.putImageData(out, 0, 0);
  }, [view, ready]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const canvas = canvasRef.current;
    if (!d || !canvas) return;
    const k = view.fov / canvas.getBoundingClientRect().width; // 画面 1px あたりの角度
    setView((v) => ({
      ...v,
      yaw: d.yaw - (e.clientX - d.x) * k,
      pitch: Math.max(-85, Math.min(85, d.pitch - (e.clientY - d.y) * k)),
    }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const saveView = useCallback(() => {
    const px = pixelsRef.current;
    if (!px) return;
    const c = document.createElement("canvas");
    c.width = 1920;
    c.height = 1080;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const out = ctx.createImageData(c.width, c.height);
    renderPerspective(px, out, view);
    ctx.putImageData(out, 0, 0);
    c.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filenameBase}_yaw${Math.round(((view.yaw % 360) + 360) % 360)}_pitch${Math.round(view.pitch)}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }, "image/png");
  }, [view, filenameBase]);

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        width={960}
        height={540}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="w-full cursor-grab touch-none rounded-lg bg-black active:cursor-grabbing"
      />
      {!ready && <p className="text-center text-[11px] text-muted">読み込み中…</p>}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
        <button
          type="button"
          onClick={() => setView({ yaw: 0, pitch: 0, fov: FOV })}
          className="rounded-md border border-border px-2 py-1 text-foreground hover:bg-surface-hover"
        >
          正面に戻す
        </button>
        <button
          type="button"
          onClick={saveView}
          disabled={!ready}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-foreground hover:bg-surface-hover disabled:opacity-50"
        >
          <Download size={12} />
          この向きで保存（1920×1080）
        </button>
      </div>
      <p className="text-[11px] text-muted">ドラッグで見回せます（ぐるっと一周つながっています）。</p>
    </div>
  );
}
