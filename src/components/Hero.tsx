"use client";

import { ArrowDown, LogIn, Sparkles, Wallet } from "lucide-react";
import { EditableText } from "@/components/EditableText";
import { EditableLink } from "@/components/EditableLink";
import { EditableMedia } from "@/components/EditableMedia";

// 「いいとこどり」ヒーロー。ローカルの自由度 × クラウドの手軽さ × 秒単位の
// 適正価格。未認証向けの無料お試し生成ボタン（推論デモ）は置かない — 自前 GPU
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
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface/60 px-4 py-1.5 text-xs font-mono text-muted backdrop-blur-sm">
          <Sparkles size={12} className="text-neon-pink" />
          <EditableText
            siteKey="hero_ii_badge"
            fallback="ローカルの自由度 × クラウドの手軽さ × 秒単位の適正価格"
          />
        </div>

        <h1 className="mx-auto max-w-4xl text-3xl font-bold leading-tight tracking-tight sm:text-5xl md:text-6xl">
          <EditableText
            siteKey="hero_ii_title_line1"
            fallback="高価なPCも、理不尽な規制も、待機課金も、"
            className="inline-block text-foreground"
          />
          <br />
          <EditableText
            siteKey="hero_ii_title_line2"
            fallback="すべて過去にする。"
            className="inline-block text-foreground"
          />
          <br />
          <EditableText
            siteKey="hero_ii_title_line3"
            fallback="画像生成の「いいとこどり」を、この1画面に。"
            className="inline-block text-gradient"
          />
        </h1>

        <p className="mx-auto mt-8 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
          <EditableText
            siteKey="hero_ii_subtitle"
            fallback="スマホから世界最高峰のGPUパワーを1クリックで解放する、次世代クリエイティブスタジオ。月額固定費は0円、生成した分だけの完全従量課金。"
          />
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <EditableLink
            siteKey="hero_ii_cta_primary_href"
            fallback="#studio"
            className="group flex items-center gap-2 rounded-full bg-gradient-to-r from-neon-pink to-neon-violet px-8 py-3.5 text-sm font-semibold text-white transition-all hover:opacity-90 glow-pink"
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

        <div className="mt-16 flex flex-wrap items-center justify-center gap-8 text-center">
          {[
            { value: "¥0", label: "月額固定費" },
            { value: "0円", label: "待機中コスト（Scale-to-Zero）" },
            { value: "秒単位", label: "従量課金" },
            { value: "スマホ可", label: "必要な端末" },
          ].map((stat) => (
            <div key={stat.label}>
              <div className="font-mono text-2xl font-bold text-gradient">
                {stat.value}
              </div>
              <div className="mt-1 text-xs text-muted">{stat.label}</div>
            </div>
          ))}
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
