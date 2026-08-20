"use client";

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

// Duplicated from lib/stripe.ts (marked "server-only") rather than imported,
// since this hook runs in the browser.
export type SubscriptionTier = "free" | "entry" | "standard" | "pro" | "master";

// Mirrors lib/stripe.ts's TOPUP_PRICE_BY_TIER — the discounted top-up price
// this tier currently gets, for display only (the checkout route is the
// actual source of truth and re-derives this server-side).
export const TOPUP_PRICE_BY_TIER: Record<SubscriptionTier, number> = {
  free: 500,
  entry: 450,
  standard: 400,
  pro: 350,
  master: 250,
};

type FetchStatus = "idle" | "ready" | "error";

const CREDITS_UPDATED_EVENT = "profile-credits-updated";

type CreditsUpdatedDetail = { userId: string; credits: number };

// Lets a caller that already knows the new balance (e.g. Studio right after
// a generation debits a credit) push it to every mounted useProfileCredits
// instance for that user immediately, instead of waiting on the Postgres
// realtime round-trip.
export function broadcastCreditsUpdate(userId: string, credits: number) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<CreditsUpdatedDetail>(CREDITS_UPDATED_EVENT, { detail: { userId, credits } }),
  );
}

export function useProfileCredits(user: User | null) {
  const [rawCredits, setCredits] = useState<number | null>(null);
  const [tier, setTier] = useState<SubscriptionTier | null>(null);
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false);
  const [creditsExpireAt, setCreditsExpireAt] = useState<string | null>(null);
  const [status, setStatus] = useState<FetchStatus>("idle");

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    const topicPrefix = `profiles-credits-${user.id}`;

    // Defensively purge any stale channel left over from a previous mount
    // (e.g. React Strict Mode's double-invoke, or a fast-refresh remount)
    // whose async removeChannel() hadn't finished before this effect reran.
    for (const existing of supabase.getChannels()) {
      if (existing.topic === `realtime:${topicPrefix}` || existing.topic.startsWith(`realtime:${topicPrefix}-`)) {
        supabase.removeChannel(existing);
      }
    }

    supabase
      .from("profiles")
      .select("credits, subscription_tier, cancel_at_period_end, credits_expire_at")
      .eq("id", user.id)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[useProfileCredits] failed to load credits:", error.message);
          setStatus("error");
        } else {
          setCredits(data?.credits ?? null);
          setTier((data?.subscription_tier as SubscriptionTier | null) ?? "free");
          setCancelAtPeriodEnd(Boolean(data?.cancel_at_period_end));
          setCreditsExpireAt((data?.credits_expire_at as string | null) ?? null);
          setStatus("ready");
        }
      });

    // A unique topic per effect run guarantees supabase.channel() can never
    // resolve to an already-subscribed instance, which is what triggers
    // "cannot add 'postgres_changes' callbacks ... after subscribe()".
    const channel = supabase
      .channel(`${topicPrefix}-${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "profiles",
          filter: `id=eq.${user.id}`,
        },
        (payload) => {
          const next = payload.new as {
            credits?: number;
            subscription_tier?: string;
            cancel_at_period_end?: boolean;
            credits_expire_at?: string | null;
          };
          if (typeof next.credits === "number") {
            setCredits(next.credits);
          }
          if (typeof next.subscription_tier === "string") {
            setTier(next.subscription_tier as SubscriptionTier);
          }
          if (typeof next.cancel_at_period_end === "boolean") {
            setCancelAtPeriodEnd(next.cancel_at_period_end);
          }
          if (typeof next.credits_expire_at === "string" || next.credits_expire_at === null) {
            setCreditsExpireAt(next.credits_expire_at ?? null);
          }
        },
      )
      .subscribe();

    const handleBroadcast = (event: Event) => {
      const detail = (event as CustomEvent<CreditsUpdatedDetail>).detail;
      if (detail?.userId === user.id) {
        setCredits(detail.credits);
      }
    };
    window.addEventListener(CREDITS_UPDATED_EVENT, handleBroadcast);

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      window.removeEventListener(CREDITS_UPDATED_EVENT, handleBroadcast);
    };
  }, [user]);

  if (!user) {
    return { credits: null, tier: null, cancelAtPeriodEnd: false, creditsExpireAt: null, loading: false };
  }

  return { credits: rawCredits, tier, cancelAtPeriodEnd, creditsExpireAt, loading: status === "idle" };
}
