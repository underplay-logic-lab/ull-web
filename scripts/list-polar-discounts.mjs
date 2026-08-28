// List the live Polar discounts and auto-match our four top-up tier discounts.
//
//   node scripts/list-polar-discounts.mjs
//
// Reads POLAR_ACCESS_TOKEN (and optional POLAR_SERVER) from .env.local.
// Prints every discount (id / name / code / percent / products) and the
// auto-resolved id per tier, so the map in src/lib/polar.ts can be kept in
// sync without hand-copying UUIDs.

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

// tier -> expected percent-off, matched against the discount name
const MATCHERS = [
  { tier: "entry", pct: 10, re: /entry|エントリー/i },
  { tier: "standard", pct: 20, re: /standard|スタンダード/i },
  { tier: "pro", pct: 30, re: /\bpro\b|プロ/i },
  { tier: "master", pct: 50, re: /master|マスター/i },
];

const percentOf = (d) => (typeof d.basisPoints === "number" ? d.basisPoints / 100 : null);

const all = [];
for await (const page of await polar.discounts.list({ limit: 100 })) {
  all.push(...page.result.items);
}

console.log(`\n=== ${all.length} Polar discounts ===\n`);
for (const d of all) {
  const pct = percentOf(d);
  console.log(
    [
      d.id,
      JSON.stringify(d.name),
      d.code ? `code=${d.code}` : "no-code",
      pct != null ? `${pct}%` : d.type,
      `duration=${d.duration}`,
      `products=[${(d.products || []).map((p) => p.id).join(", ")}]`,
    ].join("  "),
  );
}

console.log("\n=== auto-matched (by name + percent) ===\n");
for (const m of MATCHERS) {
  const hit = all.find((d) => m.re.test(d.name) && percentOf(d) === m.pct);
  console.log(`${m.tier.padEnd(9)} (${m.pct}%) -> ${hit ? hit.id : "NOT FOUND"}`);
}
