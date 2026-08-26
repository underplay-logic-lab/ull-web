import { NextResponse } from "next/server";
import { validateEvent, WebhookVerificationError } from "@polar-sh/sdk/webhooks";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { creditsForPolarProduct } from "@/lib/polar";

const LOG_PREFIX = "[webhooks/polar]";

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

  let event: ReturnType<typeof validateEvent>;
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

  // order.paid is the one event that means "payment received, fully
  // processed" (see WebhookOrderPaidPayload's own doc comment in the SDK) —
  // order.created/checkout.created both fire earlier, before/regardless of
  // whether payment actually succeeded, so crediting on either of those
  // would grant credits for orders that were never actually paid for.
  // Every other event type is acknowledged (200) but otherwise ignored.
  if (event.type !== "order.paid") {
    return NextResponse.json({ ok: true, ignored: event.type });
  }

  const order = event.data;
  const userId = order.metadata?.userId;
  const credits = creditsForPolarProduct(order.productId);

  if (typeof userId !== "string" || !userId) {
    console.error(`${LOG_PREFIX} order ${order.id} has no metadata.userId — cannot credit anyone.`);
    return NextResponse.json({ ok: true, skipped: "no_user_id" });
  }
  if (credits === null) {
    console.error(`${LOG_PREFIX} order ${order.id} has unrecognized productId ${order.productId}.`);
    return NextResponse.json({ ok: true, skipped: "unknown_product" });
  }

  // Idempotency: claim this order id before crediting anything. A unique-
  // violation here means a previous delivery (or a concurrent retry) of
  // this same event already claimed it, so this delivery skips crediting
  // rather than double-granting.
  const { error: claimError } = await supabaseAdmin
    .from("polar_processed_orders")
    .insert({ order_id: order.id, user_id: userId, credits_granted: credits });

  if (claimError) {
    if (claimError.code === "23505") {
      // Unique-constraint violation — already processed.
      return NextResponse.json({ ok: true, skipped: "already_processed" });
    }
    console.error(`${LOG_PREFIX} failed to claim order ${order.id}:`, claimError.message);
    return NextResponse.json({ error: "Failed to record order." }, { status: 500 });
  }

  const { error: creditError } = await supabaseAdmin.rpc("increment_profile_credits", {
    p_user_id: userId,
    p_amount: credits,
  });

  if (creditError) {
    console.error(`${LOG_PREFIX} failed to credit user ${userId} for order ${order.id}:`, creditError.message);
    return NextResponse.json({ error: "Failed to grant credits." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, userId, creditsGranted: credits });
}
