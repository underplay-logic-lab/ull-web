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

  if (!user.email) return notFound();

  try {
    // Resolve the Polar customer by email — this is the canonical lookup
    // (Polar enforces one customer per email per organization), so the
    // portal session it mints is guaranteed to show every order and
    // subscription for this person. Doing this instead of an
    // external_customer_id session avoids the case where an early checkout
    // created the customer without an external id.
    let customer: { id: string; externalId?: string | null } | undefined;
    for await (const page of await polar.customers.list({ email: user.email, limit: 1 })) {
      customer = page.result.items[0];
      break;
    }

    if (!customer) return notFound();

    // Persist the Supabase user id onto the Polar customer so future lookups
    // (and webhook correlation) can use it directly. Best effort — a failure
    // here must not block the portal.
    if (!customer.externalId) {
      try {
        await polar.customers.update({
          id: customer.id,
          customerUpdate: { externalId: user.id },
        });
      } catch (linkErr) {
        console.warn(
          `${LOG_PREFIX} could not link external id onto customer ${customer.id}:`,
          linkErr instanceof Error ? linkErr.message : linkErr,
        );
      }
    }

    const session = await polar.customerSessions.create({
      customerId: customer.id,
      returnUrl: RETURN_URL,
    });

    return NextResponse.json({ url: session.customerPortalUrl });
  } catch (err) {
    return apiErrorResponse(err, "create_customer_session", 502, LOG_PREFIX);
  }
}
