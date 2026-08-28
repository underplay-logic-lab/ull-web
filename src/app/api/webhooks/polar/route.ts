import { NextResponse } from "next/server";
import { validateEvent, WebhookVerificationError } from "@polar-sh/sdk/webhooks";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { polarProductConfig, tierForPolarProduct } from "@/lib/polar";
import { apiErrorResponse } from "@/lib/apiError";

const LOG_PREFIX = "[webhooks/polar]";

type PolarEvent = ReturnType<typeof validateEvent>;
type OrderData = Extract<PolarEvent, { type: "order.paid" }>["data"];
type SubscriptionData = Extract<PolarEvent, { type: "subscription.canceled" }>["data"];

// Polar metadata values are string | number | boolean (see the SDK's
// MetadataOutputType). userId is always a UUID string when set by our
// checkout route; anything else means "not set / unusable" — resolve to
// undefined so the caller skips with a 200 rather than throwing a 500.
function metadataUserId(metadata: Record<string, unknown> | undefined | null): string | undefined {
  const value = metadata?.userId;
  if (typeof value === "string") return value.trim() || undefined;
  return undefined;
}

export async function POST(request: Request) {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) {
    console.error(`${LOG_PREFIX} POLAR_WEBHOOK_SECRET is not configured.`);
    return NextResponse.json({ error: "Server is not configured.", step: "config" }, { status: 500 });
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
      return NextResponse.json({ error: "Invalid signature.", step: "verify" }, { status: 403 });
    }
    console.error(`${LOG_PREFIX} failed to parse event:`, err);
    return apiErrorResponse(err, "parse_event", 400, LOG_PREFIX);
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
    // Any unexpected throw inside a handler — surface the full error (name,
    // message, and any code/details a Postgrest/SDK error carries) in both
    // the log and the response body so a failing delivery is diagnosable
    // straight from Polar's webhook dashboard.
    return apiErrorResponse(err, `handle_${event.type}`, 500, LOG_PREFIX);
  }
}

async function handleOrderPaid(order: OrderData) {
  const userId = metadataUserId(order.metadata) ?? metadataUserId(order.subscription?.metadata);
  // Prefer the order's own productId; fall back to the subscription's for
  // renewal orders where Polar may only carry it on the subscription.
  const productId = order.productId ?? order.subscription?.productId ?? null;
  const config = polarProductConfig(productId);

  if (!userId) {
    console.error(
      `${LOG_PREFIX} order ${order.id} has no usable metadata.userId ` +
        `(order.metadata=${JSON.stringify(order.metadata)}) — cannot credit anyone.`,
    );
    return NextResponse.json({ ok: true, skipped: "no_user_id", orderId: order.id });
  }
  if (!config) {
    console.error(`${LOG_PREFIX} order ${order.id} has unrecognized productId ${productId}.`);
    return NextResponse.json({ ok: true, skipped: "unknown_product", orderId: order.id, productId });
  }

  // Self-heal a missing profiles row (signup trigger never ran / predates
  // it) before the grant, so a genuinely paid order isn't rejected just
  // because the row isn't there yet.
  const { error: profileError } = await getOrCreateProfile(userId, "id");
  if (profileError) {
    console.error(`${LOG_PREFIX} order ${order.id}: getOrCreateProfile failed for ${userId}:`, profileError.message);
    return apiErrorResponse(profileError, "ensure_profile", 500, LOG_PREFIX);
  }

  // One atomic RPC does the whole thing: idempotency claim on order_id,
  // credit grant + 180-day expiry roll-forward, and (subscriptions only)
  // the subscription_tier / cancel_at_period_end update. Either all of it
  // commits or none of it does — a partial failure can never leave the
  // order recorded as processed but uncredited. See
  // supabase/migrations/20260839000000_polar_webhook_atomic_grant.sql.
  const tierArg = config.isSubscription ? config.tier : null;

  const { data, error } = await supabaseAdmin.rpc("grant_polar_order_credits", {
    p_order_id: order.id,
    p_user_id: userId,
    p_amount: config.credits,
    p_tier: tierArg,
  });

  if (error) {
    console.error(
      `${LOG_PREFIX} grant_polar_order_credits failed for order ${order.id} / user ${userId}:`,
      JSON.stringify({ message: error.message, code: error.code, details: error.details, hint: error.hint }),
    );
    return apiErrorResponse(error, "grant_polar_order_credits", 500, LOG_PREFIX);
  }

  const result = (data ?? {}) as { status?: string; credits?: number };

  if (result.status === "already_processed") {
    console.log(`${LOG_PREFIX} order ${order.id} already processed — skipping.`);
    return NextResponse.json({ ok: true, skipped: "already_processed", orderId: order.id });
  }

  console.log(
    `${LOG_PREFIX} order ${order.id}: granted ${config.credits} credits to ${userId}` +
      `${tierArg ? ` (tier ${tierArg})` : ""}; new balance ${result.credits ?? "?"}.`,
  );

  return NextResponse.json({
    ok: true,
    orderId: order.id,
    userId,
    creditsGranted: config.credits,
    balance: result.credits ?? null,
    tier: tierArg ?? undefined,
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
    return apiErrorResponse(error, "flag_cancellation", 500, LOG_PREFIX);
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
    return apiErrorResponse(error, "clear_cancellation", 500, LOG_PREFIX);
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
    return apiErrorResponse(readError, "load_profile_for_revoke", 500, LOG_PREFIX);
  }

  if (!profile || profile.subscription_tier !== revokedTier) {
    return NextResponse.json({ ok: true, userId, skipped: "tier_not_current" });
  }

  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ subscription_tier: "free", cancel_at_period_end: false })
    .eq("id", userId);

  if (error) {
    return apiErrorResponse(error, "reset_tier_on_revoke", 500, LOG_PREFIX);
  }

  return NextResponse.json({ ok: true, userId, subscriptionTier: "free" });
}
