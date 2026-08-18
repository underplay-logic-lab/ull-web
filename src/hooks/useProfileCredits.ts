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

    const channel = supabase
      .channel(`profiles-credits-${user.id}`)
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
