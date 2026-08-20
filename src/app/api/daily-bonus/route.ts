import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { DAILY_BONUS_BY_TIER, type SubscriptionTier } from "@/lib/stripe";

// Called once per login (see Header.tsx) to grant a paid member's daily
// login bonus. Idempotent per calendar day via last_login_bonus_at, so
// repeat calls in the same UTC day are silent no-ops.
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

  const userId = userData.user.id;

  const { data: profile, error: profileError } = await getOrCreateProfile(
    userId,
    "credits, subscription_tier, last_login_bonus_at",
  );

  if (profileError) {
    console.error("[daily-bonus] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }

  const tier = (profile?.subscription_tier as SubscriptionTier | null) ?? "free";
  const bonus = DAILY_BONUS_BY_TIER[tier] ?? 0;

  if (bonus <= 0) {
    return NextResponse.json({ granted: false });
  }

  const lastLoginBonusAt = profile?.last_login_bonus_at as string | null | undefined;
  const rawCredits = profile?.credits as number | null | undefined;

  const today = new Date().toISOString().slice(0, 10);
  const lastBonusDay = lastLoginBonusAt
    ? new Date(lastLoginBonusAt).toISOString().slice(0, 10)
    : null;

  if (lastBonusDay === today) {
    return NextResponse.json({ granted: false });
  }

  const newCredits = (rawCredits ?? 0) + bonus;

  const { error: updateError } = await supabaseAdmin
    .from("profiles")
    .update({ credits: newCredits, last_login_bonus_at: new Date().toISOString() })
    .eq("id", userId);

  if (updateError) {
    console.error("[daily-bonus] failed to grant bonus:", updateError.message);
    return NextResponse.json({ error: "ボーナス付与に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ granted: true, bonus, credits: newCredits });
}
