import "server-only";
import { HTTPClient, Polar } from "@polar-sh/sdk";
import { POLAR_PRODUCT_IDS } from "@/lib/polarProducts";

// "production" unless explicitly overridden — POLAR_SERVER is only meant
// for pointing this at Polar's sandbox during local/staging testing.
const server = (process.env.POLAR_SERVER as "production" | "sandbox" | undefined) ?? "production";

// 2026-09-14: Polar が日付ベースのAPIバージョニングを導入
// （Current/Deprecated/Next の3本立て、四半期ごとにローテーション）。
// Polar-Version ヘッダーを送らないリクエストは常に「Current」扱いになり、
// 2026-10-01 の次回ローテーションで黙って 2026-10 契約に切り替わる
// （このプロジェクトが使っている @polar-sh/sdk 0.49.0 は 2026-04 契約向けに
// 生成されたもの — SDK_METADATA.openapiDocVersion で確認済み）。SDKOptions
// にはヘッダー直指定の口が無いため、addHook("beforeRequest", ...) という
// SDK公式の拡張ポイント（Speakeasy生成SDKの標準機能）でリクエストごとに
// ヘッダーを注入する。決済まわりのコードなので、契約を意図せず変えないよう
// 明示的に固定しておく。次のローテーション（2027-01）前に 2026-10 への
// 動作確認・移行を検討すること。
const POLAR_API_VERSION = "2026-04";

let client: Polar | null = null;

// Lazy init: `next build` imports this module during route/page-data
// collection with no runtime env, so the token must NOT be required at module
// evaluation (a top-level throw crashed `next build` with "Failed to collect
// configuration for /api/checkout/polar"). It's only actually needed when a
// checkout / portal request calls Polar — check it there.
export function getPolarClient(): Polar {
  if (client) return client;
  const accessToken = process.env.POLAR_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("Missing POLAR_ACCESS_TOKEN environment variable.");
  }
  const httpClient = new HTTPClient();
  httpClient.addHook("beforeRequest", (req) => {
    req.headers.set("Polar-Version", POLAR_API_VERSION);
    return req;
  });
  client = new Polar({ accessToken, server, httpClient });
  return client;
}

// Plan ids "entry"/"standard"/"pro"/"master" double as the value written to
// profiles.subscription_tier on payment (see the webhook) — same convention
// the retired Stripe catalog used. "topup" is the one-time 120-credit charge
// and never touches subscription_tier.
export type PolarTier = "topup" | "entry" | "standard" | "pro" | "master" | "studio";

export type PolarProductConfig = {
  tier: PolarTier;
  credits: number;
  isSubscription: boolean;
};

// Every Polar product this app knows how to fulfil, keyed by its Polar
// product id (from POLAR_PRODUCT_IDS — synced from the live catalog, env-
// overridable). Any id not in this map fails closed: the checkout route
// rejects it as an unknown product and the webhook ignores its events.
const PRODUCT_SPECS: { id: string; config: PolarProductConfig }[] = [
  // 2026-09-23 改定: 床は Studio の 1.66 ¥/C（= credit_to_jpy knob）。段差は 2.48 → 1.66。
  { id: POLAR_PRODUCT_IDS.topup, config: { tier: "topup", credits: 300, isSubscription: false } },
  { id: POLAR_PRODUCT_IDS.entry, config: { tier: "entry", credits: 800, isSubscription: true } },
  { id: POLAR_PRODUCT_IDS.standard, config: { tier: "standard", credits: 2200, isSubscription: true } },
  { id: POLAR_PRODUCT_IDS.pro, config: { tier: "pro", credits: 5000, isSubscription: true } },
  { id: POLAR_PRODUCT_IDS.master, config: { tier: "master", credits: 11000, isSubscription: true } },
  { id: POLAR_PRODUCT_IDS.studio, config: { tier: "studio", credits: 18000, isSubscription: true } },
];

export const POLAR_PRODUCT_CONFIG: Record<string, PolarProductConfig> = Object.fromEntries(
  PRODUCT_SPECS.map((spec) => [spec.id, spec.config]),
);

export function polarProductConfig(productId: string | null | undefined): PolarProductConfig | null {
  if (!productId) return null;
  return POLAR_PRODUCT_CONFIG[productId] ?? null;
}

// Kept as a standalone helper (rather than inlining polarProductConfig at
// call sites) because the webhook and checkout route both resolved credits
// through this name before subscriptions existed.
export function creditsForPolarProduct(productId: string | null | undefined): number | null {
  return polarProductConfig(productId)?.credits ?? null;
}

export function tierForPolarProduct(productId: string | null | undefined): PolarTier | null {
  return polarProductConfig(productId)?.tier ?? null;
}

// --- One-time top-up: standing discount for active paid subscribers --------
//
// The Polar equivalent of the retired Stripe TOPUP_PRICE_BY_TIER dynamic
// pricing. Each id below is a Polar **Discount** (percentage, duration
// "once", restricted to the top-up product):
//   entry 10% / standard 20% / pro 30% / master 40% / studio 50%  off the ¥1,000 top-up
//   → ¥900 / ¥800 / ¥700 / ¥600 / ¥500（割引後の ¥/C がそのプラン自身の ¥/C を下回らない刻み）
//   2026-09-23 改定で作り直し（scripts/setup-polar-plans-2026-09.mjs）。
//
// Hardcoded (not env-driven) for the same reason as POLAR_PRODUCT_IDS: a
// stale POLAR_DISCOUNT_ID_TOPUP_* on Vercel was passing a *product* id as a
// discount id and 422-ing the whole checkout ("Discount does not exist").
// Synced 2026-08-28 via `node scripts/list-polar-discounts.mjs`. The
// checkout route also retries without the discount if Polar ever rejects it,
// so a bad id can never block a purchase.
export const POLAR_TOPUP_DISCOUNT_BY_TIER: Partial<Record<PolarTier, string>> = {
  entry: "f2649294-2ba1-4bb8-a047-4bfbaa7390b7",
  standard: "a53d227c-b6d2-4c03-b52d-bb454942074c",
  pro: "5202a661-44d6-450f-8676-f857938bd91f",
  master: "f24bd029-0f58-4ca2-9562-d779a8fe1992",
  studio: "7ce887f0-6fc1-4599-8a45-2d93fca1743c",
};

export function topupDiscountForTier(tier: string | null | undefined): string | null {
  if (!tier) return null;
  return POLAR_TOPUP_DISCOUNT_BY_TIER[tier as PolarTier] ?? null;
}

// Expected JPY charge for the one-time top-up by the buyer's current tier —
// mirrors the discount percentages above. Server-side use only (logging /
// sanity checks); the client keeps its own copy in useProfileCredits.ts for
// display. "free" and non-subscribers pay full price.
export const TOPUP_PRICE_JPY_BY_TIER: Record<string, number> = {
  free: 500,
  topup: 500,
  entry: 450,
  standard: 400,
  pro: 350,
  master: 250,
};
