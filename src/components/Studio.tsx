"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Wrench } from "lucide-react";
import { CreditsBadge } from "@/components/CreditsBadge";
import { CustomWorkflowsTab } from "@/components/studio/CustomWorkflowsTab";
import { DirectorStudioTab } from "@/components/studio/DirectorStudioTab";
import { PhotoDirectorTab } from "@/components/studio/PhotoDirectorTab";
import { LoraStudioTab } from "@/components/studio/LoraStudioTab";
import { MultiAngleStudioTab } from "@/components/studio/MultiAngleStudioTab";
import { UpscaleStudioTab } from "@/components/studio/UpscaleStudioTab";
import { UpscaleVideoStudioTab } from "@/components/studio/UpscaleVideoStudioTab";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { claimStudioStorage } from "@/lib/studioStorageOwner";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { EditableText } from "@/components/EditableText";
import { STUDIO_TAB_EVENT, type StudioHandoffTab } from "@/lib/studioHandoff";
import { DatasetBuilderTab } from "@/components/studio/DatasetBuilderTab";
import { HelpNoteToggleAll } from "@/components/studio/HelpNote";
import { TutorialVideoButton } from "@/components/studio/TutorialVideoButton";
import { ParallelDownloadIndicator } from "@/components/studio/ParallelDownloadIndicator";

// 2026-09-09: Wan Animate 2 / Cinematic Video タブは廃止。汎用の動画・特殊要望は
// すべて「特化ワークフロー」で対応する方針（管理者がワークフローを登録）。
// 2026-09-12: 動画超解像（v1・最小スコープ）を専用タブとして追加。
type StudioTab = "image" | "custom" | "lora" | "angle" | "dataset" | "upscale" | "upscale_video" | "director" | "photo";

// 2026-09-24: 特化ワークフローは admin だけに表示し、末尾へ寄せた（ホスト判断:
// ComfyUI で作り込んだワークフローの展開先として用意したが、まだ効果的な
// 使い方に至っていない。一般ユーザーには出さず、admin の実験用に残す）。
const STUDIO_TABS: { id: StudioTab; label: string; adminOnly?: boolean }[] = [
  // "image" (画像生成) is temporarily hidden from navigation — the engine
  // behind it is mid-swap and ImageGenMaintenancePlaceholder is the only
  // thing it currently renders. Re-add here once the new engine ships.
  // 2026-09-24 ホスト: メインは Cinematic Director（先頭に置き、開いたときに最初に出す）。
  // 2026-09-25 ホスト指定の並び: Director → 動画超解像 → 画像超解像 → マルチアングル → LoRA。
  { id: "director", label: "🎥 Cinematic Director" },
  // 2026-10-06: 同じ土台で静止画（ホスト「新しいコーナーで良い」）。Director の隣に置く。
  { id: "photo", label: "📸 Photo Director" },
  { id: "upscale_video", label: "🎬 4K動画超解像" },
  { id: "upscale", label: "✨ 4K/8K超解像" },
  { id: "angle", label: "🎭 マルチアングル" },
  // 2026-09-27: 1 枚の画像から LoRA 用の素材一式を作るタブ（角度だけ欲しい需要とは分ける、ホスト判断）。
  { id: "dataset", label: "🧩 素材づくり" },
  { id: "lora", label: "🎨 LoRA Studio" },
  { id: "custom", label: "🔧 特化ワークフロー（admin）", adminOnly: true },
];
// Studio を開いたときに最初に表示するタブ。
const DEFAULT_TAB: StudioTab = "director";

