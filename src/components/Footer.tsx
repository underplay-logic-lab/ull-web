"use client";

import Link from "next/link";
import { siteConfig, CONTACT_EMAIL } from "@/lib/data";
import { BrandLink } from "@/components/BrandLink";
import { EditableText } from "@/components/EditableText";

const legalLinks = [
  { label: "料金の目安", href: "/pricing" },
  { label: "よくある質問", href: "/faq" },
  { label: "利用規約", href: "/terms" },
  { label: "プライバシーポリシー", href: "/privacy" },
  { label: "特定商取引法に基づく表記", href: "/tokushoho" },
];

export function Footer() {
  // 公開年から今年まで（年が変わったら「2026–2027」。公開年＝いつからあるかを示す、2026-09-30 ホスト）。
  const year = new Date().getFullYear();
  const years = year > 2026 ? `2026–${year}` : "2026";

  return (
    <footer data-source-file="src/components/Footer.tsx" className="border-t border-border bg-surface/30">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
          <BrandLink className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold">
              <span className="text-neon-pink">/</span>
              {siteConfig.name}
            </span>
          </BrandLink>

          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            {legalLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-xs text-muted transition-colors hover:text-neon-pink"
              >
                {link.label}
              </Link>
            ))}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-xs text-muted transition-colors hover:text-neon-pink"
            >
              {CONTACT_EMAIL}
            </a>
          </nav>
        </div>

        <EditableText
          as="p"
          siteKey="footer_copyright"
          fallback={`© ${years} ULL Studio. Powered by Underplay Logic Engine.`}
          className="mt-2 text-center text-xs text-muted sm:text-left"
        />
        </div>
    </footer>
  );
}
