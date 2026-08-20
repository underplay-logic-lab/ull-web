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
import { apiErrorResponse } from "@/lib/apiError";

const LOG_PREFIX = "[stripe/checkout]";

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get("authorization");
    const accessToken = authHeader?.replace(/^Bearer\s+/i, "");

    if (!accessToken) {
      return NextResponse.json(
        { error: "認証が必要です。", step: "missing_auth_header" },
        { status: 401 },
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !anonKey) {
      return NextResponse.json(
        {
          error: "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY",
          step: "env_check",
        },
        { status: 500 },
      );
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json(
        { error: "Missing SUPABASE_SERVICE_ROLE_KEY", step: "env_check" },
        { status: 500 },
      );
    }
    if (!process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json(
        { error: "Missing STRIPE_SECRET_KEY", step: "env_check" },
        { status: 500 },
      );
    }

    // Verify the caller's session server-side rather than trusting a
    // client-supplied user id.
    const supabase = createClient(supabaseUrl, anonKey);
    const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);

    if (userError || !userData?.user) {
      return apiErrorResponse(
        userError ?? new Error("No user returned for this session token."),
        "get_user",
        401,
        LOG_PREFIX,
      );
    }

    const user = userData.user;

    let body: { planId?: string };
    try {
      body = await request.json();
    } catch (err) {
      return apiErrorResponse(err, "parse_body", 400, LOG_PREFIX);
    }

    const planId = body.planId;
    const plan = planId ? STRIPE_PLAN_CATALOG[planId] : undefined;

    if (!planId || !plan) {
      return NextResponse.json(
        { error: "不明なプランです。", step: "resolve_plan" },
        { status: 400 },
      );
    }

    const { data: profile, error: profileError } = await getOrCreateProfile(
      user.id,
      "subscription_tier, stripe_customer_id",
    );

    if (profileError) {
      return apiErrorResponse(profileError, "load_profile", 500, LOG_PREFIX);
    }

    const tier = (profile?.subscription_tier as SubscriptionTier | null) ?? "free";
    const stripeCustomerId = profile?.stripe_customer_id as string | null | undefined;
    const origin = request.headers.get("origin") ?? new URL(request.url).origin;

    // Already on a paid tier and trying to buy another subscription plan:
    // send them to the Customer Portal to change/cancel instead of letting a
    // second, concurrent subscription (and a second monthly charge) happen.
    if (plan.mode === "subscription" && tier !== "free") {
      if (!stripeCustomerId) {
        return apiErrorResponse(
          new Error(`User ${user.id} has tier "${tier}" but no stripe_customer_id on file.`),
          "missing_stripe_customer_id",
          409,
          LOG_PREFIX,
        );
      }

      try {
        const portalSession = await createBillingPortalSession(
          stripeCustomerId,
          `${origin}/?portal=return#pricing`,
        );
        return NextResponse.json({ url: portalSession.url });
      } catch (err) {
        return apiErrorResponse(err, "create_portal_session", 500, LOG_PREFIX);
      }
    }

    // The one-time top-up is discounted for active subscribers.
    const amountJpy = planId === "topup" ? (TOPUP_PRICE_BY_TIER[tier] ?? plan.amountJpy) : plan.amountJpy;

    if (plan.mode === "subscription" && !plan.priceId) {
      return apiErrorResponse(
        new Error(`Plan "${planId}" is missing its Stripe priceId.`),
        "resolve_plan_price",
        500,
        LOG_PREFIX,
      );
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
      return apiErrorResponse(err, "create_checkout_session", 500, LOG_PREFIX);
    }
  } catch (err) {
    // Catch-all for anything unexpected that isn't already handled above.
    return apiErrorResponse(err, "unhandled", 500, LOG_PREFIX);
  }
}
