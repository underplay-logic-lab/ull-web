import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { DEFAULT_KNOBS, PUBLIC_KNOB_KEYS } from "@/lib/pricing/knobDefaults";

// Public, read-only: lets the Studio UI display the live credits cost per
// generation mode (admin-edited via /admin's Pricing tab) instead of a
// hardcoded number.
//
//  - `pricing`: legacy studio_pricing rows (Wan Animate) — key -> credits.
//  - `knobs`:   the public pricing_knobs (feature credits + LoRA formula
//               coefficients), merged onto DEFAULT_KNOBS. Cost-guard
//               thresholds and rate knobs are NOT public — they stay
//               server-side.
export async function GET() {
  const [pricingRes, knobsRes] = await Promise.all([
    supabaseAdmin.from("studio_pricing").select("key, credits"),
    supabaseAdmin.from("pricing_knobs").select("key, value").eq("is_public", true),
  ]);

  if (pricingRes.error) {
    console.error("[studio/pricing] studio_pricing fetch failed:", pricingRes.error.message);
  }
  if (knobsRes.error) {
    console.error("[studio/pricing] pricing_knobs fetch failed:", knobsRes.error.message);
  }

  const pricing = Object.fromEntries(
    (pricingRes.data ?? []).map((row) => [row.key as string, row.credits as number]),
  );

  const publicSet = new Set<string>(PUBLIC_KNOB_KEYS);
  const knobs: Record<string, number> = {};
  for (const key of PUBLIC_KNOB_KEYS) knobs[key] = DEFAULT_KNOBS[key];
  for (const row of knobsRes.data ?? []) {
    const k = row.key as string;
    if (!publicSet.has(k)) continue;
    const v = typeof row.value === "string" ? Number(row.value) : (row.value as number);
    if (Number.isFinite(v)) knobs[k] = v;
  }

  return NextResponse.json({ pricing, knobs });
}
