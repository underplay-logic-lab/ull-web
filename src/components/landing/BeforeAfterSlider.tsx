"use client";

import { useCallback, useRef, useState } from "react";
import { MoveHorizontal } from "lucide-react";
import { ShowcaseMedia } from "@/components/landing/ShowcaseMedia";

type BeforeAfterSliderProps = {
  beforeKey: string;
  afterKey: string;
  beforeLabel?: string;
  afterLabel?: string;
  ratio?: string;
  className?: string;
};

// Dependency-free before/after comparison. Drag (pointer or touch) or use
// the arrow keys to move the divider. The "after" layer is clipped to the
// current split; both layers fall back to ShowcaseMedia's skeleton when no
// asset is configured, so it reads correctly before any media is uploaded.
export function BeforeAfterSlider({
  beforeKey,
  afterKey,
  beforeLabel = "他社標準 i2i",
  afterLabel = "ULL Multi-Angle",
  ratio = "4 / 3",
  className = "",
}: BeforeAfterSliderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pct, setPct] = useState(50);
  const dragging = useRef(false);

  const setFromClientX = useCallback((clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = ((clientX - rect.left) / rect.width) * 100;
    setPct(Math.max(0, Math.min(100, next)));
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setFromClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    setFromClientX(e.clientX);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };

  return (
    <div className={className}>
      <div
        ref={containerRef}
        className="relative touch-none select-none overflow-hidden rounded-xl border border-border"
        style={{ aspectRatio: ratio }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Before (full width, underneath) */}
        <div className="absolute inset-0">
          <ShowcaseMedia
            siteKey={beforeKey}
            ratio={ratio}
            className="h-full w-full rounded-none border-0"
            label={beforeLabel}
          />
        </div>

        {/* After (clipped to pct) */}
        <div
          className="absolute inset-0"
          style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
        >
          <ShowcaseMedia
            siteKey={afterKey}
            ratio={ratio}
            className="h-full w-full rounded-none border-0"
            label={afterLabel}
          />
        </div>

        {/* Divider + handle */}
        <div
          className="absolute inset-y-0 z-10 w-0.5 bg-neon-pink shadow-[0_0_12px_var(--neon-pink-glow)]"
          style={{ left: `${pct}%` }}
        >
          <button
            type="button"
            aria-label="比較スライダー"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            role="slider"
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setPct((p) => Math.max(0, p - 4));
              if (e.key === "ArrowRight") setPct((p) => Math.min(100, p + 4));
            }}
            className="absolute top-1/2 left-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-neon-pink/60 bg-surface text-neon-pink"
          >
            <MoveHorizontal size={16} />
          </button>
        </div>

        {/* Corner labels */}
        <span className="pointer-events-none absolute top-2 left-3 rounded bg-black/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-white/80 backdrop-blur-sm">
          {beforeLabel}
        </span>
        <span className="pointer-events-none absolute top-2 right-3 rounded bg-neon-pink/20 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-neon-pink backdrop-blur-sm">
          {afterLabel}
        </span>
      </div>
    </div>
  );
}
