import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { DEFAULT_KNOBS, resolveKnobs, type PricingKnobs } from "@/lib/pricing/knobDefaults";

// Live pricing / cost-guard knobs, read from the admin-editable `pricing_knobs`
// table and merged onto the hardcoded DEFAULT_KNOBS. Both the displayed price
// (Studio tabs, via /api/studio/pricing) and the amount actually debited /
// the cost-guard seconds passed to Modal read from here, so the two can never
// drift.
//
// Cached in-process for a short window: a pricing edit in /admin is visible
// within ~1 min without a redeploy, and a burst of generations doesn't hammer
// the table. A read failure logs and falls back to defaults — generation must
// never hard-block on a pricing-table outage (same posture as
// src/lib/wanAnimatePricing.ts).

const CACHE_TTL_MS = 60_000;

let cache: { knobs: PricingKnobs; at: number } | null = null;
let inflight: Promise<PricingKnobs> | null = null;

async function fetchKnobs(): Promise<PricingKnobs> {
  const { data, error } = await supabaseAdmin.from("pricing_knobs").select("key, value");
  if (error || !data) {
    console.error("[pricingKnobs] table read failed, using defaults:", error?.message ?? "no rows");
    return { ...DEFAULT_KNOBS };
  }
  const overrides: Record<string, number> = {};
  for (const row of data) {
    const v = typeof row.value === "string" ? Number(row.value) : (row.value as number);
    if (Number.isFinite(v)) overrides[row.key as string] = v;
  }
  return resolveKnobs(overrides);
}

export async function getPricingKnobs(): Promise<PricingKnobs> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.knobs;
  if (inflight) return inflight;

  inflight = fetchKnobs()
    .then((knobs) => {
      cache = { knobs, at: Date.now() };
      return knobs;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// Drop the cache — call after a successful admin write so the next request
// reflects the edit immediately rather than up to CACHE_TTL_MS later.
export function invalidatePricingKnobs(): void {
  cache = null;
}
