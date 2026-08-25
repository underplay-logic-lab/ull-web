"use client";

import { useEffect, useRef, useState } from "react";

// Live-updating elapsed time (ms) for as long as `isActive` is true — ticks
// every 100ms via performance.now(), and freezes at the precise final value
// the instant `isActive` flips back to false (rather than waiting for the
// next 100ms tick), so a "所要時間" readout shown right after completion is
// accurate rather than off by up to one tick interval. Used by the Studio
// generation tabs (WanAnimateTab / CustomWorkflowsTab) to show a running
// stopwatch while a generation request is in flight.
export function useElapsedTimer(isActive: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isActive) return;

    const start = performance.now();
    startRef.current = start;
    const tick = () => setElapsedMs(performance.now() - start);

    // Deferred rather than called directly in the effect body (React's
    // set-state-in-effect lint rule flags synchronous setState calls
    // there) — fires on the next microtask/macrotask instead, resetting
    // the display to ~0 without waiting for the first 100ms tick below.
    const resetId = setTimeout(tick, 0);
    const intervalId = setInterval(tick, 100);

    return () => {
      clearTimeout(resetId);
      clearInterval(intervalId);
      setElapsedMs(performance.now() - start);
    };
  }, [isActive]);

  return elapsedMs;
}

export function formatElapsedSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
