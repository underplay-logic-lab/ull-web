import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { polar, creditsForPolarProduct } from "@/lib/polar";
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

  // Defaults to the 120-credit top-up — the only Polar product currently
  // configured (see POLAR_PRODUCT_CREDITS in src/lib/polar.ts).
  const productId = body.productId || process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_120;

  if (!productId || creditsForPolarProduct(productId) === null) {
    return NextResponse.json({ error: "不明な商品IDです。" }, { status: 400 });
  }

  try {
    const checkout = await polar.checkouts.create({
      products: [productId],
      successUrl: SUCCESS_URL,
      customerEmail: user.email ?? undefined,
      // Copied onto the resulting order by Polar — this is how the webhook
      // (src/app/api/webhooks/polar/route.ts) knows which Supabase user to
      // credit once payment completes.
      metadata: { userId: user.id },
    });

    return NextResponse.json({ checkoutUrl: checkout.url, url: checkout.url });
  } catch (err) {
    return apiErrorResponse(err, "create_checkout", 502, LOG_PREFIX);
  }
}
