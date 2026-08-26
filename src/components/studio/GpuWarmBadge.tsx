"use client";

import { Flame, Snowflake } from "lucide-react";
import { useGpuWarmCountdown, formatWarmCountdown } from "@/hooks/useGpuWarmCountdown";

// Passive, always-on status line shown above the Studio tab switcher
// (Studio.tsx) — gpu_warm_status is one shared row everyone watches
// together, so a small indicator of it lives here regardless of which tab
// is active. Deliberately has no "🔥 火をくべる" button (and never has, even
// while warm) — that action only makes sense in context, right next to a
// specific generate button, where GpuWarmStokeWidget.tsx renders it (and
// only while actually warm, so a cold click can never waste a credit).
export function GpuWarmBadge() {
  const { remainingMs, isWarm } = useGpuWarmCountdown();

  return (
    <div className="mt-5 flex flex-col items-center gap-2">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-xs font-medium transition-colors ${
          isWarm
            ? "border-orange-500/40 bg-orange-500/10 text-orange-400"
            : "border-border bg-surface/40 text-muted"
        }`}
      >
        {isWarm ? (
          <>
            <Flame size={13} />
            {`GPU稼働中: ${formatWarmCountdown(remainingMs)}（待機時間なしで即生成開始）`}
          </>
        ) : (
          <>
            <Snowflake size={13} />
            GPU待機中（初回のみ初期ロードが発生します）
          </>
        )}
      </span>
    </div>
  );
}
