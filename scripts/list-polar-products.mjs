// List the live Polar catalog and auto-match our five product ids.
//
//   node scripts/list-polar-products.mjs
//
// Reads POLAR_ACCESS_TOKEN (and optional POLAR_SERVER) from .env.local.
// Prints every product (id / name / recurring / price / archived) and the
// auto-resolved id for each tier, so src/lib/polarProducts.ts can be kept
// in sync without hand-copying UUIDs from the Polar dashboard.

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

// name pattern -> our tier key + whether it must be a recurring product
const MATCHERS = [
  { tier: "topup", recurring: false, re: /top.?up|都度|チャージ|120/i },
  { tier: "entry", recurring: true, re: /entry|エントリー/i },
  { tier: "standard", recurring: true, re: /standard|スタンダード/i },
  { tier: "pro", recurring: true, re: /\bpro\b|プロ/i },
  { tier: "master", recurring: true, re: /master|マスター/i },
];

const priceInfo = (p) =>
  (p.prices || [])
    .map(
      (pr) =>
        `${pr.amountType}${pr.priceAmount != null ? ` ${pr.priceAmount} ${pr.priceCurrency || ""}` : ""}` +
        `${pr.recurringInterval ? `/${pr.recurringInterval}` : ""}`,
    )
    .join(", ") || "(no prices)";

const all = [];
for await (const page of await polar.products.list({ limit: 100 })) {
  all.push(...page.result.items);
}

console.log(`\n=== ${all.length} Polar products ===\n`);
for (const p of all) {
  console.log(
    [
      p.isArchived ? "[ARCHIVED]" : "[active]  ",
      p.isRecurring ? "recurring" : "one-time ",
      p.id,
      JSON.stringify(p.name),
      "| " + priceInfo(p),
    ].join("  "),
  );
}

console.log("\n=== auto-matched (active, newest wins) ===\n");
const active = all
  .filter((p) => !p.isArchived)
  .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

for (const m of MATCHERS) {
  const hit = active.find((p) => p.isRecurring === m.recurring && m.re.test(p.name));
  console.log(`${m.tier.padEnd(9)} -> ${hit ? hit.id : "NOT FOUND"}`);
}
