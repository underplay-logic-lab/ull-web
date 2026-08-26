import "server-only";
import { Polar } from "@polar-sh/sdk";

const accessToken = process.env.POLAR_ACCESS_TOKEN;

if (!accessToken) {
  throw new Error("Missing POLAR_ACCESS_TOKEN environment variable.");
}

// "production" unless explicitly overridden — POLAR_SERVER is only meant
// for pointing this at Polar's sandbox during local/staging testing.
const server = (process.env.POLAR_SERVER as "production" | "sandbox" | undefined) ?? "production";

export const polar = new Polar({ accessToken, server });

// Every Polar product this app currently knows how to grant credits for,
// keyed by its Polar product id — checked by both the checkout route
// (only a known productId may be checked out) and the webhook (to resolve
// how many credits an order.paid event should grant). Only the one-time
// 120-credit top-up exists here so far; the four subscription plans
// (entry/standard/pro/master) don't have Polar products yet, so their
// purchase buttons are disabled in the UI until they're added here too.
export const POLAR_PRODUCT_CREDITS: Record<string, number> = Object.fromEntries(
  [
    process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_120 ? [process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID_120, 120] : null,
  ].filter((entry): entry is [string, number] => entry !== null),
);

export function creditsForPolarProduct(productId: string | null | undefined): number | null {
  if (!productId) return null;
  return POLAR_PRODUCT_CREDITS[productId] ?? null;
}
