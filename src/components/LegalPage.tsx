import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

type LegalPageProps = {
  title: string;
  updatedAt: string;
  children: ReactNode;
};

export function LegalPage({ title, updatedAt, children }: LegalPageProps) {
  return (
    <div className="relative py-32">
      <div className="mx-auto max-w-3xl px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-neon-pink"
        >
          <ArrowLeft size={16} />
          Back to Home
        </Link>

        <h1 className="mt-8 text-3xl font-bold tracking-tight sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 font-mono text-xs text-muted">
          最終更新日: {updatedAt}
        </p>

        <div className="prose-legal mt-12 space-y-10 text-sm leading-relaxed text-foreground/80">
          {children}
        </div>
      </div>
    </div>
  );
}

type LegalSectionProps = {
  heading: string;
  children: ReactNode;
};

export function LegalSection({ heading, children }: LegalSectionProps) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-bold text-foreground">{heading}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
