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

// Updates profiles and always logs the outcome — including the case where
// the update runs cleanly but matches zero rows (userId resolved to
// something that isn't actually a profile), which would otherwise look
// identical to a successful update from the caller's point of view.
async function updateProfile(
  userId: string,
  updates: Record<string, unknown>,
  context: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .update(updates)
    .eq("id", userId)
    .select("id");

  if (error) {
    console.error(
      `[stripe/webhook] ${context}: UPDATE failed for user ${userId} (fields: ${Object.keys(updates).join(", ")}):`,
      error.message,
    );
    return false;
  }

  const rowCount = data?.length ?? 0;
  console.log(
    `[stripe/webhook] ${context}: UPDATE matched ${rowCount} row(s) for user ${userId} (fields: ${Object.keys(updates).join(", ")}).`,
  );

  if (rowCount === 0) {
    console.error(
      `[stripe/webhook] ${context}: UPDATE matched 0 rows for user ${userId} — no such profile exists.`,
    );
  }

  return rowCount > 0;
}

async function findUserIdByEmail(email: string): Promise<string | null> {
  const normalized = email.toLowerCase();
  let page = 1;

  for (;;) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });

    if (error) {
      console.error(`[stripe/webhook] failed to list users while resolving email ${email}:`, error.message);
      return null;
    }

    const found = data.users.find((u) => u.email?.toLowerCase() === normalized);
    if (found) return found.id;
    if (data.users.length < 200) return null;
    page += 1;
  }
}

// subscription.metadata.userId is normally set at checkout time
// (subscription_data.metadata) and kept in sync on plan changes, but it can
// still go missing or stale — a subscription created directly in the Stripe
// Dashboard, an old test purchase that predates the current checkout flow,
// or metadata that was cleared some other way. Trusting it blindly means
// the whole event silently no-ops: the webhook still returns 200 (nothing
// throws), but nothing in Supabase gets touched. This resolves the user in
// three tiers, each a fallback for the last:
//   1. subscription.metadata.userId (fast path, no extra I/O)
//   2. profiles.stripe_customer_id === customerId (always set at checkout,
//      independent of subscription metadata)
//   3. the Stripe customer's email matched against Supabase auth users —
//      last resort, since it costs a Stripe API call plus a paginated
//      auth admin scan. On success this also backfills
//      profiles.stripe_customer_id so future events for this customer
//      resolve on tier 2 instead.
async function resolveUserIdForCustomer(
  customerId: string | null,
  metadataUserId: string | undefined,
): Promise<string | null> {
  if (metadataUserId) return metadataUserId;
  if (!customerId) return null;

  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  if (error) {
    console.error(
      `[stripe/webhook] failed to resolve user by stripe_customer_id ${customerId}:`,
      error.message,
    );
  } else if (profile?.id) {
    console.log(
      `[stripe/webhook] recovered user ${profile.id} for customer ${customerId} via stripe_customer_id fallback (subscription metadata.userId was missing).`,
    );
    return profile.id;
  }

  try {
    const customer = await stripe.customers.retrieve(customerId);
    const email = !customer.deleted ? customer.email : null;

    if (!email) {
      console.error(`[stripe/webhook] customer ${customerId} has no email to fall back on.`);
      return null;
    }

    const userId = await findUserIdByEmail(email);

    if (!userId) {
      console.error(
        `[stripe/webhook] no Supabase user matches email for customer ${customerId} — giving up.`,
      );
      return null;
    }

    console.log(
      `[stripe/webhook] recovered user ${userId} for customer ${customerId} via email fallback; backfilling stripe_customer_id.`,
    );

    await updateProfile(userId, { stripe_customer_id: customerId }, "email-fallback self-heal");

    return userId;
  } catch (err) {
    console.error(`[stripe/webhook] failed to fetch Stripe customer ${customerId} for email fallback:`, err);
    return null;
  }
}

