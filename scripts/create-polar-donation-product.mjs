// Create (once) the "支援（寄付）" product on Polar: one-time, pay-what-you-want
// (custom amount, JPY). Prints the product id to paste into
// src/lib/polarProducts.ts (POLAR_DONATION_PRODUCT_ID).
//
//   node scripts/create-polar-donation-product.mjs
//
// Idempotent-ish: refuses to create a second one if an active product with
// the same name already exists (prints its id instead). Reads
// POLAR_ACCESS_TOKEN / POLAR_SERVER from .env.local like list-polar-products.mjs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Polar } from "@polar-sh/sdk";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const line of readFileSync(join(repoRoot, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
const accessToken = env.POLAR_ACCESS_TOKEN;
if (!accessToken) {
  console.error("POLAR_ACCESS_TOKEN not found in .env.local");
  process.exit(1);
}
const polar = new Polar({ accessToken, server: env.POLAR_SERVER || "production" });

const NAME = "ULL Studio への支援（寄付）";

for await (const page of await polar.products.list({ isArchived: false, limit: 100 })) {
  for (const p of page.result.items) {
    if (p.name === NAME) {
      console.log("already exists:", p.id);
      process.exit(0);
    }
  }
}

const product = await polar.products.create({
  name: NAME,
  description:
    "サーバー・GPU の維持費と新機能の開発に使わせていただきます。金額は自由です（クレジットの付与はありません）。",
  recurringInterval: null,
  prices: [
    {
      amountType: "custom",
      priceCurrency: "jpy",
      minimumAmount: 100,
      presetAmount: 1000,
    },
  ],
});

console.log("created:", product.id);
console.log(JSON.stringify(product.prices, null, 1));
