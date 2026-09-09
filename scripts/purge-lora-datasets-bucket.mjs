/**
 * One-shot: empty the Supabase Storage `lora_datasets` bucket.
 *
 * Deletes every OBJECT inside the bucket (recursively, all folders) but never
 * the bucket itself. Used to reclaim the Supabase Free-tier 1GB quota after
 * Smart Ingest bakes its optimised copies onto the Modal Volume — the uploaded
 * originals are dead weight (CLAUDE.md §3). Going forward
 * `modal_lora_worker.py` purges each job's sources automatically; this script
 * is the one-time cleanup for the backlog that accumulated before that.
 *
 *   node scripts/purge-lora-datasets-bucket.mjs           # really delete
 *   node scripts/purge-lora-datasets-bucket.mjs --dry-run # list only
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the shell
 * env, falling back to .env.local.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "lora_datasets";
const DRY_RUN = process.argv.includes("--dry-run");
const PAGE = 1000;
const DELETE_BATCH = 500;

function loadEnv() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (env[key] === undefined) env[key] = val;
    }
  } catch {
    /* no .env.local — rely on process.env */
  }
  return env;
}

const env = loadEnv();
const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    "✗ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not found (env or .env.local)",
  );
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Recursively collect every object key under `prefix`. */
async function listAll(prefix = "") {
  const keys = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, {
      limit: PAGE,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`list("${prefix}") failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A folder placeholder has no `id`; a real object does.
      if (entry.id === null || entry.id === undefined) {
        const nested = await listAll(path);
        keys.push(...nested);
      } else {
        keys.push(path);
      }
    }

    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return keys;
}

async function main() {
  console.log(`▶ Scanning bucket "${BUCKET}" …`);
  const keys = await listAll();
  console.log(`  found ${keys.length} object(s)`);

  if (keys.length === 0) {
    console.log("✓ Bucket is already empty — nothing to do.");
    return;
  }

  if (DRY_RUN) {
    for (const k of keys.slice(0, 50)) console.log(`   ${k}`);
    if (keys.length > 50) console.log(`   … and ${keys.length - 50} more`);
    console.log(`\n(dry-run) would delete ${keys.length} object(s).`);
    return;
  }

  let removed = 0;
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    const chunk = keys.slice(i, i + DELETE_BATCH);
    const { data, error } = await supabase.storage.from(BUCKET).remove(chunk);
    if (error) throw new Error(`remove() failed: ${error.message}`);
    removed += Array.isArray(data) ? data.length : chunk.length;
    console.log(`  deleted ${removed}/${keys.length} …`);
  }

  // Verify.
  const leftover = await listAll();
  if (leftover.length === 0) {
    console.log(
      `\n✓ Done. Deleted ${removed} object(s). Bucket "${BUCKET}" is now empty (the bucket itself is intact).`,
    );
  } else {
    console.warn(
      `\n⚠ Deleted ${removed} object(s) but ${leftover.length} still remain — re-run the script.`,
    );
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
