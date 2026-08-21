"use client";

import { useState } from "react";
import { Wrench } from "lucide-react";
import { CreditsBadge } from "@/components/CreditsBadge";
import { WanAnimateTab } from "@/components/studio/WanAnimateTab";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";

type StudioTab = "wan-animate" | "image";

const STUDIO_TABS: { id: StudioTab; label: string }[] = [
  { id: "wan-animate", label: "Wan Animate 2" },
  { id: "image", label: "画像生成" },
];

function ImageGenMaintenancePlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border-gradient bg-surface/40 px-6 py-20 text-center">
      <Wrench size={32} className="text-muted opacity-50" />
      <p className="text-sm font-medium text-foreground">画像生成機能は現在メンテナンス中です</p>
      <p className="max-w-md text-xs leading-relaxed text-muted">
        次世代エンジンへの切り替え作業を行っています。次期アップデートでの再開をお待ちください。
      </p>
    </div>
  );
}

export function Studio() {
  const { user } = useSupabaseUser();
  const [activeTab, setActiveTab] = useState<StudioTab>("wan-animate");

  return (
    <section id="studio" className="relative py-24 sm:py-32">
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-40" />

      <div className="relative mx-auto max-w-5xl px-6">
        <div className="mb-16 text-center">
          <p className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-pink">
            Studio
          </p>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            AI Generation Studio
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted">
            {activeTab === "wan-animate"
              ? "キャラクター画像とモーションを指定するだけ。Wan Animate 2 が高品質なアニメーション動画を生成します。"
              : "画像生成機能は現在メンテナンス中です。次期アップデートをお待ちください。"}
          </p>
          {user && (
            <div className="mt-5 flex justify-center">
              <CreditsBadge user={user} className="inline-flex" />
            </div>
          )}

          <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
            {STUDIO_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`rounded-full border px-4 py-1.5 text-xs font-mono font-medium transition-colors ${
                  activeTab === tab.id
                    ? "border-neon-pink/40 bg-neon-pink/10 text-neon-pink"
                    : "border-border bg-surface/40 text-muted hover:border-neon-violet/40 hover:text-foreground"
                }`}
              >
                {tab.label}
              </button>
            ))}
            <span className="flex cursor-not-allowed items-center gap-2 rounded-full border border-border bg-surface/40 px-4 py-1.5 text-xs font-mono text-muted opacity-70">
              特化ワークフロー
              <span className="rounded-full bg-border px-1.5 py-0.5 text-[10px] tracking-wide text-muted">
                Coming Soon
              </span>
            </span>
          </div>
        </div>

        {activeTab === "wan-animate" ? <WanAnimateTab /> : <ImageGenMaintenancePlaceholder />}
      </div>
    </section>
  );
}
