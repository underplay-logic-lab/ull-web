import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { AdminEditBar } from "@/components/AdminEditBar";
import { LiveInspector } from "@/components/LiveInspector";
import { SourceTextEditor } from "@/components/SourceTextEditor";
import { SiteContentEditorProvider } from "@/components/SiteContentEditorProvider";
import { siteConfig } from "@/lib/data";
import { FileDropGuard } from "@/components/FileDropGuard";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

// ローンチ向けに ULL Studio の説明へ（2026-09-26）。旧値は「UNDERPLAY LOGIC LAB — AI Generation & Automation」
// ＋ツール配布サイトの説明で、キーワードに基盤名（ComfyUI / Stable Diffusion）も出ていた（CLAUDE.md §2）。
// siteConfig は法務ページの表記にも使うので触らない。
const SITE_TITLE = "ULL Studio — スマホで動く、データセンター級 GPU の AI 映像・画像スタジオ";
const SITE_DESCRIPTION =
  "動画生成・マルチアングル・4K/8K 超解像・LoRA 学習を、ブラウザだけで。環境構築は不要、GPU を使った分だけの従量課金。";

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  keywords: ["AI動画生成", "マルチアングル", "超解像", "LoRA学習", "ULL Studio"],
};

const SITE_URL = "https://www.ullstudio.com";

// 価格（offers）は料金ページを作り直すまで含めない（[[launch-checklist-ai-seo]]）。機能一覧は
// public/llms.txt と揃える。基盤モデル名・GPU 型番は書かない（CLAUDE.md §2）。
const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "ULL Studio",
  legalName: siteConfig.legalName,
  url: SITE_URL,
};

const softwareJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "ULL Studio",
  url: SITE_URL,
  applicationCategory: "MultimediaApplication",
  operatingSystem: "Web",
  description: SITE_DESCRIPTION,
  featureList: [
    "Cinematic Director: 参照画像を起点に、セリフ（日本語の音声・リップシンク）付きの映像を生成",
    "マルチアングル: 1 枚の画像から同一性を保ったまま別アングルを生成",
    "4K/8K 超解像（画像、複数枚まとめて処理）",
    "4K 動画超解像",
    "LoRA Studio: キャプション作成・構図の診断・学習回数の調整まで画面上で行う LoRA 学習",
  ],
};

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "ULL Studio",
  url: SITE_URL,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ja"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body
        className="min-h-full flex flex-col bg-background text-foreground"
        data-project-root={
          process.env.NODE_ENV === "development" ? process.cwd().replace(/\\/g, "/") : undefined
        }
      >
        <FileDropGuard />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
        />
        <SiteContentEditorProvider>
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
          <AdminEditBar />
          <LiveInspector />
          <SourceTextEditor />
        </SiteContentEditorProvider>
      </body>
    </html>
  );
}
