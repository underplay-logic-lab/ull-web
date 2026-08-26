import { NextResponse } from "next/server";

// Retired: payment processing has moved to Polar.sh (Merchant of Record) —
// see src/app/api/checkout/polar/route.ts. Kept as a stub (rather than
// deleted) so a stale client/bookmark hits a clear, intentional response
// instead of a bare 404. src/lib/stripe.ts itself is untouched, since its
// tier/pricing constants (DAILY_BONUS_BY_TIER, FREE_STREAK_DAY_BONUS,
// SUBSCRIPTION_TIER_RANK) are still read by /api/daily-bonus for existing
// subscribers' tier-based bonuses — only the checkout-session-creation
// path this route used to expose is disabled.
export async function POST() {
  return NextResponse.json(
    {
      error:
        "この決済窓口は終了しました。クレジット購入は新しい決済プラットフォーム（Polar.sh）をご利用ください。",
    },
    { status: 410 },
  );
}
