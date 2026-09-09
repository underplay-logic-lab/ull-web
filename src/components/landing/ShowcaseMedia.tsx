"use client";

import { EditableMedia } from "@/components/EditableMedia";

type ShowcaseMediaProps = {
  siteKey: string;
  kind?: "image" | "video";
  alt?: string;
  className?: string;
  // Aspect ratio for the placeholder box, e.g. "4 / 3", "1 / 1", "9 / 16".
  ratio?: string;
  label?: string;
};

// Wraps EditableMedia for the landing showcase. EditableMedia renders
// nothing when its site_contents key is unset (outside edit mode), so this
// stacks a polished SVG-gradient skeleton *behind* it: if no asset is
// configured yet the page still looks intentional rather than broken
// (Task spec §4 — "破綻しないフォールバック"). Real assets live under
// public/showcase/… (see public/showcase/README.md).
export function ShowcaseMedia({
  siteKey,
  kind = "image",
  alt = "",
  className = "",
  ratio = "4 / 3",
  label,
}: ShowcaseMediaProps) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-border bg-surface/40 ${className}`}
      style={{ aspectRatio: ratio }}
    >
      {/* Skeleton / fallback layer */}
      <div aria-hidden className="absolute inset-0">
        <svg
          className="h-full w-full"
          viewBox="0 0 400 300"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <linearGradient id={`g-${siteKey}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--neon-violet)" stopOpacity="0.18" />
              <stop offset="50%" stopColor="var(--neon-pink)" stopOpacity="0.10" />
              <stop offset="100%" stopColor="var(--neon-violet)" stopOpacity="0.16" />
            </linearGradient>
          </defs>
          <rect width="400" height="300" fill={`url(#g-${siteKey})`} />
          <g stroke="var(--neon-pink)" strokeOpacity="0.12" strokeWidth="1">
            {Array.from({ length: 7 }).map((_, i) => (
              <line key={`h${i}`} x1="0" y1={i * 50} x2="400" y2={i * 50} />
            ))}
            {Array.from({ length: 9 }).map((_, i) => (
              <line key={`v${i}`} x1={i * 50} y1="0" x2={i * 50} y2="300" />
            ))}
          </g>
        </svg>
        <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-transparent via-white/[0.02] to-transparent" />
        {label && (
          <span className="absolute bottom-2 left-3 font-mono text-[10px] uppercase tracking-widest text-muted">
            {label}
          </span>
        )}
      </div>

      {/* Real media (or the editor's "add media" affordance) on top */}
      <div className="absolute inset-0">
        <EditableMedia
          siteKey={siteKey}
          kind={kind}
          alt={alt}
          className="h-full w-full object-cover"
        />
      </div>
    </div>
  );
}
