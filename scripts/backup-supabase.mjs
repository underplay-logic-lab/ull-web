// Supabase の中身を手元へ毎日バックアップする（2026-10-01、ホスト判断: Free プランは自動バックアップが無い。
// Pro にする代わりに、手元に保存して Google ドライブの同期でクラウドにも置く）。
//
//   node scripts/backup-supabase.mjs [保存先フォルダ]
//
// 保存先は引数 → 環境変数 ULL_BACKUP_DIR → .env.local の ULL_BACKUP_DIR → D:\ULL-backups の順。
// 中身: public スキーマの全テーブル（PostgREST 経由、主キー順にページング）と、ログインのアカウント一覧（auth.users）。
// テーブル構造・関数・トリガーは supabase/migrations にあるので、戻すときは「マイグレーション → このデータを投入」。
// 認証は .env.local の service_role キー（新しいパスワードは不要）。KEEP_DAYS より古いバックアップは消す。
// 毎日の実行は scripts/register-backup-task.ps1 でタスクスケジューラに登録する。

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KEEP_DAYS = 30;
const PAGE = 1000;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const line of readFileSync(join(repoRoot, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.local にありません。");
  process.exit(1);
}
const root = process.argv[2] || process.env.ULL_BACKUP_DIR || env.ULL_BACKUP_DIR || "D:\\ULL-backups";
const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-"); // JST
const dir = join(root, `supabase-${stamp}`);
mkdirSync(dir, { recursive: true });

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// テーブル一覧と主キー（PostgREST の OpenAPI）。
const spec = await (await fetch(`${URL_}/rest/v1/`, { headers: { ...headers, Accept: "application/openapi+json" } })).json();
const defs = spec.definitions ?? {};
const tables = Object.keys(defs).sort();

const summary = [];
let failed = 0;
for (const t of tables) {
  const props = defs[t]?.properties ?? {};
  const pk = Object.keys(props).filter((c) => /Primary Key/.test(props[c]?.description ?? ""));
  const order = (pk.length ? pk : Object.keys(props).slice(0, 1)).map((c) => `${c}.asc`).join(",");
  const rows = [];
  try {
    // 1 行が大きいテーブル（generation_jobs の inputs 等）は 1,000 行だと時間切れ（57014）になるので、減らしてやり直す。
    let size = PAGE;
    for (let from = 0; ; ) {
      const res = await fetch(`${URL_}/rest/v1/${encodeURIComponent(t)}?select=*${order ? `&order=${order}` : ""}`, {
        headers: { ...headers, Range: `${from}-${from + size - 1}`, "Range-Unit": "items" },
      });
      if (!res.ok && res.status !== 206) {
        const text = await res.text();
        if (res.status === 500 && /57014|timeout/.test(text) && size > 10) {
          size = Math.max(10, Math.floor(size / 4));
          continue;
        }
        throw new Error(`${res.status} ${text.slice(0, 200)}`);
      }
      const page = await res.json();
      rows.push(...page);
      if (page.length < size) break;
      from += size;
    }
    writeFileSync(join(dir, `${t}.json.gz`), gzipSync(JSON.stringify(rows)));
    summary.push(`${t}: ${rows.length}`);
  } catch (e) {
    failed++;
    summary.push(`${t}: 失敗 (${e.message})`);
  }
}

// ログインのアカウント（auth.users）。パスワードそのものは Supabase 側でハッシュ化されており、この API でも出てこない。
try {
  const users = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${URL_}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers });
    if (!res.ok) throw new Error(`${res.status}`);
    const body = await res.json();
    const list = body.users ?? [];
    users.push(...list);
    if (list.length < 1000) break;
  }
  writeFileSync(join(dir, `auth_users.json.gz`), gzipSync(JSON.stringify(users)));
  summary.push(`auth.users: ${users.length}`);
} catch (e) {
  failed++;
  summary.push(`auth.users: 失敗 (${e.message})`);
}

writeFileSync(join(dir, "_summary.txt"), `${new Date().toISOString()}\n${summary.join("\n")}\n`);

// 古いバックアップを消す。
const cutoff = Date.now() - KEEP_DAYS * 86400e3;
for (const name of readdirSync(root)) {
  const p = join(root, name);
  if (name.startsWith("supabase-") && statSync(p).isDirectory() && statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
}

console.log(`保存先: ${dir}`);
console.log(`テーブル ${tables.length} 個・失敗 ${failed} 件`);
console.log(summary.filter((s) => /失敗/.test(s)).join("\n") || "すべて成功");
process.exit(failed ? 1 : 0);
