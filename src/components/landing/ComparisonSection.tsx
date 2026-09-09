"use client";

import { Check, Cloud, Monitor, Sparkles, X, Zap } from "lucide-react";
import { EditableText } from "@/components/EditableText";
import { useReveal, revealClass } from "@/components/landing/useReveal";

// 3 大環境の痛点と ULL Studio の解決策。静的データ + Lucide アイコン。
// 3 カラム（lg）→ モバイルは縦積みカード。
const RIVALS = [
  {
    id: "local",
    icon: Monitor,
    name: "自宅ローカルPC",
    sub: "ComfyUI / WebUI",
    pains: [
      "生成に時間がかかる、高解像度は現実的に厳しい",
      "50万円級のゲーミングPCを買い揃える必要がある",
      "環境構築・モデル管理・VRAM 不足との戦い",
    ],
  },
  {
    id: "saas",
    icon: Cloud,
    name: "一般のクラウドAI",
    sub: "月額サブスク SaaS",
    pains: [
      "少し際どいだけで「出来ません」と拒絶される",
      "使わない月も高額な固定月額費が発生する",
      "モデルもパラメータも選べない・ブラックボックス",
    ],
  },
  {
    id: "rental",
    icon: Zap,
    name: "GPU レンタル",
    sub: "RunPod / Vast.ai 等",
    pains: [
      "考えている間・放置中も毎分課金され続ける（死に金）",
      "Linux・Docker・SSH の知識が前提で難解",
      "起動待ち、ディスク課金、インスタンスガチャ",
    ],
  },
];

const ULL_WINS = [
  "スマホ・安価なノートPCでOK。データセンター級 GPU が数秒で超高精細生成",
  "「出来ません」と言わせない高い表現の自由度。月額固定費0円・完全従量課金",
  "セットアップ0秒。待機中の費用は永久に0円（Scale-to-Zero）",
];

export function ComparisonSection() {
  const { ref, shown } = useReveal<HTMLDivElement>();

  return (
    <section
      id="comparison"
      data-source-file="src/components/landing/ComparisonSection.tsx"
      className="relative py-24 sm:py-32"
    >
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-30" />
      <div ref={ref} className="relative mx-auto max-w-6xl px-6">
        <div className={`mb-14 text-center ${revealClass(shown)}`}>
          <EditableText
            as="p"
            siteKey="cmp_eyebrow"
            fallback="Best of Both Worlds"
            className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-pink"
          />
          <EditableText
            as="h2"
            siteKey="cmp_title"
            fallback="3つの選択肢の「不満」だけを、まとめて解決する"
            className="mx-auto max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl"
          />
          <EditableText
            as="p"
            siteKey="cmp_subtitle"
            fallback="ローカルの自由度、クラウドの手軽さ、レンタルの高性能。いいとこだけを1画面に。"
            className="mx-auto mt-4 max-w-xl text-muted"
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          {RIVALS.map((rival, i) => {
            const Icon = rival.icon;
            return (
              <div
                key={rival.id}
                className={`flex flex-col rounded-2xl border border-border bg-surface/40 p-6 ${revealClass(shown)}`}
                style={{ transitionDelay: `${i * 80}ms` }}
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background/60 text-muted">
                    <Icon size={18} />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold text-foreground">{rival.name}</h3>
                    <p className="font-mono text-[11px] text-muted">{rival.sub}</p>
                  </div>
                </div>

                <ul className="mt-5 flex-1 space-y-2.5">
                  {rival.pains.map((pain) => (
                    <li key={pain} className="flex gap-2 text-xs leading-relaxed text-muted">
                      <X size={14} className="mt-0.5 shrink-0 text-red-400/70" />
                      <span>{pain}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-5 rounded-xl border border-neon-pink/25 bg-neon-pink/[0.06] p-4">
                  <p className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest text-neon-pink">
                    <Sparkles size={12} />
                    ULL Studio なら
                  </p>
                  <p className="flex gap-2 text-xs font-medium leading-relaxed text-foreground">
                    <Check size={14} className="mt-0.5 shrink-0 text-neon-pink" />
                    <span>{ULL_WINS[i]}</span>
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
