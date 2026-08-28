import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { polar, polarProductConfig, topupDiscountForTier } from "@/lib/polar";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { apiErrorResponse } from "@/lib/apiError";

const LOG_PREFIX = "[checkout/polar]";

// Where Polar sends the customer back after a successful payment. A plain
// literal rather than derived from the request's origin — this app is only
// ever served from this one domain, and a fixed URL can't be spoofed into
// redirecting a real payment's success page somewhere unexpected.
const SUCCESS_URL = "https://www.ullstudio.com/?purchase=success";

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

  const supabase = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  }
  const user = userData.user;

  let body: { productId?: string };
  try {
    body = await request.json();
  } catch (err) {
    return apiErrorResponse(err, "parse_body", 400, LOG_PREFIX);
  }

  // Defaults to the 120-credit top-up when the client sends no productId
  // (see POLAR_PRODUCT_CONFIG in src/lib/polar.ts for the full catalog:
  // topup + the four subscription tiers).
  const productId = body.productId || process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_120;
  const config = polarProductConfig(productId);

  if (!productId || !config) {
    return NextResponse.json({ error: "不明な商品IDです。" }, { status: 400 });
  }

  // One-time top-up: an active paid subscriber gets their standing tier
  // discount (a Polar Discount object — applied automatically and locked so
  // the customer can't remove it). Read the tier with the service-role
  // client: the anon client above isn't carrying the user's JWT, so an
  // RLS-scoped read would come back empty. A reserved cancellation
  // (cancel_at_period_end) suspends the perk, matching CancellationWarningModal.
  let discountId: string | undefined;
  if (config.tier === "topup") {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("subscription_tier, cancel_at_period_end")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) {
      // Fall through at full price rather than block the purchase.
      console.error(`${LOG_PREFIX} could not read tier for ${user.id}:`, profileError.message);
    }

    const tier = (profile?.subscription_tier as string | null) ?? "free";
    const perkSuspended = Boolean(profile?.cancel_at_period_end);

    if (!perkSuspended) {
      discountId = topupDiscountForTier(tier) ?? undefined;
      if (tier !== "free" && !discountId) {
        console.warn(
          `${LOG_PREFIX} user ${user.id} is tier "${tier}" but POLAR_DISCOUNT_ID_TOPUP_${tier.toUpperCase()} ` +
            `is not set — charging full price.`,
        );
      }
    }
  }

  try {
    const checkout = await polar.checkouts.create({
      products: [productId],
      successUrl: SUCCESS_URL,
      customerEmail: user.email ?? undefined,
      ...(discountId ? { discountId } : {}),
      // Copied by Polar onto the resulting order *and* (for subscription
      // products) the subscription — this is how the webhook
      // (src/app/api/webhooks/polar/route.ts) knows which Supabase user to
      // credit, how many credits to grant, and which subscription_tier to
      // set once payment completes. The webhook still re-derives credits/
      // tier from the product id as the source of truth; these are a
      // convenience mirror, not trusted input.
      metadata: { userId: user.id, tier: config.tier, credits: config.credits },
    });

    return NextResponse.json({ checkoutUrl: checkout.url, url: checkout.url });
  } catch (err) {
    return apiErrorResponse(err, "create_checkout", 502, LOG_PREFIX);
  }
}
