"use client";

import { ArrowUpRight, MessageCircle, Newspaper, PlayCircle } from "lucide-react";
import { EditableText } from "@/components/EditableText";
import { EditableLink } from "@/components/EditableLink";
import { useReveal, revealClass } from "@/components/landing/useReveal";

// 「怪しいサービスではなく、本物の技術に基づくプロダクト」を示すリンクカード群。
// href は EditableLink（admin が差し替え）、ラベル/説明は EditableText。
const CARDS = [
  {
    id: "note",
    icon: Newspaper,
    hrefKey: "trust_note_href",
    hrefFallback: "https://note.com/",
    titleKey: "trust_note_title",
    titleFallback: "Note — 技術解説",
    descKey: "trust_note_desc",
    descFallback: "アーキテクチャ・モデル選定・原価設計の裏側を公式記事で公開。",
    cta: "記事を読む",
    accent: "text-neon-violet",
  },
  {
    id: "youtube",
    icon: PlayCircle,
    hrefKey: "trust_youtube_href",
    hrefFallback: "https://youtube.com/",
    titleKey: "trust_youtube_title",
    titleFallback: "YouTube — 実演",
    descKey: "trust_youtube_desc",
    descFallback: "スマホから3秒で生成するプレイ動画。編集なしのノーカット実演。",
    cta: "動画を見る",
    accent: "text-neon-pink",
  },
  {
    id: "x",
    icon: MessageCircle,
    hrefKey: "trust_x_href",
    hrefFallback: "https://x.com/",
    titleKey: "trust_x_title",
    titleFallback: "X — 最新情報",
    descKey: "trust_x_desc",
    descFallback: "アップデート告知と最新の作例ポストをリアルタイムで。",
    cta: "フォローする",
    accent: "text-neon-violet",
  },
];

export function TrustMediaSection() {
  const { ref, shown } = useReveal<HTMLDivElement>();

  return (
    <section
      id="trustmedia"
      data-source-file="src/components/landing/TrustMediaSection.tsx"
      className="relative py-24 sm:py-32"
    >
      <div ref={ref} className="relative mx-auto max-w-6xl px-6">
        <div className={`mb-14 text-center ${revealClass(shown)}`}>
          <EditableText
            as="p"
            siteKey="trust_eyebrow"
            fallback="Trust & Media"
            className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-pink"
          />
          <EditableText
            as="h2"
            siteKey="trust_title"
            fallback="技術は、公開されている。"
            className="text-3xl font-bold tracking-tight sm:text-4xl"
          />
          <EditableText
            as="p"
            siteKey="trust_subtitle"
            fallback="何を、どう動かしているか。記事と動画で確かめられます。"
            className="mx-auto mt-4 max-w-xl text-muted"
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-3">
          {CARDS.map((card, i) => {
            const Icon = card.icon;
            return (
              <div
                key={card.id}
                className={revealClass(shown)}
                style={{ transitionDelay: `${i * 80}ms` }}
              >
                <EditableLink
                  siteKey={card.hrefKey}
                  fallback={card.hrefFallback}
                  className="group flex h-full flex-col rounded-2xl border border-border bg-surface/40 p-6 transition-colors hover:border-neon-pink/30 hover:bg-surface/70"
                >
                  <div className="flex items-center justify-between">
                    <span className={`flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background/60 ${card.accent}`}>
                      <Icon size={18} />
                    </span>
                    <ArrowUpRight
                      size={16}
                      className="text-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground"
                    />
                  </div>
                  <EditableText
                    as="h3"
                    siteKey={card.titleKey}
                    fallback={card.titleFallback}
                    className="mt-4 text-sm font-bold text-foreground"
                  />
                  <EditableText
                    as="p"
                    siteKey={card.descKey}
                    fallback={card.descFallback}
                    className="mt-2 flex-1 text-xs leading-relaxed text-muted"
                  />
                  <span className={`mt-4 font-mono text-[11px] uppercase tracking-widest ${card.accent}`}>
                    {card.cta} →
                  </span>
                </EditableLink>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
