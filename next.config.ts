import type { NextConfig } from "next";

// セキュリティ用のヘッダー（2026-10-09 点検、docs/security-audit.md）。全ページ・全 API に付ける。
// - 他サイトの枠（iframe）に入れて操作をだます手口を防ぐ（同じサイトの枠は使っているので SAMEORIGIN）。
// - 中身の種類の推測をさせない・リファラーは自サイト外へはドメインだけ・使わない端末機能は止める。
// 本格的な CSP（読み込み元の制限）は Polar の決済・YouTube・R2／Modal の配信など読み込み元が多く、壊しやすいので入れていない。
const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // payment は止めない（Polar の埋め込み決済の枠が Apple Pay・Google Pay で使う）。
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
