import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createBillingPortalSession, resolveStripeCustomerId, type SubscriptionTier } from "@/lib/stripe";
import { getOrCreateProfile } from "@/lib/profile";
import { apiErrorResponse } from "@/lib/apiError";

const LOG_PREFIX = "[stripe/portal]";

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

    const { data: profile, error: profileError } = await getOrCreateProfile(
      userData.user.id,
      "stripe_customer_id, subscription_tier",
    );

    if (profileError) {
      return apiErrorResponse(profileError, "load_profile", 500, LOG_PREFIX);
    }

    let stripeCustomerId = profile?.stripe_customer_id as string | null | undefined;
    const subscriptionTier = profile?.subscription_tier as SubscriptionTier | null | undefined;

    if (!stripeCustomerId) {
      try {
        const healed = await resolveStripeCustomerId({
          userId: userData.user.id,
          email: userData.user.email,
          stripeCustomerId,
          subscriptionTier,
        });
        stripeCustomerId = healed.customerId ?? undefined;
      } catch (err) {
        return apiErrorResponse(err, "resolve_stripe_customer_id", 500, LOG_PREFIX);
      }
    }

    if (!stripeCustomerId) {
      return NextResponse.json(
        {
          error: "決済情報が見つかりません。まずはプランをご購入ください。",
          step: "missing_stripe_customer_id",
        },
        { status: 400 },
      );
    }

    const origin = request.headers.get("origin") ?? new URL(request.url).origin;

    try {
      const session = await createBillingPortalSession(
        stripeCustomerId,
        `${origin}/?portal=return#pricing`,
      );

      return NextResponse.json({ url: session.url });
    } catch (err) {
      return apiErrorResponse(err, "create_portal_session", 500, LOG_PREFIX);
    }
  } catch (err) {
    return apiErrorResponse(err, "unhandled", 500, LOG_PREFIX);
  }
}
