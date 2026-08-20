import { NextResponse } from "next/server";
import type Stripe from "stripe";
import {
  stripe,
  STRIPE_PLAN_CATALOG,
  TIER_BY_PRICE_ID,
  SUBSCRIPTION_TIER_RANK,
  type SubscriptionTier,
} from "@/lib/stripe";
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

  // Every branch below writes to Supabase and none of it is expected to
  // throw synchronously, but a malformed/unexpected Stripe payload could
  // still do so — and an uncaught throw here means Stripe just sees a
  // generic 500 with nothing in our own logs to explain why a purchase's
  // credits never landed. Wrap the whole dispatch so any such failure is
  // logged with the event id/type before Stripe retries.
  try {
    await handleEvent(event);
  } catch (err) {
    console.error(
      `[stripe/webhook] unhandled error processing event ${event.id} (${event.type}):`,
      err,
    );
    return NextResponse.json({ error: "Webhook handler failed." }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function handleEvent(event: Stripe.Event): Promise<void> {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    // Grant on any completed Checkout — top-up ("payment" mode) or a new
    // subscription's first payment ("subscription" mode) alike — as long as
    // we know who to credit. Gating this on creditsToAdd > 0 previously
    // meant a session whose credits metadata failed to parse silently
    // skipped the stripe_customer_id/expiry updates too; now those always
    // happen whenever userId is present.
    const userId = session.metadata?.userId;

    console.log(
      `[stripe/webhook] checkout.session.completed: session=${session.id} mode=${session.mode} userId=${userId ?? "(none)"} metadata=${JSON.stringify(session.metadata)}`,
    );

    if (!userId) {
      console.error(
        `[stripe/webhook] checkout.session.completed ${session.id} has no metadata.userId — cannot credit anyone.`,
      );
    } else {
      const planId = session.metadata?.planId;
      const creditsToAdd = parseInt(session.metadata?.credits || "0", 10) || 0;

      // A one-time top-up must never touch subscription_tier — a master
      // subscriber buying a discounted top-up stays on "master". Only a
      // subscription-mode session (new subscription or an existing one
      // re-run through Checkout) is allowed to set a tier, and only to a
      // recognized plan id (resolveTier returns undefined otherwise).
      const tier = session.mode === "subscription" ? resolveTier(planId) : undefined;

      const granted = await grantCredits(userId, creditsToAdd, {
        tier,
        stripeCustomerId: resolveCustomerId(session.customer),
      });

      if (!granted) {
        throw new Error(`Credit grant failed for session ${session.id} (user ${userId}).`);
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
          throw new Error(
            `Failed to load profile for renewal credit grant (user ${userId}): ${profileError.message}`,
          );
        }

        const tier = profile?.subscription_tier as SubscriptionTier | undefined;
        const creditsToAdd = tier ? (STRIPE_PLAN_CATALOG[tier]?.credits ?? 0) : 0;

        if (creditsToAdd > 0) {
          const granted = await grantCredits(userId, creditsToAdd, {
            stripeCustomerId: resolveCustomerId(invoice.customer),
          });

          if (!granted) {
            throw new Error(`Renewal credit grant failed for user ${userId}.`);
          }
        }
      }
    }
  }

  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription;
    const userId = subscription.metadata?.userId;

    // Skip past cancellation, which customer.subscription.deleted handles
    // on its own.
    if (userId && subscription.status !== "canceled") {
      // Sync the "cancel at period end" reservation flag on every update —
      // toggling it in the Customer Portal fires this event without
      // necessarily changing the price/tier, and the daily login bonus
      // route needs to see it immediately (bonus stops the moment a
      // cancellation is reserved, not at period end). Non-fatal on failure
      // so a hiccup here doesn't block the tier/credit logic below.
      const { error: cancelFlagError } = await supabaseAdmin
        .from("profiles")
        .update({ cancel_at_period_end: subscription.cancel_at_period_end })
        .eq("id", userId);

      if (cancelFlagError) {
        console.error(
          "[stripe/webhook] failed to sync cancel_at_period_end:",
          cancelFlagError.message,
        );
      }

      const priceId = subscription.items.data[0]?.price?.id;
      const newTier = priceId ? TIER_BY_PRICE_ID[priceId] : undefined;

      if (newTier) {
        // Compare against profiles.subscription_tier (the source of truth),
        // not the subscription's own metadata — that mirror can drift, and
        // a Customer Portal plan switch is exactly the kind of external
        // change that wouldn't have updated it yet.
        const { data: profile, error: profileError } = await supabaseAdmin
          .from("profiles")
          .select("subscription_tier")
          .eq("id", userId)
          .single();

        if (profileError) {
          throw new Error(
            `Failed to load profile for plan-change check (user ${userId}): ${profileError.message}`,
          );
        }

        const currentTier = (profile?.subscription_tier as SubscriptionTier | undefined) ?? "free";

        // subscription.updated also fires for unrelated changes (payment
        // method, cancel_at_period_end toggles) — only act on an actual
        // plan change.
        if (newTier !== currentTier) {
          const newPlan = STRIPE_PLAN_CATALOG[newTier];
          const isUpgrade = SUBSCRIPTION_TIER_RANK[newTier] > SUBSCRIPTION_TIER_RANK[currentTier];

          if (isUpgrade) {
            // Grant the new tier's full monthly credits immediately
            // instead of waiting for the next invoice.paid renewal, so an
            // upgrade takes effect right away rather than up to a month
            // later. grantCredits also updates subscription_tier and
            // pushes credits_expire_at 180 days out.
            const granted = await grantCredits(userId, newPlan.credits, { tier: newTier });

            if (!granted) {
              throw new Error(`Upgrade credit grant failed for user ${userId} (-> ${newTier}).`);
            }
          } else {
            // A downgrade takes effect on tier alone — no immediate credit
            // grant, and the existing balance/expiry are left untouched.
            const { error: tierError } = await supabaseAdmin
              .from("profiles")
              .update({ subscription_tier: newTier })
              .eq("id", userId);

            if (tierError) {
              throw new Error(
                `Failed to update tier on plan change (user ${userId} -> ${newTier}): ${tierError.message}`,
              );
            }
          }

          // Keep the subscription's own metadata in sync with the new
          // plan, so the next invoice.paid renewal grants the new plan's
          // credits.
          try {
            await stripe.subscriptions.update(subscription.id, {
              metadata: { userId, planId: newTier, credits: String(newPlan.credits) },
            });
          } catch (err) {
            console.error("[stripe/webhook] failed to sync subscription metadata:", err);
          }

          console.log(
            `[stripe/webhook] user ${userId} switched plans: ${currentTier} -> ${newTier}${isUpgrade ? " (upgrade, credits granted immediately)" : ""}`,
          );
        }
      }
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    const userId = subscription.metadata?.userId;

    if (userId) {
      const { error: downgradeError } = await supabaseAdmin
        .from("profiles")
        .update({
          subscription_tier: "free" satisfies SubscriptionTier,
          cancel_at_period_end: false,
        })
        .eq("id", userId);

      if (downgradeError) {
        throw new Error(`Failed to downgrade tier for user ${userId}: ${downgradeError.message}`);
      }

      console.log(`[stripe/webhook] subscription ended, reverted user ${userId} to free tier`);
    }
  }
}
