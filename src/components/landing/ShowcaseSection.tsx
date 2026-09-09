"use client";

import { useEffect, useState } from "react";
import { Rotate3d, Users } from "lucide-react";
import { EditableText } from "@/components/EditableText";
import { ShowcaseMedia } from "@/components/landing/ShowcaseMedia";
import { BeforeAfterSlider } from "@/components/landing/BeforeAfterSlider";
import { useReveal, revealClass } from "@/components/landing/useReveal";

// 360° ターンアラウンド: 6 コマ（正面→斜め→真横→背面→アオリ→フカン）を
// 一定間隔で切り替える。各コマは ShowcaseMedia（未設定ならスケルトン）。
const TURN_FRAMES = [
  { key: "showcase_turn_front", label: "正面" },
  { key: "showcase_turn_diag", label: "斜め" },
  { key: "showcase_turn_side", label: "真横 90°" },
  { key: "showcase_turn_back", label: "背面" },
  { key: "showcase_turn_low", label: "アオリ" },
  { key: "showcase_turn_high", label: "フカン" },
];

function TurnaroundLoop() {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % TURN_FRAMES.length), 1100);
    return () => clearInterval(t);
  }, [paused]);

  return (
    <div
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="relative" style={{ aspectRatio: "1 / 1" }}>
        {TURN_FRAMES.map((frame, i) => (
          <div
            key={frame.key}
            className={`absolute inset-0 transition-opacity duration-500 ${
              i === idx ? "opacity-100" : "opacity-0"
            }`}
          >
            <ShowcaseMedia
              siteKey={frame.key}
              ratio="1 / 1"
              label={frame.label}
              className="h-full w-full"
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-center gap-1.5">
        {TURN_FRAMES.map((frame, i) => (
          <button
            key={frame.key}
            type="button"
            aria-label={frame.label}
            onClick={() => setIdx(i)}
            className={`h-1.5 rounded-full transition-all ${
              i === idx ? "w-6 bg-neon-pink" : "w-1.5 bg-border hover:bg-muted"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

export function ShowcaseSection() {
  const { ref, shown } = useReveal<HTMLDivElement>();

  return (
    <section
      id="showcase"
      data-source-file="src/components/landing/ShowcaseSection.tsx"
      className="relative py-24 sm:py-32"
    >
      <div ref={ref} className="relative mx-auto max-w-6xl px-6">
        <div className={`mb-14 text-center ${revealClass(shown)}`}>
          <EditableText
            as="p"
            siteKey="showcase_eyebrow"
            fallback="Evidence Showcase"
            className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-violet"
          />
          <EditableText
            as="h2"
            siteKey="showcase_title"
            fallback="言葉より、動く証拠を。"
            className="text-3xl font-bold tracking-tight sm:text-4xl"
          />
          <EditableText
            as="p"
            siteKey="showcase_subtitle"
            fallback="実際の作例を触って確かめてください。すべてローカルGPUでは再現できない仕上がりです。"
            className="mx-auto mt-4 max-w-xl text-muted"
          />
        </div>

        {/* Before / After スライダー */}
        <div className={`rounded-2xl border border-border bg-surface/30 p-5 sm:p-7 ${revealClass(shown)}`}>
          <div className="mb-4 flex items-center gap-2">
            <Rotate3d size={16} className="text-neon-pink" />
            <EditableText
              as="h3"
              siteKey="showcase_ba_title"
              fallback="真横90°でも破綻しない Multi-Angle"
              className="text-sm font-bold text-foreground"
            />
          </div>
          <BeforeAfterSlider
            beforeKey="showcase_ba_before"
            afterKey="showcase_ba_after"
            beforeLabel="他社標準 i2i"
            afterLabel="ULL Multi-Angle"
            ratio="16 / 10"
          />
          <p className="mt-3 text-xs leading-relaxed text-muted">
            <EditableText
              siteKey="showcase_ba_caption"
              fallback="境界線をドラッグ。他社 i2i は横顔で崩れ、ULL はテクスチャと同一性を完全維持。"
            />
          </p>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {/* 360° ターンアラウンド */}
          <div className={`rounded-2xl border border-border bg-surface/30 p-5 sm:p-7 ${revealClass(shown)}`}>
            <div className="mb-4 flex items-center gap-2">
              <Rotate3d size={16} className="text-neon-violet" />
              <EditableText
                as="h3"
                siteKey="showcase_turn_title"
                fallback="360° ターンアラウンド"
                className="text-sm font-bold text-foreground"
              />
            </div>
            <TurnaroundLoop />
            <p className="mt-3 text-xs leading-relaxed text-muted">
              <EditableText
                siteKey="showcase_turn_caption"
                fallback="正面→斜め→真横→背面→アオリ→フカン。1枚の入力から全アングルを一貫生成。"
              />
            </p>
          </div>

          {/* 2人同時挿げ替え */}
          <div className={`rounded-2xl border border-border bg-surface/30 p-5 sm:p-7 ${revealClass(shown)}`}>
            <div className="mb-4 flex items-center gap-2">
              <Users size={16} className="text-neon-pink" />
              <EditableText
                as="h3"
                siteKey="showcase_swap_title"
                fallback="2人同時キャラ挿げ替え"
                className="text-sm font-bold text-foreground"
              />
            </div>
            <BeforeAfterSlider
              beforeKey="showcase_swap_before"
              afterKey="showcase_swap_after"
              beforeLabel="元画像（2人）"
              afterLabel="A・B を LoRA で置換"
              ratio="16 / 10"
            />
            <p className="mt-3 text-xs leading-relaxed text-muted">
              <EditableText
                siteKey="showcase_swap_caption"
                fallback="2人写りの元画像から、キャラA・キャラBそれぞれの LoRA で完全置換。"
              />
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
