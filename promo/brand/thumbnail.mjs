// 操作動画の YouTube サムネイル（1280×720）を HTML で描いて PNG に書き出す。ブランドと同じ黒 × 明朝（brand/render.mjs）。
//   node brand/thumbnail.mjs angle <元の顔> <結果の画像フォルダ>   → out/thumb/angle.png
// 文字は小さく表示されても読めるよう大きく・少なく。基盤モデル名や GPU 型番は入れない（CLAUDE.md §2）。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [kind, face, resultsDir] = process.argv.slice(2);
if (kind !== "angle" || !face || !resultsDir) {
  console.error("使い方: node brand/thumbnail.mjs angle <元の顔> <結果の画像フォルダ>");
  process.exit(1);
}
const out = path.join(root, "out", "thumb");
fs.mkdirSync(out, { recursive: true });

const dataUri = (p) => `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;
const results = fs
  .readdirSync(resultsDir)
  .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
  .sort()
  .slice(0, 8)
  .map((f) => dataUri(path.join(resultsDir, f)));

const fonts = `<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;600;700&family=Fraunces:opsz,wght@9..144,400;9..144,500&display=block" rel="stylesheet">`;
const html = `<!doctype html><html><head><meta charset="utf-8">${fonts}<style>
  * { margin: 0; box-sizing: border-box; }
  body { width: 1280px; height: 720px; background: #0b0b0c; color: #ecebe7; font-family: 'Noto Serif JP', serif; overflow: hidden; }
  .wrap { position: absolute; inset: 0; padding: 44px 52px; display: flex; flex-direction: column; }
  h1 { font-weight: 700; font-size: 76px; letter-spacing: 0.04em; line-height: 1.1; }
  h1 .num { font-family: 'Fraunces', serif; font-weight: 500; font-size: 96px; }
  .row { flex: 1; display: flex; align-items: center; gap: 26px; margin-top: 26px; min-height: 0; }
  .face { height: 100%; aspect-ratio: 3 / 4; object-fit: cover; border-radius: 8px; outline: 1px solid #ffffff22; }
  .arrow { font-size: 56px; color: #77756f; }
  .grid { flex: 1; height: 100%; display: grid; grid-template-columns: repeat(4, 1fr); grid-template-rows: repeat(2, 1fr); gap: 10px; }
  .grid img { width: 100%; height: 100%; object-fit: cover; object-position: center 20%; border-radius: 6px; }
  .brand { position: absolute; right: 52px; top: 50px; font-family: 'Fraunces', serif; font-size: 26px; letter-spacing: 0.16em; color: #77756f; }
</style></head><body><div class="wrap">
  <h1>顔 <span class="num">1</span> 枚 から、<span class="num">8</span> 方向</h1>
  <div class="row">
    <img class="face" src="${dataUri(face)}">
    <div class="arrow">→</div>
    <div class="grid">${results.map((u) => `<img src="${u}">`).join("")}</div>
  </div>
  <div class="brand">ULL Studio</div>
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.setContent(html, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
const file = path.join(out, `${kind}.png`);
await page.screenshot({ path: file });
await browser.close();
console.log(`保存: ${path.relative(root, file)}`);
