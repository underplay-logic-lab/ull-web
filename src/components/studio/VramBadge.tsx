import { Activity } from "lucide-react";

// Spoiler-free live load indicator — deliberately no total, no %, no GPU
// model (CLAUDE.md §2). Just how much weight is currently resident.
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
    <span className="inline-flex items-center gap-1 rounded-full border border-neon-violet/40 bg-neon-violet/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-neon-violet">
      <Activity size={11} />
      Active VRAM: {gb} GB
    </span>
  );
}
