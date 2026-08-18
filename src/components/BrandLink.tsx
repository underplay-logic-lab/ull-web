"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

type BrandLinkProps = {
  className?: string;
  children: ReactNode;
  onNavigate?: () => void;
};

export function BrandLink({ className, children, onNavigate }: BrandLinkProps) {
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onNavigate?.();

    const isAlreadyOnHomeTop = window.location.pathname === "/";

    if (isAlreadyOnHomeTop) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  return (
    <Link href="/" scroll={true} className={className} onClick={handleClick}>
      {children}
    </Link>
  );
}
