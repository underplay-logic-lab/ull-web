import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  stripe,
  createBillingPortalSession,
  STRIPE_PLAN_CATALOG,
  TOPUP_PRICE_BY_TIER,
  type SubscriptionTier,
} from "@/lib/stripe";
import { getOrCreateProfile } from "@/lib/profile";

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  const accessToken = authHeader?.replace(/^Bearer\s+/i, "");

  if (!accessToken) {
    return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
  }

  // Verify the caller's session server-side rather than trusting a
  // client-supplied user id.
  const supabase = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);

  if (userError || !userData?.user) {
    return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  }

  const user = userData.user;

  let body: { planId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "リクエストの形式が正しくありません。" },
      { status: 400 },
    );
  }

  const planId = body.planId;
  const plan = planId ? STRIPE_PLAN_CATALOG[planId] : undefined;

  if (!planId || !plan) {
    return NextResponse.json({ error: "不明なプランです。" }, { status: 400 });
  }

  const { data: profile, error: profileError } = await getOrCreateProfile(
    user.id,
    "subscription_tier, stripe_customer_id",
  );

  if (profileError) {
    console.error("[stripe/checkout] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }

  const tier = (profile?.subscription_tier as SubscriptionTier | null) ?? "free";
  const stripeCustomerId = profile?.stripe_customer_id as string | null | undefined;
  const origin = request.headers.get("origin") ?? new URL(request.url).origin;

  // Already on a paid tier and trying to buy another subscription plan:
  // send them to the Customer Portal to change/cancel instead of letting a
  // second, concurrent subscription (and a second monthly charge) happen.
  if (plan.mode === "subscription" && tier !== "free") {
    if (!stripeCustomerId) {
      console.error(
        `[stripe/checkout] user ${user.id} has tier "${tier}" but no stripe_customer_id`,
      );
      return NextResponse.json(
        { error: "決済情報の確認に失敗しました。お手数ですがお問い合わせください。" },
        { status: 409 },
      );
    }

    try {
      const portalSession = await createBillingPortalSession(
        stripeCustomerId,
        `${origin}/?portal=return#pricing`,
      );
      return NextResponse.json({ url: portalSession.url });
    } catch (err) {
      console.error("[stripe/checkout] failed to create portal session:", err);
      return NextResponse.json(
        { error: "カスタマーポータルの起動に失敗しました。" },
        { status: 500 },
      );
    }
  }

  // The one-time top-up is discounted for active subscribers.
  const amountJpy = planId === "topup" ? (TOPUP_PRICE_BY_TIER[tier] ?? plan.amountJpy) : plan.amountJpy;

  if (plan.mode === "subscription" && !plan.priceId) {
    console.error(`[stripe/checkout] plan "${planId}" is missing its Stripe priceId`);
    return NextResponse.json({ error: "プランの設定エラーです。" }, { status: 500 });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: plan.mode,
      payment_method_types: ["card"],
      line_items: [
        plan.mode === "subscription"
          ? { price: plan.priceId as string, quantity: 1 }
          : {
              price_data: {
                currency: "jpy",
                product_data: { name: plan.name },
                unit_amount: amountJpy,
              },
              quantity: 1,
            },
      ],
      metadata: {
        userId: user.id,
        planId,
        credits: String(plan.credits),
      },
      ...(plan.mode === "subscription"
        ? {
            subscription_data: {
              metadata: {
                userId: user.id,
                planId,
                credits: String(plan.credits),
              },
            },
          }
        : {}),
      success_url: `${origin}/?checkout=success#pricing`,
      cancel_url: `${origin}/?checkout=cancelled#pricing`,
    });

    if (!session.url) {
      throw new Error("Checkout session was created without a redirect URL.");
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe/checkout] failed to create session:", err);
    return NextResponse.json(
      { error: "決済セッションの作成に失敗しました。" },
      { status: 500 },
    );
  }
}
