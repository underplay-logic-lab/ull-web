"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, RotateCcw, X } from "lucide-react";

export type LightboxItem = {
  id: string;
  url: string;
  name: string;
  caption: string;
  captionJa?: string;
};

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Full-screen high-detail image viewer for the curation screen.
 * - wheel to zoom (around the cursor), drag to pan
 * - ◀ / ▶ buttons + ArrowLeft / ArrowRight to step through the set
 * - the current image's English caption is editable inline
 * - ESC / the ✕ button / a click on the backdrop closes it
 */
export function ImageLightbox({
  items,
  index,
  onIndexChange,
  onClose,
  onCaptionChange,
  disabled = false,
}: {
  items: LightboxItem[];
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
  onCaptionChange?: (id: string, caption: string) => void;
  disabled?: boolean;
}) {
  const item = items[index];
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const resetView = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  // Reset zoom / pan / load state the moment the image changes — the
  // render-phase "adjust state on prop change" pattern (no effect, no
  // cascading render). https://react.dev/learn/you-might-not-need-an-effect
  const [shownIndex, setShownIndex] = useState(index);
  if (shownIndex !== index) {
    setShownIndex(index);
    setScale(1);
    setTx(0);
    setTy(0);
    setLoaded(false);
  }

  const go = useCallback(
    (delta: number) => {
      if (items.length < 2) return;
      onIndexChange(clamp(index + delta, 0, items.length - 1));
    },
    [index, items.length, onIndexChange],
  );

  // Keyboard: ESC to close, ← / → to navigate. Bound while the modal is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    // cursor offset from the stage centre (the transform-origin)
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    const factor = Math.exp(-e.deltaY * 0.0015);
    setScale((s) => {
      const next = clamp(s * factor, MIN_SCALE, MAX_SCALE);
      const k = next / s;
      setTx((prevTx) => cx - (cx - prevTx) * k);
      setTy((prevTy) => cy - (cy - prevTy) * k);
      if (next === 1) {
        setTx(0);
        setTy(0);
      }
      return next;
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (scale <= 1) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx, ty };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setTx(drag.current.tx + (e.clientX - drag.current.x));
    setTy(drag.current.ty + (e.clientY - drag.current.y));
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  if (!item) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="画像の拡大表示"
    >
      {/* top bar */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs text-white/80"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 truncate font-mono" title={item.name}>
          {item.name}
          <span className="ml-2 text-white/40">
            {index + 1} / {items.length}
          </span>
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={resetView}
            disabled={scale === 1 && tx === 0 && ty === 0}
            title="ズームをリセット"
            className="inline-flex items-center gap-1 rounded-md border border-white/20 px-2 py-1 text-[11px] transition-colors hover:bg-white/10 disabled:opacity-30"
          >
            <RotateCcw size={12} />
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            onClick={onClose}
            title="閉じる (ESC)"
            className="inline-flex items-center justify-center rounded-md border border-white/20 p-1.5 transition-colors hover:bg-white/10"
            aria-label="閉じる"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* stage */}
      <div
        ref={stageRef}
        className="relative flex-1 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        style={{ cursor: scale > 1 ? (dragging ? "grabbing" : "grab") : "default" }}
      >
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 size={28} className="animate-spin text-white/60" />
          </div>
        )}
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transition: dragging ? "none" : "transform 90ms ease-out",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.url}
            alt={item.name}
            draggable={false}
            onLoad={() => setLoaded(true)}
            className="max-h-full max-w-full select-none object-contain"
          />
        </div>

        {items.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={index === 0}
              aria-label="前の画像"
              className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full border border-white/20 bg-black/50 p-2 text-white transition-colors hover:bg-black/70 disabled:opacity-25"
            >
              <ChevronLeft size={22} />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              disabled={index === items.length - 1}
              aria-label="次の画像"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full border border-white/20 bg-black/50 p-2 text-white transition-colors hover:bg-black/70 disabled:opacity-25"
            >
              <ChevronRight size={22} />
            </button>
          </>
        )}
      </div>

      {/* caption bar */}
      <div
        className="border-t border-white/10 bg-black/60 px-4 py-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between text-[10px] text-white/50">
          <span>英語タグ / English（学習に使用）</span>
          {items.length > 1 && (
            <span className="hidden sm:inline">◀ ▶ / ←→ キーで前後の画像・ホイールで拡大・ドラッグで移動</span>
          )}
        </div>
        <textarea
          value={item.caption}
          onChange={(e) => onCaptionChange?.(item.id, e.target.value)}
          disabled={disabled || !onCaptionChange}
          placeholder="(空欄 = 自動タグ付け)"
          rows={2}
          className="w-full resize-none rounded-lg border border-white/15 bg-white/5 px-3 py-2 font-mono text-xs text-white outline-none transition-colors focus:border-neon-violet/60 disabled:opacity-60"
        />
        {item.captionJa?.trim() ? (
          <p className="mt-1.5 line-clamp-2 text-[11px] text-white/50">{item.captionJa}</p>
        ) : null}
      </div>
    </div>
  );
}
