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
// 2026-09-23 プラン改定（docs/pricing-decision-sheet.md）。scripts/setup-polar-plans-2026-09.mjs で
// 作成した live catalog の id。旧 5 商品（¥980/¥2,480/¥4,980/¥9,980/都度 ¥500）はアーカイブ済み。
export const POLAR_PRODUCT_IDS = {
  topup: "23342766-8f87-40aa-ae0f-811e2152b9aa", // 都度 ¥1,000 / 300C
  entry: "7302330d-b548-48a5-9ccf-96f5a896397a", // ¥1,980 / 800C
  standard: "99da5bee-ba13-44ed-a4e7-923b059f2165", // ¥4,980 / 2,200C
  pro: "0050dda5-f56e-4f73-84bd-49702b724ea6", // ¥9,980 / 5,000C
  master: "0e65bc48-35ab-4ccd-b8b1-278837ea0ba1", // ¥19,800 / 11,000C
  studio: "1f8e5a9f-74b3-4e95-8b77-bf49d4a0a489", // ¥29,800 / 18,000C（床 1.66 ¥/C）
} as const;

export type PolarProductKey = keyof typeof POLAR_PRODUCT_IDS;
