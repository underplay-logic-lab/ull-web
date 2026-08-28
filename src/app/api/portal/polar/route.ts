import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { polar } from "@/lib/polar";
import { apiErrorResponse } from "@/lib/apiError";

const LOG_PREFIX = "[portal/polar]";

// "Back" target shown inside the Polar-hosted customer portal (plan change,
// cancellation, payment method). The portal itself lives on Polar's domain;
// this is only where its back button returns to.
const RETURN_URL = "https://www.ullstudio.com/?portal=return#pricing";

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

  const notFound = () =>
    NextResponse.json(
      { error: "サブスクリプション情報が見つかりません。決済がまだ完了していない可能性があります。" },
      { status: 404 },
    );

  // Primary path: checkouts set external_customer_id = the Supabase user id
  // (see /api/checkout/polar), so a portal session can be minted straight
  // from that — no Polar customer id stored on our side.
  try {
    const session = await polar.customerSessions.create({
      externalCustomerId: user.id,
      returnUrl: RETURN_URL,
    });
    return NextResponse.json({ url: session.customerPortalUrl });
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} no customer for external id ${user.id}; falling back to email lookup:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Fallback: a customer created before external ids were set is only
  // findable by email. Link it (best effort) so the primary path works next
  // time, then mint the session by its Polar id.
  if (!user.email) return notFound();

  try {
    let customerId: string | undefined;
    const pages = await polar.customers.list({ email: user.email, limit: 1 });
    for await (const page of pages) {
      customerId = page.result.items[0]?.id;
      break;
    }

    if (!customerId) return notFound();

    try {
      await polar.customers.update({
        id: customerId,
        customerUpdate: { externalId: user.id },
      });
    } catch (linkErr) {
      console.warn(
        `${LOG_PREFIX} could not backfill external id on customer ${customerId}:`,
        linkErr instanceof Error ? linkErr.message : linkErr,
      );
    }

    const session = await polar.customerSessions.create({
      customerId,
      returnUrl: RETURN_URL,
    });
    return NextResponse.json({ url: session.customerPortalUrl });
  } catch (err) {
    return apiErrorResponse(err, "create_customer_session", 502, LOG_PREFIX);
  }
}
