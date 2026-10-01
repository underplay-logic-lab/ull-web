// ブランド案（ロゴ・アイコン・YouTube バナー・サイトのヘッダー）を HTML で描いて PNG に書き出す。
//   node brand/render.mjs   → out/brand/<案>-<種類>.png と見比べ用の out/brand/sheet.png（BRAND_OUT で出力先を変えられる）
//
// 2026-10-01 にブランドを一から決め直し中（旧ロゴの斜線とピンク→紫は Gemini の仮置き）。名前は ULL Studio のまま、意味を読み替える:
//   Under(par) = 少ない手数で叶える / Underplay = 控えめ・知る人ぞ知る / Logic Lab = 要望を検証して作る
// サイズ: アイコン 1024、YouTube バナー 2560×1440（どの端末でも見えるのは中央 1546×423）。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.BRAND_OUT ?? path.join(root, "out", "brand");
fs.mkdirSync(out, { recursive: true });

const MAIN = "声が届く距離の、映像スタジオ。";
const SUB = "要望で育つ、映像・画像スタジオ";
const URL = "ullstudio.com";
const YT = { w: 2560, h: 1440, safe: { w: 1546, h: 423 } };

const fonts = `<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700;800&family=Noto+Sans+JP:wght@400;500;700&family=Noto+Serif+JP:wght@400;600&family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter+Tight:wght@500;600;700&display=block" rel="stylesheet">`;

// 2026-10-01 ホスト: ゴルフ要素は要らない・記号（_ や /）は足さない・閉じた／秘密のサイトらしさで黒か白か迷う。
// → 文字だけのロゴを「黒／白」×「ゴシック／明朝」の 2×2 で並べる。差し色は使わない（控えめに）。
const PALETTE = {
  black: { bg: "#0b0b0c", fg: "#ecebe7", muted: "#77756f", line: "#ffffff14" },
  white: { bg: "#f4f3ef", fg: "#111111", muted: "#8a877f", line: "#11111114" },
};
const TYPE = {
  sans: { latin: "'Inter Tight'", latinWeight: 600, jp: "'Noto Sans JP'", jpWeight: 500, track: "0.32em", upper: true },
  // アイコンは 22px 程度まで縮むので、明朝は太め・小さい文字向けの字形（opsz 低め）にする。
  serif: { latin: "'Fraunces'", latinWeight: 400, iconWeight: 600, iconOpsz: 24, jp: "'Noto Serif JP'", jpWeight: 400, track: "0.16em", upper: false },
};
const make = (pal, type, name) => {
  const p = { ...PALETTE[pal], name };
  const t = TYPE[type];
  const word = (s) => (t.upper ? s.toUpperCase() : s);
  const logo = (px) =>
    `<span style="font-family:${t.latin};font-weight:${t.latinWeight};font-size:${px}px;letter-spacing:${t.track};color:${p.fg};line-height:1;white-space:nowrap;margin-right:-${t.track}">${word("ULL")}<span style="color:${p.muted};margin-left:0.5em">${word("Studio")}</span></span>`;
  return {
    p,
    logo,
    icon: () => `
      <div style="position:absolute;inset:0;background:${p.bg}"></div>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
        <span style="font-family:${t.latin};font-weight:${t.iconWeight ?? t.latinWeight};font-variation-settings:'opsz' ${t.iconOpsz ?? 144};font-size:${t.upper ? 230 : 290}px;letter-spacing:${t.track};margin-right:-${t.track};color:${p.fg};line-height:1">ULL</span>
      </div>`,
    // 閉じた場所らしく、置くものは最小限: ロゴと一行だけ。URL は小さく。
    banner: ({ safe }) => {
      const k = safe.h / 423;
      return `
      <div style="position:absolute;inset:0;background:${p.bg}"></div>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
        <div style="text-align:center">
          ${logo((t.upper ? 76 : 104) * k)}
          <div style="font-family:${t.jp};font-weight:${t.jpWeight};font-size:${40 * k}px;color:${p.fg};margin-top:${40 * k}px;letter-spacing:0.2em;margin-right:-0.2em">${MAIN}</div>
          <div style="font-family:${t.latin};font-size:${22 * k}px;color:${p.muted};margin-top:${24 * k}px;letter-spacing:0.3em;margin-right:-0.3em">${URL}</div>
        </div>
      </div>`;
    },
  };
};

