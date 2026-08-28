import "server-only";
import { Polar } from "@polar-sh/sdk";

const accessToken = process.env.POLAR_ACCESS_TOKEN;

if (!accessToken) {
  throw new Error("Missing POLAR_ACCESS_TOKEN environment variable.");
}

// "production" unless explicitly overridden — POLAR_SERVER is only meant
// for pointing this at Polar's sandbox during local/staging testing.
const server = (process.env.POLAR_SERVER as "production" | "sandbox" | undefined) ?? "production";

export const polar = new Polar({ accessToken, server });

// Plan ids "entry"/"standard"/"pro"/"master" double as the value written to
// profiles.subscription_tier on payment (see the webhook) — same convention
// the retired Stripe catalog used. "topup" is the one-time 120-credit charge
// and never touches subscription_tier.
export type PolarTier = "topup" | "entry" | "standard" | "pro" | "master";

export type PolarProductConfig = {
  tier: PolarTier;
  credits: number;
  isSubscription: boolean;
};

// Every Polar product this app knows how to fulfil, keyed by its Polar
// product id. Product ids come from env so the exact same code runs against
// Polar's sandbox and production with different catalogs; an entry is only
// registered when its env var is actually set, so a missing/mistyped id
// fails closed — the checkout route rejects it as an unknown product and
// the webhook ignores its events — rather than granting the wrong thing.
type ProductEnvSpec = {
  env: string | undefined;
  tier: PolarTier;
  credits: number;
  isSubscription: boolean;
};

const PRODUCT_ENV_SPECS: ProductEnvSpec[] = [
  { env: process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_120, tier: "topup", credits: 120, isSubscription: false },
  { env: process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_ENTRY, tier: "entry", credits: 300, isSubscription: true },
  { env: process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_STANDARD, tier: "standard", credits: 1000, isSubscription: true },
  { env: process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_PRO, tier: "pro", credits: 2500, isSubscription: true },
  { env: process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_MASTER, tier: "master", credits: 6000, isSubscription: true },
];

export const POLAR_PRODUCT_CONFIG: Record<string, PolarProductConfig> = Object.fromEntries(
  PRODUCT_ENV_SPECS.filter(
    (spec): spec is ProductEnvSpec & { env: string } => Boolean(spec.env),
  ).map((spec) => [spec.env, { tier: spec.tier, credits: spec.credits, isSubscription: spec.isSubscription }]),
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
//   entry 10% / standard 20% / pro 30% / master 50%  off the ¥500 top-up
//   → ¥450 / ¥400 / ¥350 / ¥250
// The checkout route reads profiles.subscription_tier and, for a top-up
// bought by an active paid member, passes the matching discountId to
// polar.checkouts.create() — Polar then applies it automatically and the
// customer can't remove it. A missing env var just means "no discount"
// (falls open to full price), never a broken checkout.
export const POLAR_TOPUP_DISCOUNT_BY_TIER: Partial<Record<PolarTier, string>> = (() => {
  const specs: [PolarTier, string | undefined][] = [
    ["entry", process.env.POLAR_DISCOUNT_ID_TOPUP_ENTRY],
    ["standard", process.env.POLAR_DISCOUNT_ID_TOPUP_STANDARD],
    ["pro", process.env.POLAR_DISCOUNT_ID_TOPUP_PRO],
    ["master", process.env.POLAR_DISCOUNT_ID_TOPUP_MASTER],
  ];
  const map: Partial<Record<PolarTier, string>> = {};
  for (const [tier, id] of specs) {
    if (id) map[tier] = id;
  }
  return map;
})();

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
