import { NextResponse } from "next/server";
import { validateEvent, WebhookVerificationError } from "@polar-sh/sdk/webhooks";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { polarProductConfig, tierForPolarProduct } from "@/lib/polar";

const LOG_PREFIX = "[webhooks/polar]";

type PolarEvent = ReturnType<typeof validateEvent>;
type OrderData = Extract<PolarEvent, { type: "order.paid" }>["data"];
type SubscriptionData = Extract<PolarEvent, { type: "subscription.canceled" }>["data"];

function metadataUserId(metadata: Record<string, unknown> | undefined | null): string | undefined {
  const value = metadata?.userId;
  return typeof value === "string" && value ? value : undefined;
}

export async function POST(request: Request) {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) {
    console.error(`${LOG_PREFIX} POLAR_WEBHOOK_SECRET is not configured.`);
    return NextResponse.json({ error: "Server is not configured." }, { status: 500 });
  }

  // Signature verification needs the exact raw bytes Polar signed — reading
  // this as text (not request.json()) preserves that; re-serializing a
  // parsed object could produce different byte content (key order,
  // whitespace) and fail verification even for a genuine event.
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let event: PolarEvent;
  try {
    event = validateEvent(rawBody, headers, secret);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      console.error(`${LOG_PREFIX} signature verification failed:`, err.message);
      return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
    }
    console.error(`${LOG_PREFIX} failed to parse event:`, err);
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  try {
    switch (event.type) {
      // "payment received, fully processed" — fires for the one-time top-up,
      // a subscription's first payment, and every subsequent monthly renewal
      // (each renewal is its own order). order.created / checkout.* fire
      // earlier, before payment is guaranteed, so crediting on those would
      // grant credits for orders that were never paid for.
      case "order.paid":
        return await handleOrderPaid(event.data);

      // Cancellation *reserved* — the subscriber keeps access (and their
      // tier/credits) until the period ends, but the daily login bonus
      // stops now, mirroring how the retired Stripe flow treated
      // cancel_at_period_end.
      case "subscription.canceled":
        return await handleSubscriptionCanceled(event.data);

      // Cancellation undone before the period ended — re-enable the bonus.
      case "subscription.uncanceled":
        return await handleSubscriptionUncanceled(event.data);

      // Access actually ended (period lapsed, or a failed-payment
      // revocation) — drop the subscriber back to the free tier.
      case "subscription.revoked":
        return await handleSubscriptionRevoked(event.data);

      default:
        return NextResponse.json({ ok: true, ignored: event.type });
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} unhandled error processing ${event.type}:`, err);
    return NextResponse.json({ error: "Webhook handler failed." }, { status: 500 });
  }
}

async function handleOrderPaid(order: OrderData) {
  const userId = metadataUserId(order.metadata) ?? metadataUserId(order.subscription?.metadata);
  // Prefer the order's own productId; fall back to the subscription's for
  // renewal orders where Polar may only carry it on the subscription.
  const config = polarProductConfig(order.productId ?? order.subscription?.productId);

  if (!userId) {
    console.error(`${LOG_PREFIX} order ${order.id} has no metadata.userId — cannot credit anyone.`);
    return NextResponse.json({ ok: true, skipped: "no_user_id" });
  }
  if (!config) {
    console.error(`${LOG_PREFIX} order ${order.id} has unrecognized productId ${order.productId}.`);
    return NextResponse.json({ ok: true, skipped: "unknown_product" });
  }

  // Assert the tier before the idempotency-guarded credit grant: setting a
  // column to a fixed value is naturally idempotent, so doing it here means
  // a webhook retry still repairs a drifted subscription_tier even once the
  // order itself is already recorded as processed. cancel_at_period_end is
  // cleared too — paying (initial or renewal) means the subscription is
  // live, so any stale cancellation reservation no longer applies.
  if (config.isSubscription) {
    const { error: tierError } = await supabaseAdmin
      .from("profiles")
      .update({ subscription_tier: config.tier, cancel_at_period_end: false })
      .eq("id", userId);

    if (tierError) {
      console.error(`${LOG_PREFIX} failed to set tier for user ${userId} (order ${order.id}):`, tierError.message);
      return NextResponse.json({ error: "Failed to set subscription tier." }, { status: 500 });
    }
  }

  // Idempotency: claim this order id before crediting anything. A unique-
  // violation here means a previous delivery (or a concurrent retry) of
  // this same event already claimed it, so this delivery skips crediting
  // rather than double-granting.
  const { error: claimError } = await supabaseAdmin
    .from("polar_processed_orders")
    .insert({ order_id: order.id, user_id: userId, credits_granted: config.credits });

  if (claimError) {
    if (claimError.code === "23505") {
      return NextResponse.json({ ok: true, skipped: "already_processed" });
    }
    console.error(`${LOG_PREFIX} failed to claim order ${order.id}:`, claimError.message);
    return NextResponse.json({ error: "Failed to record order." }, { status: 500 });
  }

  // Atomically adds the credits and rolls the 180-day expiry window forward
  // (see increment_profile_credits in
  // supabase/migrations/20260838000000_polar_subscription_credits.sql) —
  // one UPDATE, so a purchase can never bump the balance without also
  // extending its validity, for both top-ups and subscription renewals.
  const { error: creditError } = await supabaseAdmin.rpc("increment_profile_credits", {
    p_user_id: userId,
    p_amount: config.credits,
  });

  if (creditError) {
    console.error(`${LOG_PREFIX} failed to credit user ${userId} for order ${order.id}:`, creditError.message);
    return NextResponse.json({ error: "Failed to grant credits." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    userId,
    creditsGranted: config.credits,
    tier: config.isSubscription ? config.tier : undefined,
  });
}

async function handleSubscriptionCanceled(subscription: SubscriptionData) {
  const userId = metadataUserId(subscription.metadata);
  if (!userId) {
    console.error(`${LOG_PREFIX} subscription ${subscription.id} canceled but has no metadata.userId.`);
    return NextResponse.json({ ok: true, skipped: "no_user_id" });
  }

  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ cancel_at_period_end: true })
    .eq("id", userId);

  if (error) {
    console.error(`${LOG_PREFIX} failed to flag cancellation for user ${userId}:`, error.message);
    return NextResponse.json({ error: "Failed to record cancellation." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, userId, cancelAtPeriodEnd: true });
}

async function handleSubscriptionUncanceled(subscription: SubscriptionData) {
  const userId = metadataUserId(subscription.metadata);
  if (!userId) {
    console.error(`${LOG_PREFIX} subscription ${subscription.id} uncanceled but has no metadata.userId.`);
    return NextResponse.json({ ok: true, skipped: "no_user_id" });
  }

  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ cancel_at_period_end: false })
    .eq("id", userId);

  if (error) {
    console.error(`${LOG_PREFIX} failed to clear cancellation for user ${userId}:`, error.message);
    return NextResponse.json({ error: "Failed to clear cancellation." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, userId, cancelAtPeriodEnd: false });
}

async function handleSubscriptionRevoked(subscription: SubscriptionData) {
  const userId = metadataUserId(subscription.metadata);
  if (!userId) {
    console.error(`${LOG_PREFIX} subscription ${subscription.id} revoked but has no metadata.userId.`);
    return NextResponse.json({ ok: true, skipped: "no_user_id" });
  }

  const revokedTier = tierForPolarProduct(subscription.productId);

  // Only drop to free if the profile's current tier is the one this
  // subscription granted. A plan switch that Polar models as revoke-old +
  // create-new would otherwise let the stale revoke wipe the tier the new
  // subscription just set. Unknown product id → leave the profile alone.
  const { data: profile, error: readError } = await supabaseAdmin
    .from("profiles")
    .select("subscription_tier")
    .eq("id", userId)
    .maybeSingle();

  if (readError) {
    console.error(`${LOG_PREFIX} failed to load profile for revoked subscription (user ${userId}):`, readError.message);
    return NextResponse.json({ error: "Failed to load profile." }, { status: 500 });
  }

  if (!profile || profile.subscription_tier !== revokedTier) {
    return NextResponse.json({ ok: true, userId, skipped: "tier_not_current" });
  }

  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ subscription_tier: "free", cancel_at_period_end: false })
    .eq("id", userId);

  if (error) {
    console.error(`${LOG_PREFIX} failed to reset tier for revoked subscription (user ${userId}):`, error.message);
    return NextResponse.json({ error: "Failed to reset tier." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, userId, subscriptionTier: "free" });
}