const DESIGNS = {
  "black-sans": make("black", "sans", "黒 × ゴシック"),
  "black-serif": make("black", "serif", "黒 × 明朝"),
  "white-sans": make("white", "sans", "白 × ゴシック"),
  "white-serif": make("white", "serif", "白 × 明朝"),
};

// サイトのヘッダーに置いた見え方（1440×72 相当）。
const header = (d) => `
  <div style="position:absolute;inset:0;background:${d.p.bg};border-bottom:1px solid ${d.p.line};display:flex;align-items:center;justify-content:space-between;padding:0 48px">
    ${d.logo(26)}
    <div style="display:flex;gap:36px;align-items:center;font-family:'Noto Sans JP';font-size:15px;color:${d.p.muted}">
      <span>Studio</span><span>料金</span><span>お問い合わせ</span>
      <span style="padding:9px 18px;border-radius:8px;background:${d.p.fg};color:${d.p.bg};font-weight:700">ログイン</span>
    </div>
  </div>`;

const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const shoot = async (file, w, h, body) => {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8">${fonts}<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;overflow:hidden}</style></head>` +
      `<body><div style="position:relative;width:${w}px;height:${h}px">${body}</div></body></html>`,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, file) });
  await page.close();
};

for (const [key, d] of Object.entries(DESIGNS)) {
  await shoot(`${key}-icon.png`, 1024, 1024, d.icon());
  await shoot(`${key}-youtube.png`, YT.w, YT.h, d.banner(YT));
  await shoot(`${key}-header.png`, 1440, 72, header(d));
  console.log(`案 ${key} 書き出し済み`);
}

// 採用案（2026-10-01 ホスト決定: 黒 × 明朝）。アップロード用はこの 2 枚。
const FINAL = "black-serif";
fs.copyFileSync(path.join(out, `${FINAL}-icon.png`), path.join(out, "youtube-icon.png"));
fs.copyFileSync(path.join(out, `${FINAL}-youtube.png`), path.join(out, "youtube-banner.png"));

// 見比べ用の一覧。アイコンは丸く切り抜いた見え方と小さい見え方、YouTube はスマホでも見える範囲を点線で。
const img = (f) => `data:image/png;base64,${fs.readFileSync(path.join(out, f)).toString("base64")}`;
const row = ([key, d]) => {
  const swatch = (c, label) =>
    `<div style="display:flex;align-items:center;gap:8px"><span style="width:28px;height:28px;border-radius:6px;background:${c};border:1px solid #ffffff33"></span><span>${label} ${c}</span></div>`;
  return `
<section style="margin-bottom:54px">
  <div style="display:flex;align-items:baseline;gap:24px;margin-bottom:16px">
    <h2 style="font-size:32px">案 ${d.p.name}</h2>
    <div style="display:flex;gap:18px;font-size:15px;color:#aaa">${swatch(d.p.bg, "地")}${swatch(d.p.fg, "文字")}${swatch(d.p.muted, "控えめの文字")}</div>
  </div>
  <div style="display:flex;gap:28px;align-items:flex-start">
    <div style="display:flex;flex-direction:column;gap:14px;align-items:center">
      <img src="${img(`${key}-icon.png`)}" style="width:210px;height:210px;border-radius:50%">
      <div style="display:flex;gap:12px;align-items:center">
        ${[48, 32, 22].map((s) => `<img src="${img(`${key}-icon.png`)}" style="width:${s}px;height:${s}px;border-radius:50%">`).join("")}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="position:relative;width:768px;height:432px">
        <img src="${img(`${key}-youtube.png`)}" style="width:768px;height:432px">
        <div style="position:absolute;left:${(768 - YT.safe.w * 0.3) / 2}px;top:${(432 - YT.safe.h * 0.3) / 2}px;width:${YT.safe.w * 0.3}px;height:${YT.safe.h * 0.3}px;border:2px dashed #ff4d4d99"></div>
      </div>
      <div style="font-size:15px;color:#888">YouTube バナー（赤い点線の中がスマホでも見える範囲）</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px;width:560px">
      <img src="${img(`${key}-header.png`)}" style="width:560px">
      <div style="font-size:15px;color:#888">サイトのヘッダーに置いた場合</div>
    </div>
  </div>
</section>`;
};
await shoot(
  "sheet.png",
  1720,
  2380,
  `<div style="padding:44px;background:#000;color:#fff;font-family:'Noto Sans JP';height:100%">${Object.entries(DESIGNS).map(row).join("")}</div>`,
);
await browser.close();
console.log(`一覧: ${path.join(out, "sheet.png")}`);
