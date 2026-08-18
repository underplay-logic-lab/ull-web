import Link from "next/link";
import { siteConfig } from "@/lib/data";
import { BrandLink } from "@/components/BrandLink";

const legalLinks = [
  { label: "利用規約", href: "/terms" },
  { label: "プライバシーポリシー", href: "/privacy" },
  { label: "特定商取引法に基づく表記", href: "/tokushoho" },
];

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border bg-surface/30">
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
          </nav>
        </div>

        <p className="mt-8 text-center text-xs text-muted sm:text-left">
          &copy; {year} {siteConfig.author}. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
