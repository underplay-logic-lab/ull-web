// 2 つ以上の録画の一部をつないで 1 つの録画にする（2026-10-08、Director の回: 設定の手順は 1 本目・生成から先は撮り直した 2 本目）。
//   node scripts/join-sessions.mjs <出力名> <録画名>:<開始秒>-<終了秒> [<録画名>:<開始秒>-<終了秒> ...]
//   例: node scripts/join-sessions.mjs hinata-director-final hinata-director2:0-578 hinata-director3:120-
// コマはコピーせずハードリンク（同じドライブなので容量はほぼ増えない）。座標は録画ごとの倍率（css 幅）で揃えてから 1.0 にする。
// edit.json は各区間のテロップを時刻をずらして集める（あとは手で直す）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recDir = path.join(root, "public", "rec");
const [outName, ...parts] = process.argv.slice(2);
if (!outName || parts.length === 0) {
  console.error("使い方: node scripts/join-sessions.mjs <出力名> <録画名>:<開始秒>-<終了秒> ...");
  process.exit(1);
}
const outDir = path.join(recDir, outName);
if (fs.existsSync(outDir)) {
  console.error(`${outDir} はすでにあります（上書きしない）。`);
  process.exit(1);
}
fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });

const out = { name: outName, view: null, dpr: null, coordScale: 1, duration: 0, frames: [], events: [] };
const captions = [];
let offset = 0; // ms（出力の時刻 = 元の時刻 - 区間の開始 + offset）
let n = 0;
for (const part of parts) {
  const m = part.match(/^(.+):([\d.]*)-([\d.]*)$/);
  if (!m) throw new Error(`区間の書き方が違います: ${part}`);
  const [, name, a, b] = m;
  const dir = path.join(recDir, name);
  const s = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
  const from = a ? Number(a) * 1000 : 0;
  const to = b ? Number(b) * 1000 : s.duration;
  out.view ??= s.view;
  out.dpr ??= s.dpr;
  if (s.view.width !== out.view.width || s.view.height !== out.view.height) throw new Error(`${name} の画面サイズが違います`);
  const k = s.coordScale ?? (s.css?.width ? s.view.width / s.css.width : 1);
  const shift = (t) => t - from + offset;
  for (const f of s.frames) {
    if (f.t < from || f.t >= to) continue;
    const fname = `${String(++n).padStart(6, "0")}.jpg`;
    fs.linkSync(path.join(dir, "frames", f.f), path.join(outDir, "frames", fname));
    out.frames.push({ f: fname, t: shift(f.t) });
  }
  for (const e of s.events) {
    if (e.t < from || e.t >= to) continue;
    const ev = { ...e, t: shift(e.t) };
    if ("x" in ev && "y" in ev) {
      ev.x *= k;
      ev.y *= k;
    }
    out.events.push(ev);
  }
  const editPath = path.join(dir, "edit.json");
  if (fs.existsSync(editPath)) {
    for (const c of JSON.parse(fs.readFileSync(editPath, "utf8")).captions ?? []) {
      if (c.at * 1000 >= from && c.at * 1000 < to) captions.push({ ...c, at: Math.round(shift(c.at * 1000)) / 1000 });
    }
  }
  console.log(`${name}: ${from / 1000}〜${to / 1000} 秒 → 出力 ${offset / 1000}〜${shift(to) / 1000} 秒（倍率 ${k.toFixed(3)}）`);
  offset = shift(to);
}
out.duration = offset;
fs.writeFileSync(path.join(outDir, "session.json"), JSON.stringify(out));
fs.writeFileSync(path.join(outDir, "edit.json"), JSON.stringify({ title: "", captions }, null, 1));
console.log(`保存: ${path.relative(root, outDir)}（${out.duration / 1000} 秒・コマ ${out.frames.length} 枚・テロップ ${captions.length}）`);
