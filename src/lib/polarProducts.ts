// Live Polar product ids — the single source of truth shared by the server
// (src/lib/polar.ts, the checkout/webhook routes) and the client
// (src/lib/data.ts → Pricing.tsx).
//
// Values are synced from the real Polar catalog by scripts/list-polar-products.mjs
// (run with the local POLAR_ACCESS_TOKEN). Last sync: 2026-08-28 — the four
// subscription tiers had been recreated as proper *recurring* products, so
// their ids changed from the earlier one-time drafts (now archived).
//
// A NEXT_PUBLIC_POLAR_PRODUCT_ID_* env var still overrides its entry (so a
// staging deploy can point at a different catalog), but nothing needs to be
// set for the app to work against production.
export const POLAR_PRODUCT_IDS = {
  topup: process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_120 || "744fe424-c9fa-4b3c-a92d-d717e0421726",
  entry: process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_ENTRY || "6ec8c16f-d928-4f1c-8f36-d088bcbcaf59",
  standard: process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_STANDARD || "6f170e8e-0afb-4d22-85f8-edaea807be9f",
  pro: process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_PRO || "9f3add73-bdea-4183-8334-973d2ca66f9a",
  master: process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_MASTER || "01d5a197-b0cc-4c13-9fa9-18a7bab4579c",
} as const;

export type PolarProductKey = keyof typeof POLAR_PRODUCT_IDS;
