import "server-only";
import { Polar } from "@polar-sh/sdk";
import { POLAR_PRODUCT_IDS } from "@/lib/polarProducts";

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
// product id (from POLAR_PRODUCT_IDS — synced from the live catalog, env-
// overridable). Any id not in this map fails closed: the checkout route
// rejects it as an unknown product and the webhook ignores its events.
const PRODUCT_SPECS: { id: string; config: PolarProductConfig }[] = [
  { id: POLAR_PRODUCT_IDS.topup, config: { tier: "topup", credits: 120, isSubscription: false } },
  { id: POLAR_PRODUCT_IDS.entry, config: { tier: "entry", credits: 300, isSubscription: true } },
  { id: POLAR_PRODUCT_IDS.standard, config: { tier: "standard", credits: 1000, isSubscription: true } },
  { id: POLAR_PRODUCT_IDS.pro, config: { tier: "pro", credits: 2500, isSubscription: true } },
  { id: POLAR_PRODUCT_IDS.master, config: { tier: "master", credits: 6000, isSubscription: true } },
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
//   entry 10% / standard 20% / pro 30% / master 50%  off the ¥500 top-up
//   → ¥450 / ¥400 / ¥350 / ¥250
//
// Hardcoded (not env-driven) for the same reason as POLAR_PRODUCT_IDS: a
// stale POLAR_DISCOUNT_ID_TOPUP_* on Vercel was passing a *product* id as a
// discount id and 422-ing the whole checkout ("Discount does not exist").
// Synced 2026-08-28 via `node scripts/list-polar-discounts.mjs`. The
// checkout route also retries without the discount if Polar ever rejects it,
// so a bad id can never block a purchase.
export const POLAR_TOPUP_DISCOUNT_BY_TIER: Partial<Record<PolarTier, string>> = {
  entry: "c5909070-dea3-4f4a-8eb9-b782c5e0a0cd",
  standard: "05049632-034e-42c9-86ea-b121761150f8",
  pro: "c72ee18a-10cc-403c-8efc-52b6dcee8ec9",
  master: "9275be13-4a6b-4f2c-83d1-142a74eeb2c1",
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
