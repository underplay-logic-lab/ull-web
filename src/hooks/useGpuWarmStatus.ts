"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type FetchStatus = "idle" | "ready" | "error";

// Mirrors useProfileCredits.ts's shape: one REST fetch on mount, then a
// Realtime subscription for live updates — here shared across every viewer
// (no per-user filter) since gpu_warm_status is one global row everyone
// reads, including signed-out visitors (see the anon SELECT policy in
// supabase/migrations/20260833000000_create_gpu_warm_status.sql).
export function useGpuWarmStatus() {
  const [warmUntil, setWarmUntil] = useState<string | null>(null);
  const [status, setStatus] = useState<FetchStatus>("idle");

  useEffect(() => {
    let cancelled = false;

    for (const existing of supabase.getChannels()) {
      if (existing.topic === "realtime:gpu-warm-status" || existing.topic.startsWith("realtime:gpu-warm-status-")) {
        supabase.removeChannel(existing);
      }
    }

    supabase
      .from("gpu_warm_status")
      .select("warm_until")
      .eq("id", 1)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[useGpuWarmStatus] failed to load status:", error.message);
          setStatus("error");
        } else {
          setWarmUntil((data?.warm_until as string | null) ?? null);
          setStatus("ready");
        }
      });

    const channel = supabase
      .channel(`gpu-warm-status-${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "gpu_warm_status", filter: "id=eq.1" },
        (payload) => {
          const next = payload.new as { warm_until?: string };
          if (typeof next.warm_until === "string") {
            setWarmUntil(next.warm_until);
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return { warmUntil, loading: status === "idle", setWarmUntil };
}
