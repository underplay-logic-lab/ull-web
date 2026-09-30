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
import { createPolar } from "@polar-sh/sdk/2026-10";

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

// SDK 1.0（API 2026-10）: フィールドは snake_case、一覧は iterList で 1 件ずつ。
const polar = createPolar({ accessToken, environment: env.POLAR_SERVER || "production", timeout: 30 });

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
        `${pr.amount_type}${pr.price_amount != null ? ` ${pr.price_amount} ${pr.price_currency || ""}` : ""}` +
        `${pr.recurring_interval ? `/${pr.recurring_interval}` : ""}`,
    )
    .join(", ") || "(no prices)";

const all = [];
for await (const item of polar.products.iterList({ limit: 100 })) all.push(item);

console.log(`\n=== ${all.length} Polar products ===\n`);
for (const p of all) {
  console.log(
    [
      p.is_archived ? "[ARCHIVED]" : "[active]  ",
      p.is_recurring ? "recurring" : "one-time ",
      p.id,
      JSON.stringify(p.name),
      "| " + priceInfo(p),
    ].join("  "),
  );
}

console.log("\n=== auto-matched (active, newest wins) ===\n");
const active = all
  .filter((p) => !p.is_archived)
  .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

for (const m of MATCHERS) {
  const hit = active.find((p) => p.is_recurring === m.recurring && m.re.test(p.name));
  console.log(`${m.tier.padEnd(9)} -> ${hit ? hit.id : "NOT FOUND"}`);
}
