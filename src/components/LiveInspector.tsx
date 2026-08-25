"use client";

import { useEffect, useRef } from "react";
import { useSiteContentEditor } from "@/components/SiteContentEditorProvider";

const isDev = process.env.NODE_ENV === "development";

type EditorId = "cursor" | "vscode";

const EDITOR_LABEL: Record<EditorId, string> = {
  cursor: "Cursor",
  vscode: "VS Code",
};

// Which local editor Alt+クリック opens — configurable via
// NEXT_PUBLIC_LIVE_INSPECTOR_EDITOR ("cursor" | "vscode") for environments
// where the admin uses VS Code instead; defaults to Cursor since both tools
// register the same `{scheme}://file/<path>` URI handler (Cursor is a VS
// Code fork), so only the scheme name actually differs.
const EDITOR: EditorId = process.env.NEXT_PUBLIC_LIVE_INSPECTOR_EDITOR === "vscode" ? "vscode" : "cursor";

function buildEditorUrl(file: string): string {
  const root = document.body.dataset.projectRoot?.replace(/\\/g, "/");
  return root ? `${EDITOR}://file/${root}/${file}` : `${EDITOR}://file/${file}`;
}

// Alt+クリックで、クリックしたセクション/コンポーネントの元ファイルを
// ローカルエディタ（Cursor / VS Code、上記EDITOR参照）で開く（
// `data-source-file` を持つ最寄りの祖先要素を使う — layout.tsx の各
// section/header/footerに付与済み）。常時ではなく、開発環境中、または
// 管理者の編集モードON中のみ有効。
//
// - `.closest("[data-source-file]")` はクリックされた実際のDOMノード（ボタン
//   やテキストなど、コンポーネントのルートより深いネスト先）から祖先方向へ
//   遡って検索するため、子要素をクリックしても確実に最寄りのコンポーネント
//   まで到達する。
// - リスナーは capture フェーズ（第3引数 true）で登録しているため、対象要素
//   自身のonClick（リンクのナビゲーションや、編集モード中のcontentEditable
//   フォーカスなど）より先に発火し、preventDefault/stopPropagationでそれら
//   を確実に打ち消してからエディタのURIスキームへ遷移する。
export function LiveInspector() {
  const { editMode, pushToast } = useSiteContentEditor();
  const active = isDev || editMode;

  // pushToast's identity changes on every SiteContentEditorProvider render
  // (e.g. every keystroke while editing text elsewhere) — reading it via a
  // ref lets the click listener stay mounted for the whole `active` session
  // instead of being torn down/re-added on each of those renders.
  const pushToastRef = useRef(pushToast);
  useEffect(() => {
    pushToastRef.current = pushToast;
  });

  useEffect(() => {
    if (!active) return;

    const handleClick = (e: MouseEvent) => {
      if (!e.altKey) return;

      const target = e.target as Element | null;
      const el = target?.closest<HTMLElement>("[data-source-file]");
      const file = el?.dataset.sourceFile;
      if (!file) return;

      e.preventDefault();
      e.stopPropagation();

      const editorUrl = buildEditorUrl(file);

      pushToastRef.current("success", `💻 ${EDITOR_LABEL[EDITOR]}で ${file} を開きます`, {
        label: `${EDITOR_LABEL[EDITOR]}で開く`,
        url: editorUrl,
      });

      window.location.href = editorUrl;
    };

    window.addEventListener("click", handleClick, true);
    return () => window.removeEventListener("click", handleClick, true);
  }, [active]);

  if (!active) return null;

  return (
    <div className="pointer-events-none fixed bottom-6 left-6 z-[90] flex items-center gap-1.5 rounded-full border border-neon-violet/40 bg-surface/90 px-3 py-1.5 font-mono text-[10px] text-muted shadow-lg backdrop-blur-sm">
      🧭 Alt+クリックで{EDITOR_LABEL[EDITOR]}を開く
    </div>
  );
}
