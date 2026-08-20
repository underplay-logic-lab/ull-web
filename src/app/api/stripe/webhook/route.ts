import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe, STRIPE_PLAN_CATALOG, TIER_BY_PRICE_ID, type SubscriptionTier } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const CREDIT_VALIDITY_DAYS = 180;
const SUBSCRIPTION_TIERS = new Set<SubscriptionTier>(["entry", "standard", "pro", "master"]);

function resolveTier(planId: string | undefined): SubscriptionTier | undefined {
  return planId && SUBSCRIPTION_TIERS.has(planId as SubscriptionTier)
    ? (planId as SubscriptionTier)
    : undefined;
}

function resolveCustomerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined) {
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

type GrantOptions = {
  // Set profiles.subscription_tier — omitted (not undefined-but-passed) for
  // a one-time top-up, which keeps whatever tier the buyer already has.
  tier?: SubscriptionTier;
  stripeCustomerId?: string | null;
};

// Grants credits and pushes the expiry 180 days out from now. Used for the
// initial checkout (top-up or first subscription payment) and every
// subsequent subscription renewal, so a subscriber's balance keeps rolling
// forward as long as they keep paying.
async function grantCredits(userId: string, creditsToAdd: number, options: GrantOptions = {}) {
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
      ...(options.tier ? { subscription_tier: options.tier } : {}),
      ...(options.stripeCustomerId ? { stripe_customer_id: options.stripeCustomerId } : {}),
    })
    .eq("id", userId);

  if (updateError) {
    console.error("[stripe/webhook] failed to grant credits:", updateError.message);
    return false;
  }

  console.log(
    `[stripe/webhook] granted ${creditsToAdd} credits to user ${userId} (new balance: ${newCredits}, expires: ${newExpiry.toISOString()}${options.tier ? `, tier: ${options.tier}` : ""})`,
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

    // Grant on any completed Checkout — top-up ("payment" mode) or a new
    // subscription's first payment ("subscription" mode) alike — as long as
    // we know who to credit. Gating this on creditsToAdd > 0 previously
    // meant a session whose credits metadata failed to parse silently
    // skipped the stripe_customer_id/expiry updates too; now those always
    // happen whenever userId is present.
    const userId = session.metadata?.userId;

    if (userId) {
      const planId = session.metadata?.planId;
      const creditsToAdd = parseInt(session.metadata?.credits || "0", 10) || 0;

      const granted = await grantCredits(userId, creditsToAdd, {
        // A one-time top-up (or an unresolvable planId) doesn't change tier
        // — resolveTier returns undefined, leaving the existing tier alone.
        tier: resolveTier(planId),
        stripeCustomerId: resolveCustomerId(session.customer),
      });

      if (!granted) {
        return NextResponse.json({ error: "Credit grant failed." }, { status: 500 });
      }
    }
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data.object as Stripe.Invoice;

    // The first invoice on a new subscription is already credited above via
    // checkout.session.completed — crediting it again here would double
    // the initial grant. Only a genuine monthly renewal should land here;
    // other reasons (e.g. "subscription_update" from a mid-cycle plan
    // swap/proration) are deliberately excluded too.
    if (invoice.billing_reason === "subscription_cycle") {
      const subscriptionMetadata = invoice.parent?.subscription_details?.metadata;
      const userId = subscriptionMetadata?.userId;

      if (userId) {
        // Look up the credit amount from the user's current tier on file
        // rather than the subscription's own metadata, so a renewal always
        // grants the right amount even if that metadata ever drifts out of
        // sync with the actual subscribed price.
        const { data: profile, error: profileError } = await supabaseAdmin
          .from("profiles")
          .select("subscription_tier")
          .eq("id", userId)
          .single();

        if (profileError) {
          console.error(
            "[stripe/webhook] failed to load profile for renewal credit grant:",
            profileError.message,
          );
          return NextResponse.json({ error: "Profile lookup failed." }, { status: 500 });
        }

        const tier = profile?.subscription_tier as SubscriptionTier | undefined;
        const creditsToAdd = tier ? (STRIPE_PLAN_CATALOG[tier]?.credits ?? 0) : 0;

        if (creditsToAdd > 0) {
          const granted = await grantCredits(userId, creditsToAdd, {
            stripeCustomerId: resolveCustomerId(invoice.customer),
          });

          if (!granted) {
            return NextResponse.json({ error: "Credit grant failed." }, { status: 500 });
          }
        }
      }
    }
  }

  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription;
    const userId = subscription.metadata?.userId;
    const priceId = subscription.items.data[0]?.price?.id;
    const newTier = priceId ? TIER_BY_PRICE_ID[priceId] : undefined;
    const previousPlanId = subscription.metadata?.planId;

    // Only act when the price actually changed from what we last recorded
    // (subscription.updated also fires for unrelated changes like payment
    // method or cancel_at_period_end toggles) — and skip past cancellation,
    // which customer.subscription.deleted handles on its own.
    if (userId && newTier && newTier !== previousPlanId && subscription.status !== "canceled") {
      const newPlan = STRIPE_PLAN_CATALOG[newTier];

      const { error: tierError } = await supabaseAdmin
        .from("profiles")
        .update({ subscription_tier: newTier })
        .eq("id", userId);

      if (tierError) {
        console.error("[stripe/webhook] failed to update tier on plan change:", tierError.message);
        return NextResponse.json({ error: "Tier update failed." }, { status: 500 });
      }

      // Keep the subscription's own metadata in sync with the new plan, so
      // the next invoice.paid renewal grants the new plan's credits instead
      // of the stale amount from whatever plan the subscription started on.
      try {
        await stripe.subscriptions.update(subscription.id, {
          metadata: { userId, planId: newTier, credits: String(newPlan.credits) },
        });
      } catch (err) {
        console.error("[stripe/webhook] failed to sync subscription metadata:", err);
      }

      console.log(
        `[stripe/webhook] user ${userId} switched plans: ${previousPlanId ?? "unknown"} -> ${newTier}`,
      );
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
