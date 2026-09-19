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

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: `${siteConfig.name} — ${siteConfig.tagline}`,
  description: siteConfig.description,
  keywords: [
    "AI",
    "ComfyUI",
    "Stable Diffusion",
    "自動化",
    "ツール",
    "Underplay",
  ],
};

const SITE_URL = "https://www.ullstudio.com";

// 機能一覧・価格(featureList/offers)は Director/LoRA 等の仕様が固まるまで流動的なため
// 意図的に含めない(ローンチ判断時に SoftwareApplication/FAQPage スキーマとして追加予定
// — [[launch-checklist-ai-seo]])。ここでは書き直しの要らない基本情報のみ先出しする。
const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "ULL Studio",
  legalName: siteConfig.legalName,
  url: SITE_URL,
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
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
