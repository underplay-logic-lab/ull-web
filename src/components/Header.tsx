"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X, Zap, LogIn } from "lucide-react";
import { navLinks, siteConfig } from "@/lib/data";
import { LoginModal } from "@/components/LoginModal";
import { BrandLink } from "@/components/BrandLink";

export function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-background/80 backdrop-blur-xl border-b border-border"
          : "bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <BrandLink className="group flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm font-bold tracking-tight sm:text-lg">
            <span className="text-neon-pink">/</span>
            {siteConfig.name}
          </span>
        </BrandLink>

        <nav className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-muted transition-colors hover:text-neon-pink"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <span className="hidden items-center gap-1.5 rounded-full border border-border bg-surface/60 px-3 py-1.5 font-mono text-xs text-foreground sm:flex">
            <Zap size={12} className="text-neon-pink" />
            10 Credits
          </span>

          <button
            type="button"
            onClick={() => setLoginOpen(true)}
            className="hidden items-center gap-1.5 rounded-full bg-gradient-to-r from-neon-pink to-neon-violet px-5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 sm:flex"
          >
            <LogIn size={14} />
            ログイン
          </button>

          <button
            type="button"
            className="text-foreground md:hidden"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="メニュー"
          >
            {mobileOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <nav className="border-t border-border bg-background/95 backdrop-blur-xl px-6 py-4 md:hidden">
          <div className="flex flex-col gap-4">
            <span className="flex w-fit items-center gap-1.5 rounded-full border border-border bg-surface/60 px-3 py-1.5 font-mono text-xs text-foreground">
              <Zap size={12} className="text-neon-pink" />
              10 Credits
            </span>
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-muted transition-colors hover:text-neon-pink"
                onClick={() => setMobileOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            <button
              type="button"
              onClick={() => {
                setMobileOpen(false);
                setLoginOpen(true);
              }}
              className="flex items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-neon-pink to-neon-violet px-5 py-2.5 text-center text-sm font-medium text-white"
            >
              <LogIn size={14} />
              ログイン
            </button>
          </div>
        </nav>
      )}

      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
    </header>
  );
}
