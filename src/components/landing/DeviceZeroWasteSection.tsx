"use client";

import { useEffect, useRef, useState } from "react";
import { Cpu } from "lucide-react";
import { EditableText } from "@/components/EditableText";
import { useReveal, revealClass } from "@/components/landing/useReveal";

// 一般 GPU レンタルの「放置中も課金が増えるカウンター」を模したデモ。
// $0.0002/s で加算。prefers-reduced-motion では停止した値を出すだけ。
const RENTAL_RATE_USD_PER_SEC = 0.0002;

function RentalMeter({ running }: { running: boolean }) {
  // reduced-motion 判定は初回だけ（SSR では false）。true のときは RAF を回さず
  // 「2分ちょっと放置した」相当の静止値を表示する。
  const [reduce] = useState(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  const [usd, setUsd] = useState(0);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running || reduce) return;
    const tick = (t: number) => {
      if (startRef.current == null) startRef.current = t;
      const elapsed = (t - startRef.current) / 1000;
      setUsd(elapsed * RENTAL_RATE_USD_PER_SEC);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      startRef.current = null;
    };
  }, [running, reduce]);

  const display = reduce ? RENTAL_RATE_USD_PER_SEC * 137 : usd;

  return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/[0.05] p-6">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
        <span className="font-mono text-[11px] uppercase tracking-widest text-red-400">
          一般 GPU レンタル
        </span>
      </div>
      <p className="mt-4 font-mono text-3xl font-bold tabular-nums text-red-400">
        ${display.toFixed(4)}
      </p>
      <p className="mt-1 font-mono text-[11px] text-red-400/70">
        +${RENTAL_RATE_USD_PER_SEC.toFixed(4)} / 秒 — 何もしていなくても加算され続ける
      </p>
    </div>
  );
}

function UllMeter() {
  return (
    <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.05] p-6">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <span className="font-mono text-[11px] uppercase tracking-widest text-emerald-400">
          ULL Studio
        </span>
      </div>
      <p className="mt-4 font-mono text-3xl font-bold tabular-nums text-emerald-400">
        ¥0.00
      </p>
      <p className="mt-1 font-mono text-[11px] text-emerald-400/70">
        停止中 — 生成していない時間の課金は永久にゼロ（Scale-to-Zero）
      </p>
    </div>
  );
}

function PhoneMock() {
  return (
    <div className="relative mx-auto w-52 sm:w-60">
      {/* 背後で光るデータセンター GPU（物理型番は出さない — CLAUDE.md §2） */}
      <div className="pointer-events-none absolute -inset-10 -z-10">
        <div className="absolute inset-0 rounded-[3rem] bg-neon-violet/20 blur-[80px] animate-pulse-glow" />
        <div className="absolute inset-x-6 bottom-0 h-24 rounded-full bg-neon-pink/20 blur-[60px] animate-pulse-glow" />
      </div>

      <div className="relative overflow-hidden rounded-[2.2rem] border-4 border-border bg-background shadow-2xl">
        <div className="mx-auto mt-2 h-1.5 w-16 rounded-full bg-border" />
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-neon-pink to-neon-violet text-white">
              <Cpu size={14} />
            </span>
            <div className="h-2 w-20 rounded-full bg-surface-hover" />
          </div>
          <div className="aspect-square rounded-xl bg-gradient-to-br from-neon-violet/25 via-surface to-neon-pink/20" />
          <div className="h-8 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet" />
          <div className="flex gap-2">
            <div className="h-6 flex-1 rounded-lg bg-surface-hover" />
            <div className="h-6 w-10 rounded-lg bg-surface-hover" />
          </div>
        </div>
      </div>

      <div className="absolute -right-3 top-1/3 flex items-center gap-1.5 rounded-full border border-neon-violet/40 bg-surface px-3 py-1 font-mono text-[10px] text-neon-violet shadow-lg">
        <Cpu size={11} />
        データセンター級 GPU
      </div>
    </div>
  );
}

export function DeviceZeroWasteSection() {
  const { ref, shown } = useReveal<HTMLDivElement>();

  return (
    <section
      id="devicezerowaste"
      data-source-file="src/components/landing/DeviceZeroWasteSection.tsx"
      className="relative overflow-hidden py-24 sm:py-32"
    >
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-30" />
      <div ref={ref} className="relative mx-auto max-w-6xl px-6">
        <div className={`mb-14 text-center ${revealClass(shown)}`}>
          <EditableText
            as="p"
            siteKey="dzw_eyebrow"
            fallback="Device-Free & Scale-to-Zero"
            className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-violet"
          />
          <EditableText
            as="h2"
            siteKey="dzw_title"
            fallback="スマホで動く、モンスターGPU。"
            className="text-3xl font-bold tracking-tight sm:text-4xl"
          />
          <EditableText
            as="p"
            siteKey="dzw_subtitle"
            fallback="端末は選ばない。そして、使っていない時間の費用は1円もかからない。"
            className="mx-auto mt-4 max-w-xl text-muted"
          />
        </div>

        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className={`flex justify-center py-6 ${revealClass(shown)}`}>
            <PhoneMock />
          </div>

          <div className={`space-y-4 ${revealClass(shown)}`} style={{ transitionDelay: "120ms" }}>
            <EditableText
              as="h3"
              siteKey="dzw_meter_title"
              fallback="待機費用 0円 — リアルタイム比較"
              className="text-sm font-bold text-foreground"
            />
            <RentalMeter running={shown} />
            <UllMeter />
            <p className="text-xs leading-relaxed text-muted">
              <EditableText
                siteKey="dzw_meter_caption"
                fallback="レンタルGPUは「考えている時間」も課金対象。ULL は生成した瞬間だけ、秒単位で課金します。"
              />
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
