import "server-only";
import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY environment variable.");
}

export const stripe = new Stripe(stripeSecretKey);

export type SubscriptionTier = "free" | "entry" | "standard";

export type StripePlan = {
  name: string;
  mode: "payment" | "subscription";
  // Base/default price. The "topup" plan's actual charge is looked up in
  // TOPUP_PRICE_BY_TIER at checkout time instead — see the checkout route.
  amountJpy: number;
  credits: number;
  recurringInterval?: "month";
};

// Source of truth for what a given Pricing plan actually charges and grants.
// Never trust a client-supplied price/credit amount — always look it up here.
// Plan ids "entry" and "standard" double as the subscription_tier values
// granted on payment (see the webhook).
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
  },
  standard: {
    name: "月額スタンダード",
    mode: "subscription",
    amountJpy: 2480,
    credits: 1000,
    recurringInterval: "month",
  },
};

// Discounted one-time top-up price by the buyer's current subscription tier.
export const TOPUP_PRICE_BY_TIER: Record<SubscriptionTier, number> = {
  free: 500,
  entry: 400,
  standard: 300,
};

// Credits auto-granted the first time a member logs in on a given day.
export const DAILY_BONUS_BY_TIER: Record<SubscriptionTier, number> = {
  free: 0,
  entry: 1,
  standard: 3,
};
