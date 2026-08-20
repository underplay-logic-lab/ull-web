import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import {
  DAILY_BONUS_BY_TIER,
  FREE_STREAK_DAY_BONUS,
  STREAK_CYCLE_LENGTH,
  type SubscriptionTier,
} from "@/lib/stripe";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CREDIT_VALIDITY_DAYS = 180;

// Called once per login (see Header.tsx) to grant the "opening campaign"
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
    "credits, subscription_tier, last_login_bonus_at, cancel_at_period_end, streak_count, credits_expire_at",
  );

  if (profileError) {
    console.error("[daily-bonus] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }

  const tier = (profile?.subscription_tier as SubscriptionTier | null) ?? "free";
  const cancelAtPeriodEnd = Boolean(profile?.cancel_at_period_end);
  const lastLoginBonusAt = profile?.last_login_bonus_at as string | null | undefined;
  const rawStreak = (profile?.streak_count as number | null | undefined) ?? 0;
  const creditsExpireAt = profile?.credits_expire_at as string | null | undefined;

  // JIT (just-in-time) expiry: rather than a scheduled job, every login
  // checks whether the 180-day rolling window has lapsed and, if so,
  // zeroes the stale balance right here before anything else runs.
  let rawCredits = (profile?.credits as number | null | undefined) ?? 0;
  const isExpired = creditsExpireAt ? new Date(creditsExpireAt).getTime() < Date.now() : false;

  if (isExpired && rawCredits > 0) {
    const { error: expireError } = await supabaseAdmin
      .from("profiles")
      .update({ credits: 0 })
      .eq("id", userId);

    if (expireError) {
      console.error("[daily-bonus] failed to apply credit expiry reset:", expireError.message);
    } else {
      console.log(`[daily-bonus] credits expired for user ${userId} (expired ${creditsExpireAt}); reset to 0.`);
      rawCredits = 0;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const lastBonusDay = lastLoginBonusAt
    ? new Date(lastLoginBonusAt).toISOString().slice(0, 10)
    : null;

  if (lastBonusDay === today) {
    return NextResponse.json({ granted: false });
  }

  // Streak continues only if the last grant was exactly yesterday; any
  // bigger gap (or no prior grant at all) starts a fresh streak at day 1.
  const daysSinceLastBonus = lastBonusDay
    ? Math.round((new Date(today).getTime() - new Date(lastBonusDay).getTime()) / MS_PER_DAY)
    : null;
  const newStreak = daysSinceLastBonus === 1 ? rawStreak + 1 : 1;

  let bonus = 0;
  let dayInCycle: number | null = null;

  if (!cancelAtPeriodEnd) {
    if (tier === "free") {
      dayInCycle = ((newStreak - 1) % STREAK_CYCLE_LENGTH) + 1;
      bonus = FREE_STREAK_DAY_BONUS[dayInCycle] ?? 0;
    } else {
      bonus = DAILY_BONUS_BY_TIER[tier] ?? 0;
    }
  }

  // A reserved cancellation zeroes the bonus, but the login streak itself
  // still advances — so if the reservation is later undone, the streak
  // picks back up where it left off instead of being penalized twice.
  if (bonus <= 0) {
    const { error: streakOnlyError } = await supabaseAdmin
      .from("profiles")
      .update({ streak_count: newStreak, last_login_bonus_at: new Date().toISOString() })
      .eq("id", userId);

    if (streakOnlyError) {
      console.error("[daily-bonus] failed to record streak:", streakOnlyError.message);
    }

    return NextResponse.json({ granted: false, streak: newStreak, cancelAtPeriodEnd });
  }

  const newCredits = rawCredits + bonus;
  // Every actual bonus grant rolls the 180-day expiry window forward, same
  // as a top-up/subscription payment — this is what keeps an active user's
  // balance from ever lapsing.
  const newExpiry = new Date(Date.now() + CREDIT_VALIDITY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { error: updateError } = await supabaseAdmin
    .from("profiles")
    .update({
      credits: newCredits,
      last_login_bonus_at: new Date().toISOString(),
      streak_count: newStreak,
      credits_expire_at: newExpiry,
    })
    .eq("id", userId);

  if (updateError) {
    console.error("[daily-bonus] failed to grant bonus:", updateError.message);
    return NextResponse.json({ error: "ボーナス付与に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({
    granted: true,
    creditsExpireAt: newExpiry,
    bonus,
    credits: newCredits,
    streak: newStreak,
    dayInCycle,
    tier,
  });
}
