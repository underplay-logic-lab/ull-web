#!/usr/bin/env node
// トークン消費の運用規律（CLAUDE.md「セッション運用ルール」）が
// 静かに崩れていないかを検出する週次チェック。副作用なし・読み取り専用。
//
// 使い方: node scripts/check-token-hygiene.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();

const CLAUDE_MD_LIMIT_BYTES = 30 * 1024; // CLAUDE.md 上限 30KB
const HUGE_FILE_LINES = 3000;
const HUGE_FILE_BYTES = 150 * 1024;
const TRANSCRIPT_WARN_BYTES = 20 * 1024 * 1024;
const TRANSCRIPT_CRITICAL_BYTES = 40 * 1024 * 1024;

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "_artifacts",
  "__pycache__",
  ".vercel",
]);

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);
const GENERATED_EXTS = new Set([".mp4", ".mov", ".png", ".jpg", ".jpeg", ".wav", ".mp3"]);

const warnings = [];
const oks = [];

function fmtMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + "MB";
}
function fmtKB(bytes) {
  return (bytes / 1024).toFixed(1) + "KB";
}

// --- 1. CLAUDE.md サイズ ---
function checkClaudeMd() {
  const p = path.join(ROOT, "CLAUDE.md");
  if (!fs.existsSync(p)) return;
  const size = fs.statSync(p).size;
  if (size > CLAUDE_MD_LIMIT_BYTES) {
    warnings.push(
      `CLAUDE.md が ${fmtKB(size)}（上限 ${fmtKB(CLAUDE_MD_LIMIT_BYTES)}）を超過。実測・記録は docs/ へ退避してください。`
    );
  } else {
    oks.push(`CLAUDE.md: ${fmtKB(size)}（上限内）`);
  }
}

// --- 2. 巨大ソースファイル ---
function walk(dir, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, onFile);
    } else if (entry.isFile()) {
      onFile(full);
    }
  }
}

function checkHugeSourceFiles() {
  const offenders = [];
  walk(ROOT, (file) => {
    const ext = path.extname(file);
    if (!SOURCE_EXTS.has(ext)) return;
    const stat = fs.statSync(file);
    if (stat.size < HUGE_FILE_BYTES) return; // 先にサイズで足切り(行数カウントのコスト削減)
    const lines = fs.readFileSync(file, "utf8").split("\n").length;
    if (lines > HUGE_FILE_LINES) {
      offenders.push({ file: path.relative(ROOT, file), lines, size: stat.size });
    }
  });
  if (offenders.length) {
    offenders.sort((a, b) => b.lines - a.lines);
    for (const o of offenders) {
      warnings.push(
        `巨大ソースファイル: ${o.file}（${o.lines}行 / ${fmtKB(o.size)}）— 全文Readを避け、Grepで当たりをつけてから範囲指定で読むこと。`
      );
    }
  } else {
    oks.push(`巨大ソースファイル（${HUGE_FILE_LINES}行超）: 検出なし`);
  }
}

// --- 3. ルート直下に散らばった生成物 ---
function checkScatteredArtifacts() {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isFile()) {
      const ext = path.extname(name).toLowerCase();
      if (GENERATED_EXTS.has(ext)) found.push(name);
    } else if (entry.isDirectory()) {
      if (/^(angle_out|upscale_out|angle_bench|upscale_bench|trellis_out)/.test(name)) {
        found.push(name + "/");
      }
    }
  }
  if (found.length) {
    warnings.push(
      `ルート直下に生成物が散らばっています: ${found.join(", ")} — _artifacts/ へ移動してください（.gitignore 済み）。`
    );
  } else {
    oks.push("ルート直下の生成物散乱: 検出なし");
  }
}

// --- 4. 巨大な Claude Code セッショントランスクリプト ---
function checkTranscripts() {
  const slug = ROOT.replace(/[:\\/]/g, "-");
  const projectsDir = path.join(os.homedir(), ".claude", "projects", slug);
  if (!fs.existsSync(projectsDir)) return;
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const offenders = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const full = path.join(projectsDir, entry.name);
    const size = fs.statSync(full).size;
    if (size >= TRANSCRIPT_WARN_BYTES) {
      offenders.push({ name: entry.name, size });
    }
  }
  if (offenders.length) {
    offenders.sort((a, b) => b.size - a.size);
    for (const o of offenders) {
      const level = o.size >= TRANSCRIPT_CRITICAL_BYTES ? "重度" : "注意";
      warnings.push(
        `[${level}] セッション肥大化: ${o.name}（${fmtMB(o.size)}）— 早めに /clear すること。1セッション=1タスクを徹底。`
      );
    }
  } else {
    oks.push(`巨大セッション（${fmtMB(TRANSCRIPT_WARN_BYTES)}超）: 検出なし`);
  }
}

checkClaudeMd();
checkHugeSourceFiles();
checkScatteredArtifacts();
checkTranscripts();

console.log("=== トークン消費 週次チェック ===\n");
if (oks.length) {
  console.log("OK:");
  for (const o of oks) console.log(`  - ${o}`);
  console.log("");
}
if (warnings.length) {
  console.log("WARN:");
  for (const w of warnings) console.log(`  - ${w}`);
  console.log("");
  process.exitCode = 1;
} else {
  console.log("問題なし。");
}
