"use client";

import { useEffect, useState } from "react";
import { DEFAULT_KNOBS, resolveKnobs, type PricingKnobs } from "@/lib/pricing/knobDefaults";

// Live public pricing knobs (feature credit costs + LoRA formula coefficients),
// admin-edited via /admin's Pricing tab and served by GET /api/studio/pricing.
//
// Returns DEFAULT_KNOBS immediately so every price the Studio tabs show is
// correct on first paint, then swaps in the DB values once the fetch resolves
// (same non-blocking pattern as WanAnimateTab's inline pricing fetch). A failed
// request keeps the defaults — a pricing-table outage never blanks a price.
//
// The `pricing` map (legacy studio_pricing / Wan Animate, key -> credits) is
// returned alongside for callers that still need it.
export function usePricingKnobs(): {
  knobs: PricingKnobs;
  pricing: Record<string, number>;
  loaded: boolean;
} {
  const [knobs, setKnobs] = useState<PricingKnobs>(DEFAULT_KNOBS);
  const [pricing, setPricing] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/studio/pricing");
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && data && typeof data === "object") {
          if (data.knobs && typeof data.knobs === "object") {
            setKnobs(resolveKnobs(data.knobs as Record<string, number>));
          }
          if (data.pricing && typeof data.pricing === "object") {
            setPricing(data.pricing as Record<string, number>);
          }
        } else {
          console.warn("[usePricingKnobs] pricing API unavailable, using defaults:", data?.error ?? res.status);
        }
      } catch (err) {
        if (!cancelled) console.warn("[usePricingKnobs] pricing API request failed, using defaults:", err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { knobs, pricing, loaded };
}
