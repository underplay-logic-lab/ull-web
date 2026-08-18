import "server-only";
import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY environment variable.");
}

export const stripe = new Stripe(stripeSecretKey);

export type StripePlan = {
  name: string;
  mode: "payment" | "subscription";
  amountJpy: number;
  credits: number;
  recurringInterval?: "month";
};

// Source of truth for what a given Pricing plan actually charges and grants.
// Never trust a client-supplied price/credit amount — always look it up here.
export const STRIPE_PLAN_CATALOG: Record<string, StripePlan> = {
  "credits-10": {
    name: "都度チャージ / 10 Credits",
    mode: "payment",
    amountJpy: 500,
    credits: 10,
  },
  "creator-pro": {
    name: "Creator Pro",
    mode: "subscription",
    amountJpy: 2000,
    credits: 0,
    recurringInterval: "month",
  },
};
