import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getPolarClient } from "@/lib/polar";
import { POLAR_DONATION_PRODUCT_ID } from "@/lib/polarProducts";
import { apiErrorResponse } from "@/lib/apiError";

// 寄付（支援）の Polar チェックアウト（2026-09-24、ホスト要望）。
//
// /api/checkout/polar と分けている理由:
//   * ログイン無しでも支援できるようにする（Bearer が付いていれば Polar の
//     customer に紐付けるだけで、無くても通す）。
//   * 金額は Pay-what-you-want 商品（POLAR_DONATION_PRODUCT_ID、JPY・下限 ¥100）
//     に `amount` を渡して決める。クレジット付与・tier 変更は一切しない
//     （webhook 側は productId が寄付商品なら "donation" として記録だけ）。
export const maxDuration = 30;

const LOG_PREFIX = "[checkout/donation]";
const SUCCESS_URL = "https://www.ullstudio.com/?donation=thanks#support";
const RETURN_URL = "https://www.ullstudio.com/#support";
const DONATION_MIN_JPY = 100;
const DONATION_MAX_JPY = 1_000_000;

export async function POST(request: Request) {
  let body: { amount?: unknown };
  try {
    body = await request.json();
  } catch (err) {
    return apiErrorResponse(err, "parse_body", 400, LOG_PREFIX);
  }
  const amount = typeof body.amount === "number" ? Math.round(body.amount) : NaN;
  if (!Number.isFinite(amount) || amount < DONATION_MIN_JPY || amount > DONATION_MAX_JPY) {
    return NextResponse.json(
      { error: `金額は ¥${DONATION_MIN_JPY.toLocaleString()} 〜 ¥${DONATION_MAX_JPY.toLocaleString()} で指定してください。` },
      { status: 400 },
    );
  }

  // 任意ログイン: 付いていれば Polar customer に紐付ける（ポータルで領収書が見える）。
  let userId: string | null = null;
  let email: string | undefined;
  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (accessToken && supabaseUrl && anonKey) {
    const { data } = await createClient(supabaseUrl, anonKey).auth.getUser(accessToken);
    if (data?.user) {
      userId = data.user.id;
      email = data.user.email ?? undefined;
    }
  }

  try {
    const polar = getPolarClient();
    const checkout = await polar.checkouts.create({
      products: [POLAR_DONATION_PRODUCT_ID],
      amount,
      successUrl: SUCCESS_URL,
      returnUrl: RETURN_URL,
      locale: "ja",
      ...(email ? { customerEmail: email } : {}),
      ...(userId ? { externalCustomerId: userId } : {}),
      metadata: { kind: "donation", ...(userId ? { userId } : {}) },
    });
    let checkoutUrl = checkout.url;
    try {
      const localized = new URL(checkout.url);
      localized.searchParams.set("locale", "ja");
      checkoutUrl = localized.toString();
    } catch {
      // as-is
    }
    return NextResponse.json({ checkoutUrl });
  } catch (err) {
    return apiErrorResponse(err, "create_checkout", 502, LOG_PREFIX);
  }
}
