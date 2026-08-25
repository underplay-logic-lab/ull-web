"use client";

import { useState } from "react";
import { Wrench } from "lucide-react";
import { CreditsBadge } from "@/components/CreditsBadge";
import { WanAnimateTab } from "@/components/studio/WanAnimateTab";
import { CustomWorkflowsTab } from "@/components/studio/CustomWorkflowsTab";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { EditableText } from "@/components/EditableText";

type StudioTab = "wan-animate" | "image" | "custom";

const STUDIO_TABS: { id: StudioTab; label: string }[] = [
  { id: "wan-animate", label: "Wan Animate 2" },
  { id: "image", label: "画像生成" },
  { id: "custom", label: "特化ワークフロー" },
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
    <section id="studio" data-source-file="src/components/Studio.tsx" className="relative py-24 sm:py-32">
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-40" />

      <div className="relative mx-auto max-w-5xl px-6">
        <div className="mb-16 text-center">
          <EditableText
            as="p"
            siteKey="studio_eyebrow"
            fallback="Studio"
            className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-pink"
          />
          <EditableText
            as="h2"
            siteKey="studio_title"
            fallback="AI Generation Studio"
            className="text-3xl font-bold tracking-tight sm:text-4xl"
          />
          <p className="mx-auto mt-4 max-w-xl text-muted">
            {activeTab === "wan-animate" ? (
              <EditableText
                siteKey="studio_desc_wan_animate"
                fallback="キャラクター画像とモーションを指定するだけ。Wan Animate 2 が高品質なアニメーション動画を生成します。"
              />
            ) : activeTab === "custom" ? (
              <EditableText
                siteKey="studio_desc_custom"
                fallback="管理者が登録した専用ワークフローを選択し、必要な入力を指定するだけで実行できます。"
              />
            ) : (
              <EditableText
                siteKey="studio_desc_maintenance"
                fallback="画像生成機能は現在メンテナンス中です。次期アップデートをお待ちください。"
              />
            )}
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
          </div>
        </div>

        {activeTab === "wan-animate" ? (
          <WanAnimateTab />
        ) : activeTab === "custom" ? (
          <CustomWorkflowsTab />
        ) : (
          <ImageGenMaintenancePlaceholder />
        )}
      </div>
    </section>
  );
}
