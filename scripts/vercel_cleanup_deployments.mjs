#!/usr/bin/env node
/**
 * Vercel Function Storage cleanup — bulk-deletes old deployments while
 * guaranteeing the deployment currently serving production traffic is never
 * touched.
 *
 * Safety design (per host request, 2026-09-15):
 *   1. The "protected" deployment is identified TWO independent ways, and
 *      BOTH results are protected (union, not just one):
 *        a) GET /v13/deployments/{productionDomain} — asks Vercel directly
 *           "what deployment is this domain pointing at right now". This is
 *           the authoritative live answer and survives a manual rollback to
 *           an older deployment (which a naive "most recent" check would
 *           delete by mistake).
 *        b) The most recent deployment with target=production AND
 *           readySubstate=PROMOTED (Vercel's own "has served production
 *           traffic" flag) from the deployments list.
 *   2. DRY RUN BY DEFAULT. Nothing is deleted unless invoked with --yes.
 *      Run once without --yes, review the printed plan, then re-run with
 *      --yes to actually delete.
 *   3. Deletes are rate-limited (one every DELETE_INTERVAL_MS) with
 *      exponential backoff + retry on 429.
 *
 * Required env (.env.local): VERCEL_TOKEN, VERCEL_PROJECT_ID
 * Optional env: VERCEL_TEAM_ID (omit for a personal-account project),
 *   VERCEL_PRODUCTION_DOMAIN (auto-detected from the project's domains if
 *   omitted).
 *
 * Usage:
 *   node scripts/vercel_cleanup_deployments.mjs            # dry run
 *   node scripts/vercel_cleanup_deployments.mjs --yes       # actually delete
 */
import fs from "node:fs";
import path from "node:path";

// --- tiny .env.local loader (no extra dependency) --------------------------
function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvLocal();

const TOKEN = process.env.VERCEL_TOKEN;
const PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const TEAM_ID = process.env.VERCEL_TEAM_ID || undefined;
const EXPLICIT_DOMAIN = process.env.VERCEL_PRODUCTION_DOMAIN || undefined;
const DRY_RUN = !process.argv.includes("--yes");
const DELETE_INTERVAL_MS = 600; // rate-limit courtesy delay between deletes
const API = "https://api.vercel.com";

if (!TOKEN || !PROJECT_ID) {
  console.error("[ERROR] VERCEL_TOKEN / VERCEL_PROJECT_ID が .env.local に見つかりません。");
  process.exit(1);
}

function withTeam(params) {
  const p = new URLSearchParams(params);
  if (TEAM_ID) p.set("teamId", TEAM_ID);
  return p;
}

