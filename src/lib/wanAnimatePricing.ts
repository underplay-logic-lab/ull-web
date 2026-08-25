import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { WAN_ANIMATE_GENERATION_COST } from "@/lib/data";
import type { GpuTier } from "@/lib/gpuTier";

export type WanAnimateMotionMode = "preset" | "custom";
// Re-exported for existing call sites — the canonical definition now lives
// in gpuTier.ts, shared with Custom Workflows (see getGpuTierUltraAddon in
// gpuTierPricing.ts).
export type WanAnimateGpuTier = GpuTier;

// Keys in studio_pricing (admin-editable) that drive both the displayed
// cost (src/app/api/studio/pricing/route.ts) and the amount actually
// debited (src/app/api/wan-animate/generate/route.ts) for each motion mode —
// keeping the two in sync is the whole point of reading this at request time
// instead of hardcoding a constant.
export const WAN_ANIMATE_PRICING_KEY: Record<WanAnimateMotionMode, string> = {
  preset: "wan_animate_preset",
  custom: "wan_animate_custom",
};

export async function getWanAnimateGenerationCost(mode: WanAnimateMotionMode): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("studio_pricing")
    .select("credits")
    .eq("key", WAN_ANIMATE_PRICING_KEY[mode])
    .maybeSingle();

  if (error || !data) {
    console.error(
      "[wanAnimatePricing] studio_pricing lookup failed, using fallback cost:",
      error?.message ?? "no row",
    );
    return WAN_ANIMATE_GENERATION_COST;
  }

  return data.credits as number;
}
