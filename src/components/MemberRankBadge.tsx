"use client";

import type { User } from "@supabase/supabase-js";
import { useProfileCredits, type SubscriptionTier } from "@/hooks/useProfileCredits";

type MemberRankBadgeProps = {
  user: User | null;
  className?: string;
};

const RANK_LABEL: Record<SubscriptionTier, string> = {
  free: "FREE",
  entry: "ENTRY",
  standard: "STANDARD",
  pro: "PRO",
  master: "MASTER",
};

const RANK_STYLE: Record<SubscriptionTier, string> = {
  free: "border-border bg-surface/60 text-muted",
  entry: "border-cyan-400/40 bg-cyan-400/10 text-cyan-300",
  standard: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  pro: "border-neon-violet/40 bg-neon-violet/10 text-neon-violet shadow-[0_0_10px_rgba(139,92,246,0.25)]",
  master:
    "border-amber-400/50 bg-amber-400/10 text-amber-300 shadow-[0_0_10px_rgba(251,191,36,0.3)]",
};

export function MemberRankBadge({ user, className = "" }: MemberRankBadgeProps) {
  const { tier, cancelAtPeriodEnd } = useProfileCredits(user);

  if (!user || !tier) return null;

  // A reserved cancellation (Customer Portal "cancel at period end") stops
  // every continuation perk immediately, even though subscription_tier
  // itself stays at the paid tier until the period actually ends — the
  // badge needs to say so, not just show the paid tier as if nothing
  // changed.
  const showsCancelNotice = cancelAtPeriodEnd && tier !== "free";

  return (
    <span
      className={`items-center rounded-full border px-2.5 py-1.5 font-mono text-[10px] font-bold tracking-wider ${RANK_STYLE[tier]} ${className}`}
    >
      {RANK_LABEL[tier]}
      {showsCancelNotice && (
        <span className="ml-1 font-sans font-normal tracking-normal text-red-400">
          （解約予約中・特典停止）
        </span>
      )}
    </span>
  );
}
