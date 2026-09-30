// 注意（2026-09-30）: @polar-sh/sdk 0.x 時代の 1 回きりのスクリプト（実行済み）。SDK 1.0 へ上げたので、このままでは動かない。
// 再実行が要るときは scripts/list-polar-products.mjs に倣って createPolar（@polar-sh/sdk/2026-10）と snake_case に直すこと。
// One-shot: create the "first purchase → Entry first month ¥600 off" discount in Polar.
//
//   node scripts/setup-polar-entry-first-month-discount.mjs            # dry run
//   node scripts/setup-polar-entry-first-month-discount.mjs --apply    # create
//
// Host decision 2026-09-28: the first purchase is the biggest hurdle, but handing out free credits invites
// throwaway accounts. So only an account's first purchase gets a discount, only on the Entry subscription
// (¥1,980 → ¥1,380 for the first month; duration "once" = the renewal is full price). Top-up is excluded.
// Eligibility (no previous order) is checked by src/app/api/checkout/polar/route.ts, not by Polar.
// Prints the id to paste into ENTRY_FIRST_PURCHASE_DISCOUNT_ID in src/lib/polar.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Polar } from "@polar-sh/sdk";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const line of readFileSync(join(repoRoot, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
if (!env.POLAR_ACCESS_TOKEN) throw new Error("POLAR_ACCESS_TOKEN not found in .env.local");
const apply = process.argv.includes("--apply");
const polar = new Polar({ accessToken: env.POLAR_ACCESS_TOKEN, server: env.POLAR_SERVER || "production" });

const ENTRY_PRODUCT_ID = "7302330d-b548-48a5-9ccf-96f5a896397a"; // 月額エントリー ¥1,980 / 800C
const NAME = "Entry first month ¥600 off (first purchase, 2026-09)";
const AMOUNT_JPY = 600;

const existing = [];
for await (const page of await polar.discounts.list({ limit: 100 }))
  for (const it of page.result?.items ?? page.items ?? []) existing.push(it);

console.log(apply ? "=== APPLY ===" : "=== DRY RUN (add --apply to execute) ===");
const live = existing.find((d) => d.name === NAME);
if (live) {
  console.log(`[keep]   ${NAME} -> ${live.id}`);
} else {
  console.log(`[create] ${NAME} (fixed ¥${AMOUNT_JPY}, once, Entry only)`);
  if (apply) {
    const created = await polar.discounts.create({
      name: NAME,
      type: "fixed",
      amount: AMOUNT_JPY,
      currency: "jpy",
      duration: "once",
      products: [ENTRY_PRODUCT_ID],
      metadata: { ull_kind: "entry_first_purchase" },
    });
    console.log(`         -> ${created.id}`);
  }
}