// 専用ページ /studio（2026-10-01、ホスト指摘「トップの 1 セクションだと、下へスクロールしすぎると別の内容が出る」）では
// 今のタブを ?tab= に載せる。使い方の案内・紹介動画からタブ単位でリンクでき、再読み込みしても同じタブが開く。
// 切り替えは replaceState（履歴を積まない — タブごとに「戻る」が溜まると、ページを離れるのに何度も戻ることになる）。
const STUDIO_PATH = "/studio";
const isStudioTab = (v: string | null): v is StudioTab => STUDIO_TABS.some((t) => t.id === v);
function tabFromUrl(): StudioTab | null {
  if (typeof window === "undefined" || window.location.pathname !== STUDIO_PATH) return null;
  const v = new URLSearchParams(window.location.search).get("tab");
  return isStudioTab(v) ? v : null;
}
function writeTabToUrl(tab: StudioTab) {
  if (window.location.pathname !== STUDIO_PATH) return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("tab") === tab) return;
  url.searchParams.set("tab", tab);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

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
  const { user, loading: userLoading } = useSupabaseUser();
  // 別アカウントに切り替わっていたら、前のアカウントの作業状態（実行中ジョブ等）を退避し、今のアカウントの
  // 退避分を戻してからタブを出す（入れ替えたら読み直す）。タブはマウント時に保存分を読むので、判定が済むまで描画しない。
  const [activeTab, setActiveTab] = useState<StudioTab>(DEFAULT_TAB);
  // 一度でも lora を開いたか（理由は goTab の上のコメント）。URL のタブ反映でも立てるのでここで宣言する。
  const [loraMounted, setLoraMounted] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  // URL のタブを開いたときは、タブ切り替え時の「タブの頭へスクロール」をしない（開いた直後に勝手に動くため）。
  const skipTabScrollRef = useRef(false);
  useEffect(() => {
    if (userLoading) return;
    let cancelled = false;
    (async () => {
      const wiped = user ? await claimStudioStorage(user.id) : false;
      if (cancelled) return;
      if (wiped) {
        window.location.reload();
        return;
      }
      // URL のタブはここで反映する（サーバー描画と食い違わないよう、マウント後に読む）。
      const fromUrl = tabFromUrl();
      if (fromUrl && fromUrl !== DEFAULT_TAB) {
        skipTabScrollRef.current = true;
        if (fromUrl === "lora") setLoraMounted(true);
        setActiveTab(fromUrl);
      }
      setStorageReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, userLoading]);
  const { isAdmin } = useIsAdmin(user);
  const visibleTabs = STUDIO_TABS.filter((tab) => !tab.adminOnly || isAdmin);

  // LoRA Studio だけは一度開いたら**アンマウントしない**（2026-09-21）。
  // このタブはユーザーがローカルから取り込んだ File と object URL を
  // コンポーネントの state に持っており、他の state と違って復元できない。
  // 条件付きレンダリングのままだと、診断パネルの「マルチアングルで足りない
  // 構図を作る」を押した瞬間に 165 枚のデータセットが消えるという、自分で
  // 案内した導線が自分で成果物を壊す状態になっていた。
  // 他タブは失っても困る state が無いので従来どおり。
  // 一度でも lora を開いたか。タブ遷移は必ず goTab を通す。
  const goTab = useCallback(
    (id: StudioTab) => {
      // admin 限定タブは非 admin からの遷移（LoRA 完了画面の旧導線等）でも開かない。
      if (STUDIO_TABS.find((t) => t.id === id)?.adminOnly && !isAdmin) return;
      if (id === "lora") setLoraMounted(true);
      setActiveTab(id);
      writeTabToUrl(id);
    },
    [isAdmin],
  );

  // 他タブからの「この結果を超解像へ」導線（src/lib/studioHandoff.ts）。
  useEffect(() => {
    const onSwitch = (e: Event) => {
      const tab = (e as CustomEvent<{ tab: StudioHandoffTab }>).detail?.tab;
      if (tab === "upscale" || tab === "upscale_video" || tab === "lora" || tab === "angle" || tab === "dataset" || tab === "director")
        goTab(tab);
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
    if (skipTabScrollRef.current) {
      skipTabScrollRef.current = false;
      return;
    }
    tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [shownTab]);

  return (
    <section id="studio" data-source-file="src/components/Studio.tsx" className="relative py-24 sm:py-32">
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-40" />
      <ParallelDownloadIndicator />

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
            fallback="AI動画・画像生成スタジオ"
            className="text-3xl font-bold tracking-tight sm:text-4xl"
          />
          <EditableText
            as="p"
            siteKey="studio_tagline"
            fallback="あなたのこだわりで、育っていくスタジオ。"
            className="mt-3 text-sm font-medium text-gradient"
          />
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

          {/* タブごとの説明はタブの下に（2026-09-30 ホスト指摘: 切り替えるとタブの頭へスクロールするので、上にあると見えない）。 */}
          <p className="mx-auto mt-5 max-w-xl text-muted">
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
            ) : activeTab === "dataset" ? (
              <EditableText
                siteKey="studio_desc_dataset"
                fallback="キャラクター画像を1枚入れて、ポーズ・場面・構図を選ぶだけ。同じキャラのまま枚数ぶんの学習素材を作り、そのまま LoRA Studio へ送れます。"
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
                fallback="参照画像と、やりたいことの要点を書くだけ。AI が台本にして、最大60秒の動画を生成します。場面ごとに組み立てたり、文章を直接書いたりもできます。"
              />
            ) : activeTab === "photo" ? (
              <EditableText
                siteKey="studio_desc_photo"
                fallback="人物の写真と、持ち物・場所の写真、どんな 1 枚にしたいかを書くだけ。その人のまま、狙いどおりの写真を作ります。"
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
          {/* MiniMax H3 Community License §IV.2「商用製品の UI に 'MiniMax H3' を目立つように表示」（2026-10-05 ホスト判断:
              会員限定にせず常に出す・CLAUDE.md §2 の例外）。Director の土台 10Eros も MiniMax H3 の派生なので対象。 */}
          {activeTab === "director" && (
            <p className="mt-2 text-[11px] font-medium tracking-wide text-foreground/80">
              Cinematic Director — Powered by MiniMax H3
            </p>
          )}
          {/* Photo Director も同じ MiniMax H3（10Eros）で作るので同じ表示義務（2026-10-06）。 */}
          {activeTab === "photo" && (
            <p className="mt-2 text-[11px] font-medium tracking-wide text-foreground/80">
              Photo Director — Powered by MiniMax H3
            </p>
          )}
          <HelpNoteToggleAll className="mt-2" />
          <TutorialVideoButton tab={shownTab} className="mt-1" />
        </div>

        {storageReady && (
          <>
        {/* 一度開いた LoRA Studio は hidden で残す（state を捨てないため）。 */}
        {loraMounted && (
          <div className={shownTab === "lora" ? undefined : "hidden"}>
            <LoraStudioTab
              onOpenMultiAngle={() => goTab("angle")}
              onOpenUpscale={() => goTab("upscale")}
            />
          </div>
        )}

        {shownTab === "custom" ? (
          <CustomWorkflowsTab />
        ) : shownTab === "angle" ? (
          <MultiAngleStudioTab />
        ) : shownTab === "dataset" ? (
          <DatasetBuilderTab />
        ) : shownTab === "upscale" ? (
          <UpscaleStudioTab />
        ) : shownTab === "upscale_video" ? (
          <UpscaleVideoStudioTab />
        ) : shownTab === "director" ? (
          <DirectorStudioTab />
        ) : shownTab === "photo" ? (
          <PhotoDirectorTab />
        ) : shownTab === "lora" ? null : (
          <ImageGenMaintenancePlaceholder />
        )}
          </>
        )}
      </div>
    </section>
  );
}
