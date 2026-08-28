"use client";

import { Flame, Hourglass, Loader2, Users } from "lucide-react";
import type { CinematicQueueInfo } from "@/lib/cinematicApi";

// Real-time queue monitor shown under the spinner while a generation job is
// waiting/running. Three tiers, driven by queuePosition:
//   0 (or processing) → "🔥 レンダリング実行中..."
//   1                 → "⏳ 前の動画を生成中（まもなくあなたの番です）"
//   >=2               → "👥 あなたの前に N 人が待機中（推定 約 M 分）"
export function QueueStatusPanel({
  phase,
  queue,
  className = "",
}: {
  phase: "queued" | "processing" | null;
  queue: CinematicQueueInfo | null;
  className?: string;
}) {
  // Before the first poll resolves, fall back to the coarse phase: a
  // "processing" job is effectively position 0, a fresh "queued" one is at
  // least behind the job currently rendering.
  const position = queue?.queuePosition ?? (phase === "processing" ? 0 : 1);
  const avgSeconds = queue?.avgExecutionSeconds ?? 28;
  const estimatedSeconds = queue?.estimatedWaitSeconds ?? 0;

  let Icon = Flame;
  let accent = "text-neon-pink";
  let ring = "border-neon-pink/40 bg-neon-pink/10";
  let headline = "🔥 レンダリング実行中...";
  let sub = "まもなく完了します";

  if (position === 1) {
    Icon = Hourglass;
    accent = "text-neon-violet";
    ring = "border-neon-violet/40 bg-neon-violet/10";
    headline = "⏳ 前の動画を生成中";
    sub = `まもなくあなたの番です ・ 推定 約 ${avgSeconds} 秒`;
  } else if (position >= 2) {
    Icon = Users;
    accent = "text-amber-400";
    ring = "border-amber-500/40 bg-amber-500/10";
    headline = `👥 あなたの前に ${position} 人が待機中`;
    const minutes = Math.max(1, Math.ceil(estimatedSeconds / 60));
    sub = `推定待ち時間: 約 ${minutes} 分`;
  }

  return (
    <div
      className={`flex w-full max-w-sm flex-col gap-2 rounded-xl border ${ring} px-4 py-3 backdrop-blur-sm transition-all duration-500 ${className}`}
    >
      <div className="flex items-center gap-2">
        <Icon size={15} className={`shrink-0 ${accent}`} />
        <span className={`text-[13px] font-semibold ${accent}`}>{headline}</span>
        <Loader2 size={13} className={`ml-auto shrink-0 animate-spin ${accent}`} />
      </div>
      <p className="text-[11px] leading-relaxed text-muted">{sub}</p>
      {/* Indeterminate progress shimmer */}
      <div className="relative h-1 overflow-hidden rounded-full bg-background/70">
        <div
          className={`absolute inset-y-0 w-1/3 rounded-full bg-current ${accent} animate-[queue-slide_1.6s_ease-in-out_infinite]`}
        />
      </div>
      <style>{`
        @keyframes queue-slide {
          0% { left: -35%; }
          100% { left: 100%; }
        }
      `}</style>
    </div>
  );
}
