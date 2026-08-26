"use client";

import { useEffect, useState } from "react";
import { useGpuWarmStatus } from "@/hooks/useGpuWarmStatus";

// Adds a local 1s ticker on top of useGpuWarmStatus's realtime warmUntil so
// callers get a live remainingMs/isWarm without each re-deriving it — shared
// by GpuWarmBadge.tsx (header, status-only) and GpuWarmStokeWidget.tsx
// (near the generate button, status + extend button).
export function useGpuWarmCountdown() {
  const { warmUntil, setWarmUntil } = useGpuWarmStatus();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remainingMs = warmUntil ? new Date(warmUntil).getTime() - now : 0;
  const isWarm = remainingMs > 0;

  return { warmUntil, setWarmUntil, remainingMs, isWarm };
}

export function formatWarmCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
