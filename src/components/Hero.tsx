"use client";

import { ArrowDown, LogIn, Wallet } from "lucide-react";
import { EditableText } from "@/components/EditableText";
import { EditableLink } from "@/components/EditableLink";
import { EditableMedia } from "@/components/EditableMedia";

// トップの看板（2026-10-01 に「いいとこどり」から「声が届く距離の、映像スタジオ。」へ）。旧見出しの
// 「高価なPCも、理不尽な規制も、待機課金も」は比較の節（ComparisonSection）の副題へ移した。未認証向けの無料お試し生成ボタン（推論デモ）は置かない — 自前 GPU
// を 1 秒も無駄にしないための原価防衛（Task spec §1）。CTA はログイン導線と
// 料金導線の 2 つだけ。
export function Hero() {
  return (
    <section
      data-source-file="src/components/Hero.tsx"
      className="relative min-h-screen flex items-center justify-center overflow-hidden grid-bg"
    >
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute top-1/4 left-1/4 h-96 w-96 rounded-full bg-neon-pink/10 blur-[120px] animate-pulse-glow" />
        <div className="absolute bottom-1/4 right-1/4 h-96 w-96 rounded-full bg-neon-violet/10 blur-[120px] animate-pulse-glow" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6 pt-32 pb-20 text-center">
        <div className="mb-8 inline-flex items-center rounded-full border border-border bg-surface/60 px-4 py-1.5 text-xs tracking-[0.2em] text-muted backdrop-blur-sm">
          <EditableText siteKey="hero_ii_badge" fallback="少人数の、オーダーメイドの映像スタジオ" />
        </div>

        <h1 className="mx-auto max-w-4xl font-serif text-3xl font-normal leading-snug tracking-[0.12em] sm:text-5xl md:text-6xl">
          {/* 言葉の途中で折り返さないよう、読点で区切って inline-block にする（狭い画面では読点の後で改行）。 */}
          <EditableText siteKey="hero_ii_title_line1" fallback="声が届く距離の、" className="inline-block text-foreground" />
          <EditableText siteKey="hero_ii_title_line2" fallback="映像スタジオ。" className="inline-block text-foreground" />
        </h1>

        {/* 大見出しは店の在り方、一言は今いちばん強い機能、補足は「要望で作り足す」（2026-10-01 ブランド刷新）。
            値段・GPU の話はトップに置かない（比較の節・待機費用の節にある）。リクエストは会員限定なので呼びかけにはしない。 */}
        <p className="mx-auto mt-8 max-w-2xl text-lg font-semibold text-foreground sm:text-xl">
          <EditableText siteKey="hero_kodawari_line" fallback="顔 1 枚から、" className="inline-block" />
          <EditableText siteKey="hero_kodawari_line2" fallback="同じ人がどんな場面でも動いてしゃべる。" className="inline-block" />
        </p>
        <EditableText
          as="p"
          siteKey="hero_kodawari_sub"
          fallback="「こうしたい」を聞いて、機能を作り足していくスタジオです。"
          className="mx-auto mt-3 max-w-2xl text-sm text-muted sm:text-base"
        />

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <EditableLink
            siteKey="hero_ii_cta_primary_href"
            fallback="#studio"
            className="group flex items-center gap-2 rounded-full bg-gradient-to-r from-neon-pink to-neon-violet px-8 py-3.5 text-sm font-semibold text-background transition-all hover:opacity-90 glow-pink"
          >
            <LogIn size={16} />
            <EditableText siteKey="hero_ii_cta_primary" fallback="ログイン / スタジオを開く" />
          </EditableLink>
          <EditableLink
            siteKey="hero_ii_cta_secondary_href"
            fallback="#pricing"
            className="flex items-center gap-2 rounded-full border border-border bg-surface/60 px-8 py-3.5 text-sm font-semibold text-foreground transition-colors hover:border-neon-violet/40"
          >
            <Wallet size={16} />
            <EditableText siteKey="hero_ii_cta_secondary" fallback="料金を見る" />
          </EditableLink>
        </div>

        <div className="mt-12">
          <EditableMedia
            siteKey="hero_visual_url"
            kind="image"
            alt="Hero visual"
            className="mx-auto max-h-72 w-full max-w-2xl overflow-hidden rounded-2xl"
          />
        </div>

        <a
          href="#comparison"
          className="mt-16 inline-flex animate-float flex-col items-center gap-2 text-muted transition-colors hover:text-neon-pink"
          aria-label="スクロール"
        >
          <span className="text-xs font-mono tracking-widest uppercase">Scroll</span>
          <ArrowDown size={16} />
        </a>
      </div>
    </section>
  );
}
