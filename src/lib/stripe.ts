import "server-only";
import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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

// Numeric ordering used to tell an upgrade from a downgrade when a Customer
// Portal plan switch fires customer.subscription.updated (see the webhook).
export const SUBSCRIPTION_TIER_RANK: Record<SubscriptionTier, number> = {
  free: 0,
  entry: 1,
  standard: 2,
  pro: 3,
  master: 4,
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

// Self-heals a profile whose stripe_customer_id is null — this can happen if
// a customer was created directly in Stripe (e.g. by support) without the
// webhook ever writing it back, or if a past write to profiles failed after
// Stripe already had the customer. Rather than erroring, look the customer
// up by email and repair the row; only in the genuine "not found" case is
// the row corrected the other way (subscription_tier forced back to "free"),
// since a tier without a matching Stripe customer can't actually be billed.
export async function resolveStripeCustomerId(params: {
  userId: string;
  email: string | null | undefined;
  stripeCustomerId: string | null | undefined;
  subscriptionTier: SubscriptionTier | null | undefined;
}): Promise<{ customerId: string | null; tierWasReset: boolean }> {
  const { userId, email, stripeCustomerId, subscriptionTier } = params;

  if (stripeCustomerId) {
    return { customerId: stripeCustomerId, tierWasReset: false };
  }

  let foundCustomerId: string | null = null;

  if (email) {
    const existing = await stripe.customers.list({ email, limit: 1 });
    foundCustomerId = existing.data[0]?.id ?? null;
  }

  if (foundCustomerId) {
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ stripe_customer_id: foundCustomerId })
      .eq("id", userId);

    if (error) {
      console.error(
        `[resolveStripeCustomerId] failed to persist healed stripe_customer_id for user ${userId}:`,
        error.message,
      );
    }

    return { customerId: foundCustomerId, tierWasReset: false };
  }

  let tierWasReset = false;

  if (subscriptionTier && subscriptionTier !== "free") {
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ subscription_tier: "free" })
      .eq("id", userId);

    if (error) {
      console.error(
        `[resolveStripeCustomerId] failed to reset stale subscription_tier for user ${userId}:`,
        error.message,
      );
    } else {
      tierWasReset = true;
    }
  }

  return { customerId: null, tierWasReset };
}
