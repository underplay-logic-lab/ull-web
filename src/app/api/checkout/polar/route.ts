import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getPolarClient, polarProductConfig, topupDiscountForTier } from "@/lib/polar";
import { POLAR_PRODUCT_IDS } from "@/lib/polarProducts";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { apiErrorResponse } from "@/lib/apiError";

const LOG_PREFIX = "[checkout/polar]";

// Where Polar sends the customer after a successful payment, and the "back"
// target in the checkout itself. Plain literals rather than derived from the
// request origin — this app is only ever served from this one domain, and a
// fixed URL can't be spoofed into redirecting a real payment's success page
// somewhere unexpected. Both land on the pricing section (there is no
// standalone /pricing route; it's the #pricing anchor on the home page).
// 購入後は Studio へ（2026-09-26 ホスト案: 使うために買っているので、料金欄に戻す理由が無い）。
const SUCCESS_URL = "https://www.ullstudio.com/?purchase=success#studio";
const RETURN_URL = "https://www.ullstudio.com/#pricing";

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

  let body: { productId?: string; replaceCurrent?: boolean };
  try {
    body = await request.json();
  } catch (err) {
    return apiErrorResponse(err, "parse_body", 400, LOG_PREFIX);
  }

  // Defaults to the 120-credit top-up when the client sends no productId
  // (see POLAR_PRODUCT_CONFIG in src/lib/polar.ts for the full catalog:
  // topup + the four subscription tiers).
  const productId = body.productId || POLAR_PRODUCT_IDS.topup;
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
          `${LOG_PREFIX} user ${user.id} is tier "${tier}" but no top-up discount is mapped for it ` +
            `(see POLAR_TOPUP_DISCOUNT_BY_TIER) — charging full price.`,
        );
      }
    }
  }

  try {
    const polar = getPolarClient();
    const createCheckout = (withDiscount: boolean) =>
      polar.checkouts.create({
        products: [productId],
        successUrl: SUCCESS_URL,
        returnUrl: RETURN_URL,
        // Render the hosted Polar checkout in Japanese.
        locale: "ja",
        customerEmail: user.email ?? undefined,
        // Links the Polar customer to the Supabase user id so /api/portal/polar
        // can mint a customer-portal session straight from external_customer_id
        // without us persisting a Polar customer id.
        externalCustomerId: user.id,
        ...(withDiscount && discountId ? { discountId } : {}),
        // Copied by Polar onto the resulting order *and* (for subscription
        // products) the subscription — this is how the webhook
        // (src/app/api/webhooks/polar/route.ts) knows which Supabase user to
        // credit, how many credits to grant, and which subscription_tier to
        // set once payment completes. The webhook still re-derives credits/
        // tier from the product id as the source of truth; these are a
        // convenience mirror, not trusted input.
        metadata: { userId: user.id, tier: config.tier, credits: config.credits },
      });

    // A rejected discount id (stale env, wrong id, "Discount does not exist"
    // 422, etc.) must never block a purchase — retry once at full price.
    let checkout: Awaited<ReturnType<typeof createCheckout>>;
    try {
      checkout = await createCheckout(Boolean(discountId));
    } catch (discountErr) {
      if (!discountId) throw discountErr;
      console.error(
        `${LOG_PREFIX} checkout with discount ${discountId} failed — retrying at full price:`,
        discountErr instanceof Error ? discountErr.message : discountErr,
      );
      checkout = await createCheckout(false);
    }

    // プラン変更・同じプランの買い直し（2026-09-26 ホスト方針）: 今の契約を即時終了してから新しい契約の
    // 支払い画面へ。Polar は有効なサブスクを 1 人 1 本しか許さない（allow_multiple_subscriptions=false の
    // まま＝二重請求が起きない）。クレジットは購入時に付与済みなので、終了で失うのは残り期間の特典だけ。
    // 支払い画面を作れてから終了させる（作れずに契約だけ消える事故を避ける）。購入をやめるとプランなしに
    // なるが、それは確認画面で伝えている。終了の webhook は「今の tier が終了した契約の tier のときだけ
    // free に戻す」ので、先に新しい契約が反映されても消されない。
    if (config.tier !== "topup") {
      const active = await listActiveSubscriptionIds(user.id);
      if (active.length > 0) {
        if (body.replaceCurrent !== true) {
          return NextResponse.json(
            { error: "すでにご契約中のプランがあります。", code: "has_active_subscription" },
            { status: 409 },
          );
        }
        for (const id of active) {
          await revokeSubscription(id);
          console.log(`${LOG_PREFIX} revoked subscription ${id} for ${user.id} before plan change/rebuy`);
        }
      }
    }

    // Belt-and-suspenders on top of the `locale: "ja"` create param: force
    // ?locale=ja onto the hosted checkout URL so the page always renders in
    // Japanese regardless of the visitor's browser locale.
    let checkoutUrl = checkout.url;
    try {
      const localized = new URL(checkout.url);
      localized.searchParams.set("locale", "ja");
      checkoutUrl = localized.toString();
    } catch {
      // checkout.url wasn't a parseable absolute URL — return it as-is.
    }

    return NextResponse.json({ checkoutUrl, url: checkoutUrl });
  } catch (err) {
    return apiErrorResponse(err, "create_checkout", 502, LOG_PREFIX);
  }
}

// Polar REST を直接叩く（SDK の型に頼らない小さな 2 本）。本番サーバー・API 版は getPolarClient と揃える。
const POLAR_API_BASE =
  (process.env.POLAR_SERVER || "production") === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";

async function polarRest(path: string, init: RequestInit = {}): Promise<Response> {
  const token = process.env.POLAR_ACCESS_TOKEN;
  if (!token) throw new Error("Missing POLAR_ACCESS_TOKEN environment variable.");
  return fetch(`${POLAR_API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Polar-Version": "2026-04", ...(init.headers ?? {}) },
  });
}

async function listActiveSubscriptionIds(userId: string): Promise<string[]> {
  const res = await polarRest(
    `/v1/subscriptions/?active=true&limit=10&external_customer_id=${encodeURIComponent(userId)}`,
  );
  if (!res.ok) throw new Error(`Polar subscriptions list failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items?: { id: string }[] };
  return (data.items ?? []).map((s) => s.id);
}

async function revokeSubscription(id: string): Promise<void> {
  const res = await polarRest(`/v1/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" });
  // 既に終わっている（404 / 403 already canceled）は目的どおりなので通す。
  if (!res.ok && res.status !== 404 && res.status !== 403) {
    throw new Error(`Polar subscription revoke failed: ${res.status} ${await res.text()}`);
  }
}
