import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe, type SubscriptionTier } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const CREDIT_VALIDITY_DAYS = 180;
const SUBSCRIPTION_TIERS = new Set<SubscriptionTier>(["entry", "standard", "pro", "master"]);

// Grants credits and pushes the expiry 180 days out from now — used both
// for one-time top-ups and every subscription renewal, so a subscriber's
// balance keeps rolling forward as long as they keep paying. Also updates
// subscription_tier when a subscription plan's credits are being granted.
async function grantCreditsAndExtendExpiry(
  userId: string,
  creditsToAdd: number,
  tier?: SubscriptionTier,
) {
  const { data: profile, error: fetchError } = await supabaseAdmin
    .from("profiles")
    .select("credits")
    .eq("id", userId)
    .single();

  if (fetchError) {
    console.error("[stripe/webhook] failed to load profile:", fetchError.message);
    return false;
  }

  const newCredits = (profile?.credits ?? 0) + creditsToAdd;
  const newExpiry = new Date(Date.now() + CREDIT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  const { error: updateError } = await supabaseAdmin
    .from("profiles")
    .update({
      credits: newCredits,
      credits_expire_at: newExpiry.toISOString(),
      ...(tier ? { subscription_tier: tier } : {}),
    })
    .eq("id", userId);

  if (updateError) {
    console.error("[stripe/webhook] failed to grant credits:", updateError.message);
    return false;
  }

  console.log(
    `[stripe/webhook] granted ${creditsToAdd} credits to user ${userId} (new balance: ${newCredits}, expires: ${newExpiry.toISOString()}${tier ? `, tier: ${tier}` : ""})`,
  );
  return true;
}

export async function POST(request: Request) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[stripe/webhook] STRIPE_WEBHOOK_SECRET is not configured.");
    return NextResponse.json({ error: "Webhook not configured." }, { status: 500 });
  }

  const signature = request.headers.get("stripe-signature");
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    if (!signature) throw new Error("Missing stripe-signature header.");
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("[stripe/webhook] signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    // Subscription-mode checkouts are granted via `invoice.paid` instead
    // (below), so the same first payment isn't credited twice: Stripe also
    // fires invoice.paid for a subscription's initial invoice.
    if (session.mode === "payment") {
      const userId = session.metadata?.userId;
      const creditsToAdd = Number(session.metadata?.credits ?? "0");

      if (userId && creditsToAdd > 0) {
        const granted = await grantCreditsAndExtendExpiry(userId, creditsToAdd);
        if (!granted) {
          return NextResponse.json({ error: "Credit grant failed." }, { status: 500 });
        }
      }
    }
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data.object as Stripe.Invoice;
    const subscriptionMetadata = invoice.parent?.subscription_details?.metadata;

    const userId = subscriptionMetadata?.userId;
    const creditsToAdd = Number(subscriptionMetadata?.credits ?? "0");
    const planId = subscriptionMetadata?.planId as SubscriptionTier | undefined;
    const tier = planId && SUBSCRIPTION_TIERS.has(planId) ? planId : undefined;

    if (userId && creditsToAdd > 0) {
      const granted = await grantCreditsAndExtendExpiry(userId, creditsToAdd, tier);
      if (!granted) {
        return NextResponse.json({ error: "Credit grant failed." }, { status: 500 });
      }
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    const userId = subscription.metadata?.userId;

    if (userId) {
      const { error: downgradeError } = await supabaseAdmin
        .from("profiles")
        .update({ subscription_tier: "free" satisfies SubscriptionTier })
        .eq("id", userId);

      if (downgradeError) {
        console.error("[stripe/webhook] failed to downgrade tier:", downgradeError.message);
        return NextResponse.json({ error: "Tier downgrade failed." }, { status: 500 });
      }

      console.log(`[stripe/webhook] subscription ended, reverted user ${userId} to free tier`);
    }
  }

  return NextResponse.json({ received: true });
}
