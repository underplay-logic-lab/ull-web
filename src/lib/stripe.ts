import "server-only";
import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY environment variable.");
}

export const stripe = new Stripe(stripeSecretKey);

export type SubscriptionTier = "free" | "entry" | "standard" | "pro" | "master";

export type StripePlan = {
  name: string;
  mode: "payment" | "subscription";
  // Base/default price. The "topup" plan's actual charge is looked up in
  // TOPUP_PRICE_BY_TIER at checkout time instead — see the checkout route.
  amountJpy: number;
  credits: number;
  recurringInterval?: "month";
  // Stable Stripe Price id for subscription plans (created once, see
  // scripts/README — the Customer Portal's plan-switch UI and the
  // customer.subscription.updated webhook both need a fixed price id to
  // resolve a tier from, which an inline price_data Checkout line item
  // can't provide since it mints a new anonymous price every time).
  priceId?: string;
};

// Source of truth for what a given Pricing plan actually charges and grants.
// Never trust a client-supplied price/credit amount — always look it up here.
// Plan ids "entry"/"standard"/"pro"/"master" double as the subscription_tier
// values granted on payment (see the webhook).
export const STRIPE_PLAN_CATALOG: Record<string, StripePlan> = {
  topup: {
    name: "都度チャージ / 120 Credits",
    mode: "payment",
    amountJpy: 500,
    credits: 120,
  },
  entry: {
    name: "月額エントリー",
    mode: "subscription",
    amountJpy: 980,
    credits: 300,
    recurringInterval: "month",
    priceId: "price_1U6CZeGuwRhQ0SSA4XHndvvP",
  },
  standard: {
    name: "月額スタンダード",
    mode: "subscription",
    amountJpy: 2480,
    credits: 1000,
    recurringInterval: "month",
    priceId: "price_1U6CZfGuwRhQ0SSAO76UwM41",
  },
  pro: {
    name: "月額プロ",
    mode: "subscription",
    amountJpy: 4980,
    credits: 2500,
    recurringInterval: "month",
    priceId: "price_1U6CZfGuwRhQ0SSAbn7EjFzI",
  },
  master: {
    name: "月額マスター",
    mode: "subscription",
    amountJpy: 9980,
    credits: 6000,
    recurringInterval: "month",
    priceId: "price_1U6CZgGuwRhQ0SSAE8eExuJN",
  },
};

// Reverse lookup used by the webhook to resolve a subscription's current
// Stripe price id back to our plan/tier id (e.g. after a Customer Portal
// plan swap fires customer.subscription.updated).
export const TIER_BY_PRICE_ID: Record<string, SubscriptionTier> = Object.fromEntries(
  Object.entries(STRIPE_PLAN_CATALOG)
    .filter(([, plan]) => plan.mode === "subscription" && plan.priceId)
    .map(([planId, plan]) => [plan.priceId as string, planId as SubscriptionTier]),
);

// Discounted one-time top-up price by the buyer's current subscription tier.
export const TOPUP_PRICE_BY_TIER: Record<SubscriptionTier, number> = {
  free: 500,
  entry: 450,
  standard: 400,
  pro: 350,
  master: 250,
};

// Credits auto-granted the first time a member logs in on a given day.
export const DAILY_BONUS_BY_TIER: Record<SubscriptionTier, number> = {
  free: 0,
  entry: 1,
  standard: 2,
  pro: 4,
  master: 10,
};

// Shared by /api/stripe/portal and /api/stripe/checkout's existing-subscriber
// redirect. Uses the pre-configured portal (plan switching enabled across
// the 4 subscription products) when STRIPE_PORTAL_CONFIGURATION_ID is set,
// otherwise falls back to the account's default configuration.
export async function createBillingPortalSession(customerId: string, returnUrl: string) {
  const configurationId = process.env.STRIPE_PORTAL_CONFIGURATION_ID;

  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
    ...(configurationId ? { configuration: configurationId } : {}),
  });
}
