import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { WARM_EXTEND_COST, WARM_EXTEND_SECONDS } from "@/lib/gpuWarm";

// Same bearer-token auth pattern as /api/studio/custom-workflows/generate —
// verifies the token against Supabase auth rather than trusting a client-
// supplied user id.
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

  const { data: profile, error: profileError } = await getOrCreateProfile(
    user.id,
    "credits, credits_expire_at",
  );

  if (profileError) {
    console.error("[gpu/warm-extend] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }

  const creditsExpireAt = profile?.credits_expire_at as string | null | undefined;
  const rawCredits = profile?.credits as number | null | undefined;
  const isExpired = creditsExpireAt ? new Date(creditsExpireAt).getTime() < Date.now() : false;
  const currentCredits = isExpired ? 0 : (rawCredits ?? 0);

  if (isExpired && (rawCredits ?? 0) > 0) {
    const { error: expireError } = await supabaseAdmin
      .from("profiles")
      .update({ credits: 0 })
      .eq("id", user.id);
    if (expireError) {
      console.error("[gpu/warm-extend] failed to apply credit expiry reset:", expireError.message);
    }
  }

  if (currentCredits < WARM_EXTEND_COST) {
    return NextResponse.json(
      {
        error: isExpired
          ? "クレジットの有効期限が切れています。チャージしてから再度お試しください。"
          : "クレジットが不足しています。チャージしてから再度お試しください。",
        remainingCredits: currentCredits,
      },
      { status: 402 },
    );
  }

  const debitedCredits = currentCredits - WARM_EXTEND_COST;
  const { error: debitError } = await supabaseAdmin
    .from("profiles")
    .update({ credits: debitedCredits })
    .eq("id", user.id);

  if (debitError) {
    console.error("[gpu/warm-extend] failed to debit credits:", debitError.message);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  // Single atomic UPDATE...RETURNING inside the RPC (see
  // extend_gpu_warm() in supabase/migrations) — never a read-then-write
  // from here, so concurrent extends from different users can't race.
  const { data: newWarmUntil, error: extendError } = await supabaseAdmin.rpc("extend_gpu_warm", {
    p_user_id: user.id,
    p_seconds: WARM_EXTEND_SECONDS,
  });

  if (extendError) {
    console.error("[gpu/warm-extend] failed to extend warm status:", extendError.message);
    const { error: refundError } = await supabaseAdmin
      .from("profiles")
      .update({ credits: currentCredits })
      .eq("id", user.id);
    if (refundError) {
      console.error("[gpu/warm-extend] failed to refund credits after error:", refundError.message);
    }
    return NextResponse.json(
      { error: "GPUウォーム状態の更新に失敗しました。", remainingCredits: currentCredits },
      { status: 500 },
    );
  }

  return NextResponse.json({ warmUntil: newWarmUntil, remainingCredits: debitedCredits });
}
