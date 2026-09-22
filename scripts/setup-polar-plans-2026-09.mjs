// One-shot: create the 2026-09 plan ladder in Polar and archive the old one.
//
//   node scripts/setup-polar-plans-2026-09.mjs            # dry run (prints plan)
//   node scripts/setup-polar-plans-2026-09.mjs --apply    # create / archive
//
// Ladder (docs/pricing-decision-sheet.md, host decision 2026-09-23):
//   Entry ¥1,980/800C · Standard ¥4,980/2,200C · Pro ¥9,980/5,000C ·
//   Master ¥19,800/11,000C · Studio ¥29,800/18,000C · Top-up ¥1,000/300C
// Top-up member discounts (percentage, once, restricted to the new top-up):
//   entry 10 / standard 20 / pro 30 / master 40 / studio 50 (%).
// Old products (¥980/¥2,480/¥4,980/¥9,980/¥500 top-up) and their discounts
// are archived, never deleted, so historical orders keep resolving.
// Prints the id table to paste into src/lib/polarProducts.ts / polar.ts.
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

const NEW_PRODUCTS = [
  { key: "topup", name: "都度チャージ 300クレジット (Top-up 300)", amount: 1000, recurring: false, credits: 300 },
  { key: "entry", name: "月額エントリー (Entry)", amount: 1980, recurring: true, credits: 800 },
  { key: "standard", name: "月額スタンダード (Standard)", amount: 4980, recurring: true, credits: 2200 },
  { key: "pro", name: "月額プロ (Pro)", amount: 9980, recurring: true, credits: 5000 },
  { key: "master", name: "月額マスター (Master)", amount: 19800, recurring: true, credits: 11000 },
  { key: "studio", name: "月額スタジオ (Studio)", amount: 29800, recurring: true, credits: 18000 },
];
const DISCOUNTS = [
  { tier: "entry", pct: 10 },
  { tier: "standard", pct: 20 },
  { tier: "pro", pct: 30 },
  { tier: "master", pct: 40 },
  { tier: "studio", pct: 50 },
];
const OLD_PRODUCT_IDS = [
  "744fe424-c9fa-4b3c-a92d-d717e0421726", // 都度 ¥500/120C
  "6ec8c16f-d928-4f1c-8f36-d088bcbcaf59", // entry ¥980
  "6f170e8e-0afb-4d22-85f8-edaea807be9f", // standard ¥2,480
  "9f3add73-bdea-4183-8334-973d2ca66f9a", // pro ¥4,980
  "01d5a197-b0cc-4c13-9fa9-18a7bab4579c", // master ¥9,980
];

async function listAll(iterable) {
  const out = [];
  for await (const page of await iterable) for (const it of page.result?.items ?? page.items ?? []) out.push(it);
  return out;
}

const existing = await listAll(polar.products.list({ limit: 100 }));
const existingDiscounts = await listAll(polar.discounts.list({ limit: 100 }));

function findLive(spec) {
  return existing.find(
    (p) =>
      !p.isArchived &&
      p.name === spec.name &&
      (p.recurringInterval === "month") === spec.recurring &&
      (p.prices ?? []).some((pr) => pr.amountType === "fixed" && pr.priceAmount === spec.amount),
  );
}

console.log(apply ? "=== APPLY ===" : "=== DRY RUN (add --apply to execute) ===");
const ids = {};
for (const spec of NEW_PRODUCTS) {
  const live = findLive(spec);
  if (live) {
    ids[spec.key] = live.id;
    console.log(`[keep]   ${spec.key.padEnd(8)} ${spec.name} ¥${spec.amount} -> ${live.id}`);
    continue;
  }
  console.log(`[create] ${spec.key.padEnd(8)} ${spec.name} ¥${spec.amount}${spec.recurring ? "/月" : ""}`);
  if (!apply) continue;
  const created = await polar.products.create({
    name: spec.name,
    recurringInterval: spec.recurring ? "month" : null,
    prices: [{ amountType: "fixed", priceCurrency: "jpy", priceAmount: spec.amount }],
    metadata: { ull_tier: spec.key, ull_credits: String(spec.credits) },
  });
  ids[spec.key] = created.id;
  console.log(`         -> ${created.id}`);
}

const discountIds = {};
if (ids.topup) {
  for (const d of DISCOUNTS) {
    const name = `Top-up ${d.tier} ${d.pct}% (2026-09)`;
    const live = existingDiscounts.find(
      (x) => x.name === name && (x.products ?? []).some((p) => p.id === ids.topup),
    );
    if (live) {
      discountIds[d.tier] = live.id;
      console.log(`[keep]   discount ${name} -> ${live.id}`);
      continue;
    }
    console.log(`[create] discount ${name}`);
    if (!apply) continue;
    const created = await polar.discounts.create({
      name,
      type: "percentage",
      basisPoints: d.pct * 100,
      duration: "once",
      products: [ids.topup],
      metadata: { ull_tier: d.tier },
    });
    discountIds[d.tier] = created.id;
    console.log(`         -> ${created.id}`);
  }
}

for (const id of OLD_PRODUCT_IDS) {
  const p = existing.find((x) => x.id === id);
  if (!p) { console.log(`[skip]   old ${id} not found`); continue; }
  if (p.isArchived) { console.log(`[ok]     old ${p.name} already archived`); continue; }
  console.log(`[archive] ${p.name} (${id})`);
  if (!apply) continue;
  await polar.products.update({ id, productUpdate: { isArchived: true } });
}

console.log("\n=== ids ===");
console.log(JSON.stringify({ products: ids, topupDiscounts: discountIds }, null, 2));
