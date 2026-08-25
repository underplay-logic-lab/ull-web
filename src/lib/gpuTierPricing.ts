import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { GPU_TIER_ADDON_PRICING_KEY } from "@/lib/gpuTier";
import { WAN_ANIMATE_GPU_ULTRA_ADDON } from "@/lib/data";

// Additive credit surcharge applied on top of a feature's own base cost
// whenever gpuTier === "ultra" — shared across every Studio feature that
// offers a Standard(L40S)/ULTRA(B300) choice (Wan Animate 2, Custom
// Workflows) rather than duplicated per feature. See
// /api/wan-animate/generate and /api/studio/custom-workflows/generate.
export async function getGpuTierUltraAddon(): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("studio_pricing")
    .select("credits")
    .eq("key", GPU_TIER_ADDON_PRICING_KEY)
    .maybeSingle();

  if (error || !data) {
    console.error(
      "[gpuTierPricing] ultra addon lookup failed, using fallback cost:",
      error?.message ?? "no row",
    );
    return WAN_ANIMATE_GPU_ULTRA_ADDON;
  }

  return data.credits as number;
}
