"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, LogIn, LogOut, Settings, UserCircle2 } from "lucide-react";
import { navLinks, siteConfig } from "@/lib/data";
import { LoginModal } from "@/components/LoginModal";
import { BrandLink } from "@/components/BrandLink";
import { CreditsBadge } from "@/components/CreditsBadge";
import { MemberRankBadge } from "@/components/MemberRankBadge";
import { CancellationWarningModal } from "@/components/CancellationWarningModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits } from "@/hooks/useProfileCredits";
import { supabase } from "@/lib/supabaseClient";

export function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const { user } = useSupabaseUser();
  const { tier } = useProfileCredits(user);
  const pathname = usePathname();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;

    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken || cancelled) return;

      try {
        await fetch("/api/daily-bonus", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch (err) {
        console.error("[Header] daily bonus claim failed:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleLogout = () => {
    supabase.auth.signOut();
  };

  // Re-clicking a nav link for the section already in view is a no-op for
  // the browser (the URL hash doesn't change, so it never scrolls) — force
  // it here. Only applies on the homepage itself; links from another page
  // (e.g. /privacy) fall through to Link's normal navigation.
  const handleNavClick = (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    const targetId = href.split("#")[1];
    if (!targetId || pathname !== "/") return;

    event.preventDefault();
    document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth" });
    window.history.replaceState(null, "", `#${targetId}`);
  };

  const avatarUrl =
    user?.user_metadata?.avatar_url ?? user?.user_metadata?.picture ?? null;
  const displayName =
    user?.user_metadata?.full_name ?? user?.user_metadata?.name ?? user?.email ?? "";

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
              onClick={(e) => handleNavClick(e, link.href)}
              className="text-sm text-muted transition-colors hover:text-neon-pink"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <MemberRankBadge user={user} className="hidden sm:flex" />
          <CreditsBadge user={user} className="hidden sm:flex" />

          {user ? (
            <div className="hidden items-center gap-2 sm:flex">
              <div className="flex max-w-[10rem] items-center gap-2 rounded-full border border-border bg-surface/60 py-1 pl-1 pr-3">
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={avatarUrl}
                    alt=""
                    className="h-6 w-6 rounded-full"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <UserCircle2 size={20} className="text-muted" />
                )}
                <span className="truncate text-xs text-foreground">
                  {displayName}
                </span>
              </div>
              {tier && tier !== "free" && (
                <button
                  type="button"
                  onClick={() => setCancelModalOpen(true)}
                  aria-label="契約管理 / 領収書発行"
                  title="契約管理 / 領収書発行"
                  className="text-muted transition-colors hover:text-neon-violet"
                >
                  <Settings size={18} />
                </button>
              )}
              <button
                type="button"
                onClick={handleLogout}
                aria-label="ログアウト"
                className="text-muted transition-colors hover:text-neon-pink"
              >
                <LogOut size={18} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setLoginOpen(true)}
              className="hidden items-center gap-1.5 rounded-full bg-gradient-to-r from-neon-pink to-neon-violet px-5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 sm:flex"
            >
              <LogIn size={14} />
              新規登録 / ログイン
            </button>
          )}

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
            <div className="flex flex-wrap items-center gap-2">
              <MemberRankBadge user={user} className="flex w-fit" />
              <CreditsBadge user={user} className="flex w-fit" />
            </div>
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-muted transition-colors hover:text-neon-pink"
                onClick={(e) => {
                  setMobileOpen(false);
                  handleNavClick(e, link.href);
                }}
              >
                {link.label}
              </Link>
            ))}

            {user ? (
              <div className="flex items-center justify-between gap-3 rounded-full border border-border bg-surface/60 py-1.5 pl-2 pr-3">
                <div className="flex min-w-0 items-center gap-2">
                  {avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={avatarUrl}
                      alt=""
                      className="h-6 w-6 shrink-0 rounded-full"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <UserCircle2 size={20} className="shrink-0 text-muted" />
                  )}
                  <span className="truncate text-xs text-foreground">
                    {displayName}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {tier && tier !== "free" && (
                    <button
                      type="button"
                      onClick={() => {
                        setMobileOpen(false);
                        setCancelModalOpen(true);
                      }}
                      className="flex items-center gap-1 text-[11px] text-muted transition-colors hover:text-neon-violet"
                    >
                      <Settings size={16} />
                      契約管理 / 領収書発行
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOpen(false);
                      handleLogout();
                    }}
                    aria-label="ログアウト"
                    className="text-muted transition-colors hover:text-neon-pink"
                  >
                    <LogOut size={18} />
                  </button>
                </div>
              </div>
            ) : (
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
            )}
          </div>
        </nav>
      )}

      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      <CancellationWarningModal
        open={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        tier={tier ?? "free"}
      />
    </header>
  );
}
