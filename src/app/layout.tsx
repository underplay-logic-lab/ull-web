import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { AdminEditBar } from "@/components/AdminEditBar";
import { LiveInspector } from "@/components/LiveInspector";
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
        <SiteContentEditorProvider>
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
          <AdminEditBar />
          <LiveInspector />
        </SiteContentEditorProvider>
      </body>
    </html>
  );
}
