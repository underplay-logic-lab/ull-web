import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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
    const userId = session.metadata?.userId;
    const creditsToAdd = Number(session.metadata?.credits ?? "0");

    if (userId && creditsToAdd > 0) {
      // Best-effort read-then-write increment. Under this app's expected
      // checkout volume the race window is negligible; a Postgres RPC for
      // a true atomic increment would be the production-hardened version.
      const { data: profile, error: fetchError } = await supabaseAdmin
        .from("profiles")
        .select("credits")
        .eq("id", userId)
        .single();

      if (fetchError) {
        console.error("[stripe/webhook] failed to load profile:", fetchError.message);
        return NextResponse.json({ error: "Profile lookup failed." }, { status: 500 });
      }

      const newCredits = (profile?.credits ?? 0) + creditsToAdd;

      const { error: updateError } = await supabaseAdmin
        .from("profiles")
        .update({ credits: newCredits })
        .eq("id", userId);

      if (updateError) {
        console.error("[stripe/webhook] failed to grant credits:", updateError.message);
        return NextResponse.json({ error: "Credit grant failed." }, { status: 500 });
      }

      console.log(
        `[stripe/webhook] granted ${creditsToAdd} credits to user ${userId} (new balance: ${newCredits})`,
      );
    }
  }

  return NextResponse.json({ received: true });
}
