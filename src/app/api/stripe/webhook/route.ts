import { NextResponse } from "next/server";

// Retired along with the rest of the Stripe checkout/portal path — see
// src/app/api/stripe/checkout/route.ts. Returns 200 (not an error status)
// so Stripe's dashboard doesn't flag this endpoint as failing/retry it —
// it's intentionally a no-op now, not broken.
//
// Known consequence: any *existing* Stripe subscription that's still
// actually billing will no longer have its renewal/cancellation events
// processed here (subscription_tier, monthly credit grants, etc. will no
// longer stay in sync with Stripe). If there are live Stripe subscribers
// at the time this ships, they should be migrated or their subscriptions
// cancelled before disabling this — this stub does not do that itself.
export async function POST() {
  return NextResponse.json({ received: true, ignored: true });
}