async function vercelFetch(pathname, { method = "GET", params = {} } = {}) {
  const qs = withTeam(params).toString();
  const url = `${API}${pathname}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") || "2") * 1000;
    console.warn(`[rate-limit] ${method} ${pathname} -> 429, retrying in ${retryAfter}ms`);
    await sleep(retryAfter);
    return vercelFetch(pathname, { method, params });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. Resolve the production domain (unless given explicitly) ------------
async function resolveProductionDomain() {
  if (EXPLICIT_DOMAIN) return EXPLICIT_DOMAIN;
  const data = await vercelFetch(`/v9/projects/${PROJECT_ID}/domains`);
  const domains = Array.isArray(data.domains) ? data.domains : [];
  console.log(
    `[debug] project domains (${domains.length}):`,
    domains.map((d) => ({ name: d.name, verified: d.verified, redirect: d.redirect })),
  );
  if (!domains.length) return null;
  // Prefer a verified, non-redirecting apex/www-style domain over Vercel's
  // own *.vercel.app subdomain when both are present.
  const preferred =
    domains.find((d) => d.verified && !d.redirect && !String(d.name).endsWith(".vercel.app")) ??
    domains.find((d) => !d.redirect) ??
    domains[0];
  console.log(`[debug] chosen production domain: ${preferred?.name}`);
  return preferred?.name ?? null;
}

// --- 2. List EVERY deployment for the project (paginated) ------------------
async function listAllDeployments() {
  const all = [];
  let until;
  for (;;) {
    const params = { projectId: PROJECT_ID, limit: "100" };
    if (until) params.until = String(until);
    const data = await vercelFetch("/v7/deployments", { params });
    const batch = Array.isArray(data.deployments) ? data.deployments : [];
    all.push(...batch);
    const next = data.pagination?.next;
    if (!next || batch.length === 0) break;
    until = next;
    await sleep(150);
  }
  return all;
}

// --- 3. Identify the protected (currently-live) deployment id(s) -----------
async function resolveProtectedIds(deployments) {
  const protectedIds = new Set();
  const notes = [];

  const domain = await resolveProductionDomain();
  if (domain) {
    try {
      const live = await vercelFetch(`/v13/deployments/${encodeURIComponent(domain)}`);
      const liveId = live?.uid || live?.id;
      if (liveId) {
        protectedIds.add(liveId);
        notes.push(`ドメイン照会 (${domain}) -> ${liveId}`);
      } else {
        notes.push(`ドメイン照会 (${domain}) は成功したが id/uid が無い応答:\n${JSON.stringify(live, null, 2)}`);
      }
    } catch (err) {
      notes.push(`ドメイン照会 (${domain}) 失敗: ${err.message}`);
    }
  } else {
    notes.push("プロジェクトに紐づくカスタムドメインが見つかりませんでした。");
  }

  const promoted = deployments
    .filter((d) => d.target === "production" && d.readySubstate === "PROMOTED")
    .sort((a, b) => Number(b.created) - Number(a.created))[0];
  if (promoted) {
    protectedIds.add(promoted.uid);
    notes.push(`最新のPROMOTED本番デプロイ -> ${promoted.uid} (${new Date(Number(promoted.created)).toISOString()})`);
  }

  // Last-resort fallback so we NEVER end up with zero protected deployments:
  // the single most recent READY production deployment, even if neither of
  // the above signals was available.
  if (protectedIds.size === 0) {
    const latestReady = deployments
      .filter((d) => d.target === "production" && d.state === "READY")
      .sort((a, b) => Number(b.created) - Number(a.created))[0];
    if (latestReady) {
      protectedIds.add(latestReady.uid);
      notes.push(`[フォールバック] 最新のREADY本番デプロイ -> ${latestReady.uid}`);
    }
  }

  return { protectedIds, notes };
}

// --- main --------------------------------------------------------------
async function main() {
  console.log(`[info] mode: ${DRY_RUN ? "DRY RUN（削除はしません）" : "本番実行（実際に削除します）"}`);

  const deployments = await listAllDeployments();
  console.log(`[info] 取得したデプロイ総数: ${deployments.length}`);

  const { protectedIds, notes } = await resolveProtectedIds(deployments);
  console.log("[info] 保護対象の特定方法:");
  notes.forEach((n) => console.log(`  - ${n}`));
  if (protectedIds.size === 0) {
    console.error("[ERROR] 保護対象のデプロイを1件も特定できませんでした。安全のため中止します。");
    process.exit(1);
  }
  console.log(`[info] 保護されるデプロイID: ${[...protectedIds].join(", ")}`);

  const candidates = deployments.filter((d) => !protectedIds.has(d.uid));
  const alreadyDeleted = candidates.filter((d) => d.state === "DELETED");
  const toDelete = candidates.filter((d) => d.state !== "DELETED");

  console.log(`[info] 削除候補: ${toDelete.length} 件（既にDELETED状態のもの ${alreadyDeleted.length} 件は除く）`);
  const byTarget = toDelete.reduce((acc, d) => {
    const k = d.target || "(preview)";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  console.log("[info] 内訳:", byTarget);

  console.log("\n[info] 削除候補の一覧（新しい順、先頭20件）:");
  [...toDelete]
    .sort((a, b) => Number(b.created) - Number(a.created))
    .slice(0, 20)
    .forEach((d) => {
      console.log(
        `  - ${d.uid}  ${d.state.padEnd(8)} ${(d.target || "preview").padEnd(10)} ${new Date(Number(d.created)).toISOString()}  ${d.url}`,
      );
    });
  if (toDelete.length > 20) console.log(`  ... 他 ${toDelete.length - 20} 件`);

  if (DRY_RUN) {
    console.log(
      "\n[dry-run] 何も削除していません。この一覧で問題なければ `--yes` を付けて再実行してください。",
    );
    return;
  }

  console.log(`\n[delete] ${toDelete.length} 件を ${DELETE_INTERVAL_MS}ms 間隔で削除します...`);
  let ok = 0;
  let failed = 0;
  for (const d of toDelete) {
    try {
      await vercelFetch(`/v13/deployments/${d.uid}`, { method: "DELETE" });
      ok++;
      console.log(`  [OK] ${d.uid} (${d.url})`);
    } catch (err) {
      failed++;
      console.error(`  [FAIL] ${d.uid}: ${err.message}`);
    }
    await sleep(DELETE_INTERVAL_MS);
  }
  console.log(`\n[done] 成功 ${ok} 件 / 失敗 ${failed} 件 / 保護されたまま残した ${protectedIds.size} 件`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
