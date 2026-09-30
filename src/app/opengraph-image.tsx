import { ImageResponse } from "next/og";

// リンクを貼ったときのカード画像（OGP、2026-10-01 ローンチ日に追加）。Discord・X・LINE 等で表示される。
// 作例の画像に差し替えたくなったら、このファイルを消して同じ場所に opengraph-image.png（1200×630）を置けばよい。
// 日本語は Noto Sans JP（OFL・商用可）を Google Fonts から使う文字だけ取得。取れなければ英語だけで描く。
// 基盤モデル名・GPU 型番は書かない（CLAUDE.md §2）。

export const alt = "ULL Studio — やりたいことが叶う、AI 映像・画像スタジオ";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TITLE = "ULL Studio";
const LINE1 = "やりたいことが叶う、AI 映像・画像スタジオ";
const LINE2 = "画像 1 枚から、自分だけの LoRA と動画まで。ブラウザだけで。";
const FALLBACK_LINE = "AI video & image studio in your browser";
const URL_LINE = "www.ullstudio.com";

async function loadJapaneseFont(text: string): Promise<ArrayBuffer | null> {
  try {
    // User-Agent を付けないと TrueType が返る（satori は woff2 を読めない）。
    const css = await (
      await fetch(`https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@700&text=${encodeURIComponent(text)}`)
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
  const font = await loadJapaneseFont(TITLE + LINE1 + LINE2 + URL_LINE);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 90px",
          background: "radial-gradient(circle at 85% 15%, rgba(139,92,246,0.45), transparent 55%), radial-gradient(circle at 10% 95%, rgba(255,42,133,0.40), transparent 50%), #121214",
          color: "#f5f5f7",
          fontFamily: font ? "NotoSansJP" : "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 108,
            fontWeight: 700,
            letterSpacing: -2,
            backgroundImage: "linear-gradient(90deg, #ff2a85, #8b5cf6)",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          {TITLE}
        </div>
        <div style={{ display: "flex", marginTop: 28, fontSize: 46, fontWeight: 700 }}>{font ? LINE1 : FALLBACK_LINE}</div>
        {font && <div style={{ display: "flex", marginTop: 18, fontSize: 30, color: "#b4b4bc" }}>{LINE2}</div>}
        <div style={{ display: "flex", marginTop: 56, fontSize: 26, color: "#8b8b95" }}>{URL_LINE}</div>
      </div>
    ),
    {
      ...size,
      ...(font ? { fonts: [{ name: "NotoSansJP", data: font, weight: 700 as const, style: "normal" as const }] } : {}),
    },
  );
}
