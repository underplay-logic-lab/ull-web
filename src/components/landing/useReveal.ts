"use client";

import { useEffect, useRef, useState } from "react";

// Lightweight scroll-in reveal. The existing site animates with plain CSS
// (globals.css: animate-pulse-glow / animate-float) and ships no animation
// library, so the landing sections use this + Tailwind transitions instead
// of pulling in Framer Motion. Returns a ref to attach and a `shown` flag
// that flips true once (and stays true) when the element scrolls into view.
export function useReveal<T extends HTMLElement = HTMLDivElement>(
  options?: IntersectionObserverInit,
) {
  const ref = useRef<T | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;

    // No IntersectionObserver (old browser, jsdom) → reveal on next frame
    // (deferred so it isn't a synchronous setState in the effect body).
    if (typeof IntersectionObserver === "undefined") {
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.15, ...options },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown, options]);

  return { ref, shown };
}

// Standard reveal classes — opacity + small rise, honoring reduced motion
// via Tailwind's motion-safe/motion-reduce.
export function revealClass(shown: boolean): string {
  return [
    "transition-all duration-700 ease-out motion-reduce:transition-none",
    shown
      ? "opacity-100 translate-y-0"
      : "opacity-0 translate-y-6 motion-reduce:opacity-100 motion-reduce:translate-y-0",
  ].join(" ");
}
