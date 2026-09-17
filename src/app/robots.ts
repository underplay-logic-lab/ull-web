import type { MetadataRoute } from "next";

const SITE_URL = "https://www.ullstudio.com";

// GPTBot/ClaudeBot/PerplexityBot/Google-Extended 等の生成AIクローラーは
// デフォルトの "*" ルールに含まれるため個別列挙は不要だが、将来的に
// 個別クロール頻度等を制御したくなった際にすぐ追加できるよう明示しておく。
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/api/", "/reset-password", "/workflow-builder"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
