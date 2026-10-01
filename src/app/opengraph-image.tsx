import { ImageResponse } from "next/og";

// リンクを貼ったときのカード画像（OGP、2026-10-01 ローンチ日に追加）。Discord・X・LINE 等で表示される。
// 作例の画像に差し替えたくなったら、このファイルを消して同じ場所に opengraph-image.png（1200×630）を置けばよい。
// 書体は Fraunces と Noto Serif JP（どちらも OFL・商用可）を Google Fonts から使う文字だけ取得。取れなければ代わりの書体で描く。
// 基盤モデル名・GPU 型番は書かない（CLAUDE.md §2）。

export const alt = "ULL Studio — 声が届く距離の、映像スタジオ";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// 2026-10-01 ブランド刷新: 黒 × 明朝の文字だけ（SNS の素材 promo/brand/render.mjs と同じ組み方）。
const BG = "#0b0b0c";
const FG = "#ecebe7";
const MUTED = "#77756f";
const LINE1 = "声が届く距離の、映像スタジオ。";
const LINE2 = "画像 1 枚から、自分だけの LoRA と動画まで。";
const URL_LINE = "ullstudio.com";

// Google Fonts から使う文字だけ取る。User-Agent を付けないと TrueType が返る（satori は woff2 を読めない）。
async function loadFont(family: string, text: string): Promise<ArrayBuffer | null> {
  try {
    const css = await (
      await fetch(`https://fonts.googleapis.com/css2?family=${family}&text=${encodeURIComponent(text)}`)
    ).text();
    const url = css.match(/src:\s*url\(([^)]+)\)/)?.[1];
    if (!url) return null;
    const res = await fetch(url);
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

export default async function OpengraphImage() {
  // 画像に出す文字は全部渡す（渡し漏れた文字は別の書体で描かれて太さがちぐはぐになる）。
  const [latin, jp] = await Promise.all([
    loadFont("Fraunces:wght@400", "ULLStudio" + URL_LINE),
    loadFont("Noto+Serif+JP:wght@400", LINE1 + LINE2),
  ]);
  const fonts = [
    ...(latin ? [{ name: "Fraunces", data: latin, weight: 400 as const, style: "normal" as const }] : []),
    ...(jp ? [{ name: "NotoSerifJP", data: jp, weight: 400 as const, style: "normal" as const }] : []),
  ];
  const latinFamily = latin ? "Fraunces" : "serif";
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: BG,
          color: FG,
          fontFamily: jp ? "NotoSerifJP" : "serif",
        }}
      >
        <div style={{ display: "flex", fontFamily: latinFamily, fontSize: 104, letterSpacing: 17 }}>
          ULL<span style={{ marginLeft: 52, color: MUTED }}>Studio</span>
        </div>
        {jp && <div style={{ display: "flex", marginTop: 44, fontSize: 40, letterSpacing: 8 }}>{LINE1}</div>}
        {jp && <div style={{ display: "flex", marginTop: 20, fontSize: 26, color: MUTED, letterSpacing: 4 }}>{LINE2}</div>}
        <div style={{ display: "flex", marginTop: 44, fontFamily: latinFamily, fontSize: 22, color: MUTED, letterSpacing: 6 }}>{URL_LINE}</div>
      </div>
    ),
    { ...size, ...(fonts.length ? { fonts } : {}) },
  );
}
