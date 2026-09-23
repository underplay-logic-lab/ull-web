"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Wrench } from "lucide-react";
import { CreditsBadge } from "@/components/CreditsBadge";
import { CustomWorkflowsTab } from "@/components/studio/CustomWorkflowsTab";
import { DirectorStudioTab } from "@/components/studio/DirectorStudioTab";
import { LoraStudioTab } from "@/components/studio/LoraStudioTab";
import { MultiAngleStudioTab } from "@/components/studio/MultiAngleStudioTab";
import { UpscaleStudioTab } from "@/components/studio/UpscaleStudioTab";
import { UpscaleVideoStudioTab } from "@/components/studio/UpscaleVideoStudioTab";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { EditableText } from "@/components/EditableText";
import { STUDIO_TAB_EVENT, type StudioHandoffTab } from "@/lib/studioHandoff";

// 2026-09-09: Wan Animate 2 / Cinematic Video タブは廃止。汎用の動画・特殊要望は
// すべて「特化ワークフロー」で対応する方針（管理者がワークフローを登録）。
// 2026-09-12: 動画超解像（v1・最小スコープ）を専用タブとして追加。
type StudioTab = "image" | "custom" | "lora" | "angle" | "upscale" | "upscale_video" | "director";

// 2026-09-24: 特化ワークフローは admin だけに表示し、末尾へ寄せた（ホスト判断:
// ComfyUI で作り込んだワークフローの展開先として用意したが、まだ効果的な
// 使い方に至っていない。一般ユーザーには出さず、admin の実験用に残す）。
const STUDIO_TABS: { id: StudioTab; label: string; adminOnly?: boolean }[] = [
  // "image" (画像生成) is temporarily hidden from navigation — the engine
  // behind it is mid-swap and ImageGenMaintenancePlaceholder is the only
  // thing it currently renders. Re-add here once the new engine ships.
  // 2026-09-24 ホスト: メインは Cinematic Director（先頭に置き、開いたときに最初に出す）。
  { id: "director", label: "🎥 Cinematic Director" },
  { id: "angle", label: "🎭 マルチアングル" },
  { id: "upscale", label: "✨ 4K/8K超解像" },
  { id: "upscale_video", label: "🎬 4K動画超解像" },
  { id: "lora", label: "🎨 LoRA Studio" },
  { id: "custom", label: "🔧 特化ワークフロー（admin）", adminOnly: true },
];
// Studio を開いたときに最初に表示するタブ。
const DEFAULT_TAB: StudioTab = "director";

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
  const { isAdmin } = useIsAdmin(user);
  const [activeTab, setActiveTab] = useState<StudioTab>(DEFAULT_TAB);
  const visibleTabs = STUDIO_TABS.filter((tab) => !tab.adminOnly || isAdmin);

  // LoRA Studio だけは一度開いたら**アンマウントしない**（2026-09-21）。
  // このタブはユーザーがローカルから取り込んだ File と object URL を
  // コンポーネントの state に持っており、他の state と違って復元できない。
  // 条件付きレンダリングのままだと、診断パネルの「マルチアングルで足りない
  // 構図を作る」を押した瞬間に 165 枚のデータセットが消えるという、自分で
  // 案内した導線が自分で成果物を壊す状態になっていた。
  // 他タブは失っても困る state が無いので従来どおり。
  // 一度でも lora を開いたか。タブ遷移は必ず goTab を通す。
  const [loraMounted, setLoraMounted] = useState(false);
  const goTab = useCallback(
    (id: StudioTab) => {
      // admin 限定タブは非 admin からの遷移（LoRA 完了画面の旧導線等）でも開かない。
      if (STUDIO_TABS.find((t) => t.id === id)?.adminOnly && !isAdmin) return;
      if (id === "lora") setLoraMounted(true);
      setActiveTab(id);
    },
    [isAdmin],
  );

  // 他タブからの「この結果を超解像へ」導線（src/lib/studioHandoff.ts）。
  useEffect(() => {
    const onSwitch = (e: Event) => {
      const tab = (e as CustomEvent<{ tab: StudioHandoffTab }>).detail?.tab;
      if (tab === "upscale" || tab === "upscale_video") goTab(tab);
    };
    window.addEventListener(STUDIO_TAB_EVENT, onSwitch);
    return () => window.removeEventListener(STUDIO_TAB_EVENT, onSwitch);
  }, [goTab]);

  // admin 判定が false のまま admin 限定タブに居る状態（ログアウト等）は既定へ戻す。
  const activeIsHidden = Boolean(STUDIO_TABS.find((t) => t.id === activeTab)?.adminOnly) && !isAdmin;
  const shownTab: StudioTab = activeIsHidden ? DEFAULT_TAB : activeTab;

  // タブを切り替えると中身の高さが大きく変わるため、スクロール位置を据え置くと
  // フッター（問い合わせ）まで飛んだように見える。毎回タブの頭へ戻す。
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [shownTab]);

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
            {activeTab === "custom" ? (
              <EditableText
                siteKey="studio_desc_custom"
                fallback="管理者が登録した専用ワークフローを選択し、必要な入力を指定するだけで実行できます。"
              />
            ) : activeTab === "angle" ? (
              <EditableText
                siteKey="studio_desc_angle"
                fallback="キャラクター画像を1枚アップロードするだけ。向き・アングル・距離を選んで、複数の構図を一括生成・プレビューできます。"
              />
            ) : activeTab === "upscale" ? (
              <EditableText
                siteKey="studio_desc_upscale"
                fallback="画像を1枚アップロードするだけ。ローカルでは不可能なフル精度エンジンで、キャラの同一性を保ったまま解像感を引き上げます。"
              />
            ) : activeTab === "upscale_video" ? (
              <EditableText
                siteKey="studio_desc_upscale_video"
                fallback="短い動画を1本アップロードするだけ。同じフル精度エンジンで、動きの一貫性を保ったまま解像感を引き上げます（最小構成の提供です）。"
              />
            ) : activeTab === "director" ? (
              <EditableText
                siteKey="studio_desc_director"
                fallback="参照画像とカメラワーク・シーンを並べるだけ。AIが1本の連続したシネマティック映像に自動合成し、最大60秒の動画を生成します。"
              />
            ) : activeTab === "lora" ? (
              <EditableText
                siteKey="studio_desc_lora"
                fallback="キャラクター画像をアップロードするだけ。独自の超高速パイプラインが自動でタグ付けし、深度最適化エンジンが専用 LoRA を焼き上げます。"
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

          <div ref={tabsRef} className="mt-8 flex flex-wrap items-center justify-center gap-2 scroll-mt-20">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => goTab(tab.id)}
                className={`rounded-full border px-4 py-1.5 text-xs font-mono font-medium transition-colors ${
                  tab.adminOnly ? "ml-3 opacity-70 " : ""
                }${
                  shownTab === tab.id
                    ? "border-neon-pink/40 bg-neon-pink/10 text-neon-pink"
                    : "border-border bg-surface/40 text-muted hover:border-neon-violet/40 hover:text-foreground"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* 一度開いた LoRA Studio は hidden で残す（state を捨てないため）。 */}
        {loraMounted && (
          <div className={shownTab === "lora" ? undefined : "hidden"}>
            <LoraStudioTab
              onUseLora={() => goTab("custom")}
              onOpenMultiAngle={() => goTab("angle")}
              onOpenUpscale={() => goTab("upscale")}
            />
          </div>
        )}

        {shownTab === "custom" ? (
          <CustomWorkflowsTab />
        ) : shownTab === "angle" ? (
          <MultiAngleStudioTab />
        ) : shownTab === "upscale" ? (
          <UpscaleStudioTab />
        ) : shownTab === "upscale_video" ? (
          <UpscaleVideoStudioTab />
        ) : shownTab === "director" ? (
          <DirectorStudioTab />
        ) : shownTab === "lora" ? null : (
          <ImageGenMaintenancePlaceholder />
        )}
      </div>
    </section>
  );
}
