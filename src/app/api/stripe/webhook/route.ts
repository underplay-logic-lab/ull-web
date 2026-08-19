import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const CREDIT_VALIDITY_DAYS = 180;

// Grants credits and pushes the expiry 180 days out from now — used both
// for one-time top-ups and every subscription renewal, so a subscriber's
// balance keeps rolling forward as long as they keep paying.
async function grantCreditsAndExtendExpiry(userId: string, creditsToAdd: number) {
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
    .update({ credits: newCredits, credits_expire_at: newExpiry.toISOString() })
    .eq("id", userId);

  if (updateError) {
    console.error("[stripe/webhook] failed to grant credits:", updateError.message);
    return false;
  }

  console.log(
    `[stripe/webhook] granted ${creditsToAdd} credits to user ${userId} (new balance: ${newCredits}, expires: ${newExpiry.toISOString()})`,
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

    if (userId && creditsToAdd > 0) {
      const granted = await grantCreditsAndExtendExpiry(userId, creditsToAdd);
      if (!granted) {
        return NextResponse.json({ error: "Credit grant failed." }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ received: true });
}
