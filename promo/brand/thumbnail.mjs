// 操作動画の YouTube サムネイル（1280×720）を HTML で描いて PNG に書き出す。ブランドと同じ黒 × 明朝（brand/render.mjs）。
//   node brand/thumbnail.mjs <angle|dataset|lora|retrain> <元の顔> <結果の画像フォルダ>   → out/thumb/<種類>.png
//   node brand/thumbnail.mjs song <録画のコマ>（曲づくりは別の形・下）
// 文字は小さく表示されても読めるよう大きく・少なく。基盤モデル名や GPU 型番は入れない（CLAUDE.md §2）。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [kind, face, resultsDir] = process.argv.slice(2);
const out = process.env.THUMB_OUT ?? path.join(root, "out", "thumb"); // THUMB_OUT で書き出し先を変えられる（確認用）
fs.mkdirSync(out, { recursive: true });
// 曲づくり（2026-10-08）は顔が無いので形が別: 左に思いつきの文、右に録画のコマから「3 曲できた」所を切り抜く。
//   node brand/thumbnail.mjs song <録画のコマ(1600×900)>
if (kind === "song") {
  if (!face) {
    console.error("使い方: node brand/thumbnail.mjs song <録画のコマ>");
    process.exit(1);
  }
  await shoot(
    "song",
    `<h1>思いつき <span class="num">1</span> 行から、<br>歌入りの曲</h1>
    <div class="row">
      <div class="idea"><div class="label">どんな曲？</div>朝の光が差し込む部屋で、<br>新しい一日を楽しみに、<br>やさしく前向きに歌う曲。</div>
      <div class="arrow">→</div>
      <div class="crop"><img src="data:image/jpeg;base64,${fs.readFileSync(face).toString("base64")}"></div>
    </div>`,
    `.idea { flex: 1; font-size: 34px; line-height: 1.7; padding: 30px 34px; border: 1px solid #ffffff2a; border-radius: 10px; background: #141416; }
     .idea .label { font-size: 22px; color: #77756f; margin-bottom: 10px; }
     .crop { height: 100%; aspect-ratio: 713 / 685; overflow: hidden; position: relative; border-radius: 10px; outline: 1px solid #ffffff22; }
     .crop img { position: absolute; width: calc(100% * 1600 / 713); left: calc(-100% * 812 / 713); top: calc(-100% * 205 / 713); }`,
  );
  process.exit(0);
}
// 種類ごとの見出しと、右側に並べる枚数・並べ方（2026-10-05 に 2 本目 A・B・C の分を追加）。
const KINDS = {
  angle: { title: `顔 <span class="num">1</span> 枚 から、<span class="num">8</span> 方向`, n: 8, cols: 4 },
  dataset: { title: `顔 <span class="num">1</span> 枚 から、素材 <span class="num">48</span> 枚`, n: 8, cols: 4 },
  lora: { title: `素材から、自分の LoRA`, n: 4, cols: 2 },
  retrain: { title: `同じ素材で、学び直す`, n: 8, cols: 4 },
};
if (!KINDS[kind] || !face || !resultsDir) {
  console.error(`使い方: node brand/thumbnail.mjs <${Object.keys(KINDS).join("|")}> <元の顔> <結果の画像フォルダ>`);
  process.exit(1);
}
const spec = KINDS[kind];

const dataUri = (p) => `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;
const results = fs
  .readdirSync(resultsDir)
  .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
  .sort()
  .slice(0, spec.n)
  .map((f) => dataUri(path.join(resultsDir, f)));

await shoot(
  kind,
  `<h1>${spec.title}</h1>
  <div class="row">
    <img class="face" src="${dataUri(face)}">
    <div class="arrow">→</div>
    <div class="grid">${results.map((u) => `<img src="${u}">`).join("")}</div>
  </div>`,
  `.grid { flex: 1; height: 100%; display: grid; grid-template-columns: repeat(${spec.cols}, 1fr); grid-template-rows: repeat(2, 1fr); gap: 10px; }`,
);

async function shoot(name, body, extraCss) {
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
    .grid img { width: 100%; height: 100%; object-fit: cover; object-position: center 20%; border-radius: 6px; }
    .brand { position: absolute; right: 52px; top: 50px; font-family: 'Fraunces', serif; font-size: 26px; letter-spacing: 0.16em; color: #77756f; }
    ${extraCss}
  </style></head><body><div class="wrap">${body}<div class="brand">ULL Studio</div></div></body></html>`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  await browser.close();
  console.log(`保存: ${path.relative(root, file)}`);
}
