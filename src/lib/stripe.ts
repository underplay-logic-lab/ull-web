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
  "credits-100": {
    name: "都度チャージ / 100 Credits",
    mode: "payment",
    amountJpy: 500,
    credits: 100,
  },
  "standard-monthly": {
    name: "月額スタンダード",
    mode: "subscription",
    amountJpy: 1980,
    credits: 500,
    recurringInterval: "month",
  },
  "pro-monthly": {
    name: "月額プロ",
    mode: "subscription",
    amountJpy: 4980,
    credits: 1500,
    recurringInterval: "month",
  },
};
