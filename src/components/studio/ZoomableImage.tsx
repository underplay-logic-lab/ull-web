"use client";

// 拡大表示の中でさらにズームして細部を見る（2026-09-29 ホスト要望「アップで詳細を見たい」）。
// ホイール＝カーソル位置を中心にズーム／クリック＝等倍⇔3 倍／ドラッグ＝移動／2 本指＝ピンチ／+ − 0 キー。
// keepView（2026-10-03 ホスト指摘「候補を切り替えるたびに寄り直すので似ているか比べにくい」）: 画像を替えても
// 倍率と位置を保つ。同じ構図の候補を ← → で見比べると、顔が同じ場所に出る。

import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";

const MIN = 1;
const MAX = 8;
const CLICK_ZOOM = 3;

type View = { s: number; x: number; y: number };
const RESET: View = { s: 1, x: 0, y: 0 };

export function ZoomableImage({
  src,
  alt,
  onError,
  keepView = false,
}: {
  src: string;
  alt: string;
  onError?: () => void;
  keepView?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(RESET);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  // 画像が替わったら等倍に戻す（keepView なら保つ）。
  const [shownSrc, setShownSrc] = useState(src);
  if (shownSrc !== src) {
    setShownSrc(src);
    if (!keepView) setView(RESET);
  }

  /** 容器の中心からの相対座標 (px, py) を動かさずに倍率を s2 にする。 */
  const zoomAt = useCallback((s2: number, px: number, py: number) => {
    setView((v) => {
      const s = Math.min(MAX, Math.max(MIN, s2));
      if (s === MIN) return RESET;
      const k = s / v.s;
      return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);

  const relPoint = (clientX: number, clientY: number) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return { px: 0, py: 0 };
    return { px: clientX - (r.left + r.width / 2), py: clientY - (r.top + r.height / 2) };
  };

  // ホイールは passive だと preventDefault できないので自前で付ける。
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - (r.left + r.width / 2);
      const py = e.clientY - (r.top + r.height / 2);
      zoomAt(viewRef.current.s * Math.exp(-e.deltaY * 0.0015), px, py);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "+" || e.key === "=") zoomAt(viewRef.current.s * 1.5, 0, 0);
      else if (e.key === "-") zoomAt(viewRef.current.s / 1.5, 0, 0);
      else if (e.key === "0") setView(RESET);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomAt]);

  // ドラッグ（1 本）とピンチ（2 本）。動かさずに離したらクリック扱いで等倍⇔3 倍。
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  // 動かしたかは押した位置からの累計で見る（2026-10-03: 1 回の移動量で見ていたため、ゆっくりドラッグすると
  // 毎回 2px 未満で「動かしていない」扱いになり、離した瞬間クリックとして等倍に戻っていた）。
  const gesture = useRef<{ moved: boolean; pinchDist: number | null; startX: number; startY: number }>({
    moved: false,
    pinchDist: null,
    startX: 0,
    startY: 0,
  });

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = { moved: false, pinchDist: null, startX: e.clientX, startY: e.clientY };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      gesture.current.moved = true;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, cur);
    if (pointers.current.size === 2 && gesture.current.pinchDist) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const { px, py } = relPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
      zoomAt(viewRef.current.s * (d / gesture.current.pinchDist), px, py);
      gesture.current.pinchDist = d;
      return;
    }
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    if (Math.abs(cur.x - gesture.current.startX) + Math.abs(cur.y - gesture.current.startY) > 4) gesture.current.moved = true;
    if (viewRef.current.s > 1) setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const wasSingle = pointers.current.size === 1;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current.pinchDist = null;
    if (wasSingle && !gesture.current.moved) {
      const { px, py } = relPoint(e.clientX, e.clientY);
      if (viewRef.current.s > 1) setView(RESET);
      else zoomAt(CLICK_ZOOM, px, py);
    }
  };

  const zoomed = view.s > 1;
  return (
    <div className="absolute inset-0">
      <div
        ref={boxRef}
        className={`absolute inset-0 flex touch-none items-center justify-center overflow-hidden p-4 ${
          zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: "center" }}
          onError={onError}
        />
      </div>
      <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/20 bg-black/60 px-1.5 py-1 text-white">
          <button
            type="button"
            onClick={() => zoomAt(view.s / 1.5, 0, 0)}
            disabled={!zoomed}
            aria-label="縮小"
            className="rounded-full p-1 hover:bg-white/10 disabled:opacity-30"
          >
            <Minus size={14} />
          </button>
          <span className="w-12 text-center font-mono text-[11px]">{Math.round(view.s * 100)}%</span>
          <button
            type="button"
            onClick={() => zoomAt(view.s * 1.5, 0, 0)}
            disabled={view.s >= MAX}
            aria-label="拡大"
            className="rounded-full p-1 hover:bg-white/10 disabled:opacity-30"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            onClick={() => setView(RESET)}
            disabled={!zoomed}
            aria-label="全体表示に戻す"
            title="全体表示に戻す（0 キー）"
            className="rounded-full p-1 hover:bg-white/10 disabled:opacity-30"
          >
            <RotateCcw size={13} />
          </button>
        </div>
        <span className="pointer-events-none hidden rounded bg-black/50 px-2 py-0.5 text-[10px] text-white/60 sm:inline">
          ホイール・クリックでズーム／ドラッグで移動
        </span>
      </div>
    </div>
  );
}
