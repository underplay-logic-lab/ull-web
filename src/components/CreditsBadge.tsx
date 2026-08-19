"use client";

import { Zap } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import { useProfileCredits } from "@/hooks/useProfileCredits";

type CreditsBadgeProps = {
  user: User | null;
  className?: string;
};

export function CreditsBadge({ user, className = "" }: CreditsBadgeProps) {
  const { credits, loading } = useProfileCredits(user);

  if (!user) return null;

  return (
    <span
      className={`items-center gap-1.5 rounded-full border border-border bg-surface/60 px-3 py-1.5 font-mono text-xs text-foreground ${className}`}
    >
      <Zap size={12} className="text-neon-pink" />
      {loading ? "…" : (credits?.toLocaleString() ?? "—")} Credits
    </span>
  );
}
