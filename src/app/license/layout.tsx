import type { Metadata } from "next";

// 納品ツールのライセンス用ページ（/license/offline 等）。ツールの QR から来る人だけが使うので検索に出さない。
export const metadata: Metadata = {
  title: "ライセンス認証 | ULL Studio",
  robots: { index: false, follow: false },
};

export default function LicenseLayout({ children }: { children: React.ReactNode }) {
  return children;
}