type GrantOptions = {
  // Set profiles.subscription_tier — omitted (not undefined-but-passed) for
  // a one-time top-up, which keeps whatever tier the buyer already has.
  tier?: SubscriptionTier;
  stripeCustomerId?: string | null;
  // Set profiles.cancel_at_period_end in the same UPDATE as the credit
  // grant, so a plan-change event that also carries the subscription's
  // current cancellation-reservation state never applies one without the
  // other.
  cancelAtPeriodEnd?: boolean;
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

  const ok = await updateProfile(
    userId,
    {
      credits: newCredits,
      credits_expire_at: newExpiry.toISOString(),
      ...(options.tier ? { subscription_tier: options.tier } : {}),
      ...(options.stripeCustomerId ? { stripe_customer_id: options.stripeCustomerId } : {}),
      ...(options.cancelAtPeriodEnd !== undefined
        ? { cancel_at_period_end: options.cancelAtPeriodEnd }
        : {}),
    },
    "grantCredits",
  );

  if (!ok) return false;

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
      const customerId = resolveCustomerId(invoice.customer);
      const userId = await resolveUserIdForCustomer(customerId, subscriptionMetadata?.userId);

      if (!userId) {
        console.error(
          `[stripe/webhook] invoice.paid (renewal) for invoice ${invoice.id}: could not resolve a user ` +
            `(subscription metadata.userId missing and no profile matches stripe_customer_id ${customerId ?? "(none)"}) — skipping.`,
        );
      }

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

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = resolveCustomerId(subscription.customer);
    const cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end);
    const userId = await resolveUserIdForCustomer(customerId, subscription.metadata?.userId);

    if (!userId) {
      console.error(
        `[stripe/webhook] ${event.type} for subscription ${subscription.id}: could not resolve a user ` +
          `(metadata.userId missing and no profile matches stripe_customer_id ${customerId ?? "(none)"}) — skipping.`,
      );
    }

    // Skip past cancellation, which customer.subscription.deleted handles
    // on its own.
    if (userId && subscription.status !== "canceled") {
      const priceId = subscription.items.data[0]?.price?.id;
      const newTier = priceId ? TIER_BY_PRICE_ID[priceId] : undefined;

      // Compare against profiles.subscription_tier (the source of truth),
      // not the subscription's own metadata — that mirror can drift, and a
      // Customer Portal plan switch is exactly the kind of external change
      // that wouldn't have updated it yet.
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
      // method, cancel_at_period_end toggles) — only an actual plan change
      // goes through the tier/credit branch below.
      if (newTier && newTier !== currentTier) {
        const newPlan = STRIPE_PLAN_CATALOG[newTier];
        const isUpgrade = SUBSCRIPTION_TIER_RANK[newTier] > SUBSCRIPTION_TIER_RANK[currentTier];

        if (isUpgrade) {
          // Grant the new tier's full monthly credits immediately instead
          // of waiting for the next invoice.paid renewal, so an upgrade
          // takes effect right away rather than up to a month later.
          // grantCredits also updates subscription_tier, cancel_at_period_end,
          // and pushes credits_expire_at 180 days out — all in one UPDATE,
          // so a plan change can never land without the current
          // cancellation-reservation state.
          const granted = await grantCredits(userId, newPlan.credits, {
            tier: newTier,
            cancelAtPeriodEnd,
          });

          if (!granted) {
            throw new Error(`Upgrade credit grant failed for user ${userId} (-> ${newTier}).`);
          }
        } else {
          // A downgrade takes effect on tier alone — no immediate credit
          // grant, and the existing balance/expiry are left untouched.
          const ok = await updateProfile(
            userId,
            { subscription_tier: newTier, cancel_at_period_end: cancelAtPeriodEnd },
            "downgrade plan change",
          );

          if (!ok) {
            throw new Error(`Failed to update tier on plan change (user ${userId} -> ${newTier}).`);
          }
        }

        // Keep the subscription's own metadata in sync with the new plan,
        // so the next invoice.paid renewal grants the new plan's credits.
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
      } else {
        // No plan change — most commonly a Customer Portal "cancel at
        // period end" / "resume subscription" toggle, or a payment-method
        // update. This is the branch that actually has to fire for a
        // reservation to take effect: sync the flag on its own so it's
        // never silently skipped.
        const ok = await updateProfile(
          userId,
          { cancel_at_period_end: cancelAtPeriodEnd },
          "cancel_at_period_end sync",
        );

        if (!ok) {
          throw new Error(`Failed to sync cancel_at_period_end for user ${userId}.`);
        }
      }
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = resolveCustomerId(subscription.customer);
    const userId = await resolveUserIdForCustomer(customerId, subscription.metadata?.userId);

    if (!userId) {
      console.error(
        `[stripe/webhook] customer.subscription.deleted for subscription ${subscription.id}: could not resolve a user ` +
          `(metadata.userId missing and no profile matches stripe_customer_id ${customerId ?? "(none)"}) — skipping.`,
      );
    }

    if (userId) {
      const ok = await updateProfile(
        userId,
        { subscription_tier: "free" satisfies SubscriptionTier, cancel_at_period_end: false },
        "subscription deleted",
      );

      if (!ok) {
        throw new Error(`Failed to downgrade tier for user ${userId}.`);
      }

      console.log(`[stripe/webhook] subscription ended, reverted user ${userId} to free tier`);
    }
  }
}
