// Live Polar product ids — the single source of truth shared by the server
// (src/lib/polar.ts, the checkout/webhook routes) and the client
// (src/lib/data.ts → Pricing.tsx).
//
// Hardcoded on purpose: env overrides were removed because stale
// NEXT_PUBLIC_POLAR_PRODUCT_ID_* values left on Vercel were shadowing these
// and sending checkout to archived products ("Product is archived."). To
// change a product id, edit it here (verify against the live catalog with
// `node scripts/list-polar-products.mjs`) and ship a commit — nothing reads
// the environment for these anymore.
//
// Synced 2026-08-28: the four subscription tiers are the *recurring*
// products; the earlier one-time drafts are archived.
export const POLAR_PRODUCT_IDS = {
  topup: "744fe424-c9fa-4b3c-a92d-d717e0421726",
  entry: "6ec8c16f-d928-4f1c-8f36-d088bcbcaf59",
  standard: "6f170e8e-0afb-4d22-85f8-edaea807be9f",
  pro: "9f3add73-bdea-4183-8334-973d2ca66f9a",
  master: "01d5a197-b0cc-4c13-9fa9-18a7bab4579c",
} as const;

export type PolarProductKey = keyof typeof POLAR_PRODUCT_IDS;
