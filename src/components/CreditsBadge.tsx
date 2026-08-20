"use client";

import { useState } from "react";
import { Zap } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import { useProfileCredits } from "@/hooks/useProfileCredits";

type CreditsBadgeProps = {
  user: User | null;
  className?: string;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function formatExpiryDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function CreditsBadge({ user, className = "" }: CreditsBadgeProps) {
  const { credits, loading, creditsExpireAt } = useProfileCredits(user);
  // Date.now() is impure and must not be called during render. A useState
  // lazy initializer is the sanctioned place for a one-time impure read —
  // it runs once per mount, giving a stable "now" the render body can do
  // pure arithmetic against.
  const [referenceNow] = useState(() => Date.now());

  if (!user) return null;

  const daysRemaining = creditsExpireAt
    ? Math.max(0, Math.ceil((new Date(creditsExpireAt).getTime() - referenceNow) / MS_PER_DAY))
    : null;

  return (
    <span
      className={`group relative items-center gap-1.5 rounded-full border border-border bg-surface/60 px-3 py-1.5 font-mono text-xs text-foreground ${className}`}
    >
      <Zap size={12} className="text-neon-pink" />
      {loading ? "…" : (credits?.toLocaleString() ?? "—")} Credits

      {creditsExpireAt && daysRemaining !== null && (
        <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-64 -translate-x-1/2 rounded-xl border border-border bg-surface p-3 text-left font-sans text-[11px] normal-case leading-relaxed text-foreground opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100">
          <span className="block font-semibold text-neon-pink">
            有効期限: {formatExpiryDate(creditsExpireAt)}（あと {daysRemaining} 日）
          </span>
          <span className="mt-1 block text-muted">
            ※ 毎日のログインボーナス獲得または追加チャージで、保有クレジット全体の有効期限が自動的に180日延長されます。
          </span>
        </span>
      )}
    </span>
  );
}
