import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createBillingPortalSession } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", userData.user.id)
    .single();

  if (profileError) {
    console.error("[stripe/portal] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }

  if (!profile?.stripe_customer_id) {
    return NextResponse.json(
      { error: "決済情報が見つかりません。まずはプランをご購入ください。" },
      { status: 400 },
    );
  }

  const origin = request.headers.get("origin") ?? new URL(request.url).origin;

  try {
    const session = await createBillingPortalSession(
      profile.stripe_customer_id,
      `${origin}/?portal=return#pricing`,
    );

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe/portal] failed to create portal session:", err);
    return NextResponse.json(
      { error: "カスタマーポータルの起動に失敗しました。" },
      { status: 500 },
    );
  }
}
