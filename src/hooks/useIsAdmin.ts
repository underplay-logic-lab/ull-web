"use client";

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";

type RemoteCheck = { userId: string; isAdmin: boolean };

// Gated on `user` (from useSupabaseUser) so anonymous visitors never hit
// the check endpoint at all — same-origin fetch carries the Supabase auth
// cookie automatically, same as every /api/admin/* call from the Admin UI.
//
// isAdmin/loading are derived from `remoteCheck` vs. the current `user`
// (not reset via a separate effect branch) so a logout is reflected
// immediately, with no extra setState call needed.
export function useIsAdmin(user: User | null) {
  const [remoteCheck, setRemoteCheck] = useState<RemoteCheck | null>(null);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/session");
        const data = await res.json();
        if (!cancelled) setRemoteCheck({ userId: user.id, isAdmin: res.ok && Boolean(data?.isAdmin) });
      } catch (err) {
        console.error("[useIsAdmin] failed to check admin status:", err);
        if (!cancelled) setRemoteCheck({ userId: user.id, isAdmin: false });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  const isAdmin = Boolean(user) && remoteCheck?.userId === user?.id && (remoteCheck?.isAdmin ?? false);
  const loading = Boolean(user) && remoteCheck?.userId !== user?.id;

  return { isAdmin, loading };
}
