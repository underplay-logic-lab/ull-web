import "server-only";
import { createPolar } from "@polar-sh/sdk/2026-10";
import { POLAR_PRODUCT_IDS } from "@/lib/polarProducts";

// "production" unless explicitly overridden — POLAR_SERVER is only meant
// for pointing this at Polar's sandbox during local/staging testing.
const environment = (process.env.POLAR_SERVER as "production" | "sandbox" | undefined) ?? "production";

// Polar の API は日付ベースで版を切る（四半期ごとに Current/Deprecated/Next が回る）。
// 2026-09-30: SDK 1.0（版ごとの import）＋ API 2026-10 へ移行。`@polar-sh/sdk/2026-10` から作った
// クライアントは Polar-Version ヘッダーを自動で付けるので、ローテーションで契約が黙って変わることはない。
// 次の版へ上げるときは import パスと下の定数（SDK を通さない fetch 用）と、Polar 管理画面の
// Webhook の API version を一緒に変える。2026-10 は 2027-01 に Deprecated、その次のローテーション（2027-04 頃）で使えなくなる見込み。
// フィールド名は SDK 1.0 から API どおりの snake_case（SDK は camelCase に変換しない）。
export const POLAR_API_VERSION = "2026-10";

type PolarClient = ReturnType<typeof createPolar>;
let client: PolarClient | null = null;

// Lazy init: `next build` imports this module during route/page-data
// collection with no runtime env, so the token must NOT be required at module
// evaluation (a top-level throw crashed `next build` with "Failed to collect
// configuration for /api/checkout/polar"). It's only actually needed when a
// checkout / portal request calls Polar — check it there.
export function getPolarClient(): PolarClient {
  if (client) return client;
  const accessToken = process.env.POLAR_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("Missing POLAR_ACCESS_TOKEN environment variable.");
  }
  // SDK 1.0 の既定タイムアウトは 5 秒と短い（決済画面の作成で超えると購入が止まる）ので余裕を持たせる。
  client = createPolar({ accessToken, environment, timeout: 30 });
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

// --- Entry subscription: first-purchase discount ----------------------------
//
// 2026-09-28 ホスト判断: 最初の購入が一番のハードルだが、無料クレジットを配ると捨てアカウントを呼ぶ。
// そこで「そのアカウントの最初の購入」だけ、エントリーの初月を ¥600 引き（¥1,980 → ¥1,380）にする。
// Polar の fixed ¥600・duration "once"（更新は通常価格）・エントリー商品限定。都度チャージは対象外。
// 資格（過去の注文が無い）は checkout route が polar_processed_orders で判定する。
// 作成: scripts/setup-polar-entry-first-month-discount.mjs
// 値引き額の表示用の値は src/lib/data.ts の ENTRY_FIRST_PURCHASE_OFF_JPY（クライアントから読むのでそちらに置く）。
export const ENTRY_FIRST_PURCHASE_DISCOUNT_ID = "7b39be43-9144-47e6-9952-9039f9ad4afa";

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
