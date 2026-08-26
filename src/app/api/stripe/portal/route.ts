import { NextResponse } from "next/server";

// Retired along with the rest of the Stripe checkout/webhook path — see
// src/app/api/stripe/checkout/route.ts. Existing subscribers who still
// need to manage/cancel a Stripe subscription are directed to support
// instead (see CancellationWarningModal.tsx), since there is no Polar
// equivalent for subscription plans yet.
export async function POST() {
  return NextResponse.json(
    {
      error: "契約管理画面は現在ご利用いただけません。サブスクリプションの解約・変更はサポート窓口までお問い合わせください。",
    },
    { status: 410 },
  );
}
