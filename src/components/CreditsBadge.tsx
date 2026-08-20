"use client";

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

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// Whole calendar days between "now" and the expiry, not a raw ms/86400000
// division. A grant sets credits_expire_at to exactly now+180*86400000ms —
// diffing that against a later "now" on raw milliseconds is always a hair
// under 180 days, but Math.ceil rounds that up, and if "now" was itself a
// stale snapshot from long before the grant, the gap can exceed 180 days
// entirely and round up to 181. Truncating both sides to local midnight
// first removes the sub-day noise: the result is an exact day count that
// reads "180" the moment a grant lands and ticks down by exactly 1 at each
// local-midnight rollover, matching how a user actually reads a date.
function daysUntil(expireAtIso: string, referenceMs: number) {
  const diffMs = startOfLocalDay(new Date(expireAtIso)) - startOfLocalDay(new Date(referenceMs));
  return Math.max(0, Math.round(diffMs / MS_PER_DAY));
}

export function CreditsBadge({ user, className = "" }: CreditsBadgeProps) {
  const { credits, loading, creditsExpireAt } = useProfileCredits(user);

  if (!user) return null;

  // Reading the clock during render is unavoidable for a live "days
  // remaining" display — there's no prop/state this can be purely derived
  // from. A one-time snapshot (e.g. captured via a useState lazy
  // initializer) would go stale the moment credits_expire_at changes later
  // in the same session, which is exactly what previously caused this to
  // occasionally read "181日" instead of "180日" right after a grant.
  // eslint-disable-next-line react-hooks/purity -- see comment above
  const now = Date.now();
  const daysRemaining = creditsExpireAt ? daysUntil(creditsExpireAt, now) : null;

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
