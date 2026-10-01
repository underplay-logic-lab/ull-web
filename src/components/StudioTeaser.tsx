"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { EditableText } from "@/components/EditableText";

// トップページの「Studio」セクション（2026-10-01）。Studio 本体は専用ページ /studio へ移した（ホスト指摘: トップの 1 セクション
// だと作業中に下へスクロールしすぎて料金表などが出てくる）。ここは各機能への入口だけ。見出しは Studio 本体と同じ siteKey を使う。
// id="studio" は残す（#studio へのリンクは StudioHashRedirect が /studio へ送るが、送れない経路でもここに着く）。
// 機能の並びは Studio.tsx の STUDIO_TABS と揃える（ホスト指定 2026-09-25）。基盤モデル名は出さない（CLAUDE.md §2）。

const FEATURES: { tab: string; label: string; desc: string }[] = [
  { tab: "director", label: "🎥 Cinematic Director", desc: "参照画像とシーンを並べるだけで、最大 60 秒の連続した映像に。" },
  { tab: "upscale_video", label: "🎬 4K動画超解像", desc: "短い動画の解像感を、動きの一貫性を保ったまま引き上げます。" },
  { tab: "upscale", label: "✨ 4K/8K超解像", desc: "キャラの同一性を保ったまま、画像を 4K・8K へ。" },
  { tab: "angle", label: "🎭 マルチアングル", desc: "1 枚の画像から、向き・アングル・距離の違う構図をまとめて。" },
  { tab: "dataset", label: "🧩 素材づくり", desc: "1 枚から、同じキャラのまま LoRA の学習素材を枚数ぶん。" },
  { tab: "lora", label: "🎨 LoRA Studio", desc: "自分の画像で LoRA を学習。素材の診断からキャプションまで。" },
];

export function StudioTeaser() {
  return (
    <section id="studio" data-source-file="src/components/StudioTeaser.tsx" className="relative py-24 sm:py-32">
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-40" />
      <div className="relative mx-auto max-w-5xl px-6">
        <div className="mb-12 text-center">
          <EditableText
            as="p"
            siteKey="studio_eyebrow"
            fallback="Studio"
            className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-pink"
          />
          <EditableText
            as="h2"
            siteKey="studio_title"
            fallback="AI動画・画像生成スタジオ"
            className="text-3xl font-bold tracking-tight sm:text-4xl"
          />
          <EditableText
            as="p"
            siteKey="studio_tagline"
            fallback="あなたのこだわりで、育っていくスタジオ。"
            className="mt-3 text-sm font-medium text-gradient"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <Link
              key={f.tab}
              href={`/studio?tab=${f.tab}`}
              className="group rounded-2xl border border-border bg-surface/40 p-5 transition-colors hover:border-neon-violet/50 hover:bg-surface/70"
            >
              <p className="flex items-center justify-between gap-2 text-sm font-semibold text-foreground">
                {f.label}
                <ArrowRight size={14} className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-neon-violet" />
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted">{f.desc}</p>
            </Link>
          ))}
        </div>

        <div className="mt-10 flex justify-center">
          <Link
            href="/studio"
            className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-neon-pink to-neon-violet px-8 py-3 text-sm font-semibold text-background transition-opacity hover:opacity-90"
          >
            Studio を開く
            <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}
