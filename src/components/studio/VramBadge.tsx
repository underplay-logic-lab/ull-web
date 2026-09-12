import { Zap } from "lucide-react";

// Spoiler-free live load indicator — deliberately no total, no %, no GPU
// model (CLAUDE.md §2). Just how much weight is currently resident.
//
// The raw number IS the selling point ("え、200GBも使ってるの？") so it's
// rendered as the visual focal point — large gradient number, glow — rather
// than a quiet inline pill, unlike a typical status badge.
//
// Shared across every Studio tab. Fed from the worker's
// `_current_effective_vram_gb()` telemetry (`vram_used_gb`), surfaced either
// live (async tabs — LoRA / Cinematic / Multi-Angle, streamed through the
// job row) or as the final value on completion (sync tabs — Wan Animate /
// 特化ワークフロー, carried in the generate response). `gb == null` renders
// nothing, so a worker that hasn't been redeployed with the telemetry just
// shows no badge.
export function VramBadge({ gb }: { gb: number | null | undefined }) {
  if (gb == null) return null;
  return (
    <span className="glow-violet inline-flex items-center gap-2 rounded-full border border-neon-violet/40 bg-surface px-3 py-1.5">
      <Zap size={14} className="shrink-0 animate-pulse text-neon-pink" />
      <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted">Active VRAM</span>
      <span className="text-gradient font-mono text-lg font-black leading-none">{gb} GB</span>
    </span>
  );
}
