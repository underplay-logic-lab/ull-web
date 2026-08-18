"use client";

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

type FetchStatus = "idle" | "ready" | "error";

export function useProfileCredits(user: User | null) {
  const [rawCredits, setCredits] = useState<number | null>(null);
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
      .select("credits")
      .eq("id", user.id)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[useProfileCredits] failed to load credits:", error.message);
          setStatus("error");
        } else {
          setCredits(data?.credits ?? null);
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
          const nextCredits = (payload.new as { credits?: number }).credits;
          if (typeof nextCredits === "number") {
            setCredits(nextCredits);
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [user]);

  if (!user) {
    return { credits: null, loading: false };
  }

  return { credits: rawCredits, loading: status === "idle" };
}
