// Shared GPU tier type/constant — used by every Studio feature that offers
// a Standard(L40S)/ULTRA(B300) choice (Wan Animate 2, Custom Workflows).
// No "server-only" guard: imported from both client components and
// server-only libs.

export type GpuTier = "standard" | "ultra";

// Key in studio_pricing for the ULTRA-tier credit surcharge, added on top of
// whatever a feature's own base cost is — shared across features rather
// than duplicated per feature.
export const GPU_TIER_ADDON_PRICING_KEY = "wan_animate_gpu_ultra_addon";
