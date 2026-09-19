"use client";

import { useEffect, useRef } from "react";
import { useSiteContentEditor } from "@/components/SiteContentEditorProvider";

// ホームページビルダー的な「実際の見た目のまま編集し、アップロード（= git
// push）する」ローカル専用ツール（2026-09-19導入）。DB連携のEditableText
// とは別レーン——site_contents に登録されていない、ソースファイルに直接
// 書かれた静的な文言を対象にする。
//
// 仕組み: 編集モードON中、静的テキストの葉要素（子要素を持たない・
// data-source-file の子孫）をクリックするとその場でcontentEditableになり、
// blurで /api/dev/source-edit に {file, oldText, newText} を送る。サーバー
// 側は「oldTextがそのファイル内にちょうど1箇所だけ」の時だけ書き換える
// （Edit toolのold_string一意性チェックと同じ考え方）——本番(Vercel)では
// このAPI自体が常に404を返すので、開発環境でしか機能しない。
//
// Alt+クリック（LiveInspector）とは住み分け: Alt+クリックは常にファイルを
// 開く（このコンポーネントは早期returnしてLiveInspector側の処理に委ねる）。
// 修飾キー無しのクリックだけをこのコンポーネントが処理する。
//
// data-cms-managed を持つ要素（EditableText/EditableLink配下）は対象外
// ——DB連携の編集ロジックと衝突させないため。

const EXCLUDED_ANCESTOR_SELECTOR = "a, button, input, textarea, select, [contenteditable], [data-cms-managed]";

function isEditableLeaf(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  // アイコン・箇条書きのドットのような「テキストを持たない装飾用の子要素」
  // は許容する（例: <li><span className="dot" />{service}</li> — bulletは
  // textContentに何も寄与しないので oldText/newText の一意性判定には影響
  // しない）。テキストを持つ子要素が混ざる場合だけ対象外にする——別々の
  // 意味を持つテキストが混在している可能性が高く、まとめて編集すると
  // 壊れるリスクがあるため。
  const hasTextBearingChildElement = Array.from(el.children).some((child) => child.textContent?.trim());
  if (hasTextBearingChildElement) return false;
  if (!el.textContent?.trim()) return false;
  if (el.closest(EXCLUDED_ANCESTOR_SELECTOR)) return false;
  if (!el.closest("[data-source-file]")) return false;
  return true;
}

export function SourceTextEditor() {
  const { editMode, pushToast } = useSiteContentEditor();
  const active = editMode; // LiveInspectorと違いisDevだけでは有効化しない —
  // 通常クリックを横取りする以上、明示的に編集モードONの時だけにする。

  const pushToastRef = useRef(pushToast);
  useEffect(() => {
    pushToastRef.current = pushToast;
  });

  // クリックしてcontentEditableにした瞬間の元テキストを、要素ごとに保持。
  const originalTextRef = useRef(new WeakMap<HTMLElement, string>());

  useEffect(() => {
    if (!active) return;

    const submitEdit = async (el: HTMLElement, file: string, oldText: string, newText: string) => {
      try {
        const res = await fetch("/api/dev/source-edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file, oldText, newText }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          el.textContent = oldText; // サーバーが拒否したらDOMも元に戻す
          pushToastRef.current("error", data?.error || "編集の保存に失敗しました。");
          return;
        }
        pushToastRef.current("success", `✅ ${file} を更新しました`);
      } catch (err) {
        el.textContent = oldText;
        pushToastRef.current("error", err instanceof Error ? err.message : "編集の保存に失敗しました。");
      }
    };

    const startEditing = (el: HTMLElement) => {
      originalTextRef.current.set(el, el.textContent ?? "");
      el.setAttribute("contenteditable", "true");
      el.dataset.sourceEditing = "true";
      el.classList.add(
        "outline",
        "outline-2",
        "outline-neon-pink/70",
        "outline-offset-2",
        "rounded",
      );
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    };

    const stopEditing = (el: HTMLElement, commit: boolean) => {
      const original = originalTextRef.current.get(el) ?? "";
      el.removeAttribute("contenteditable");
      delete el.dataset.sourceEditing;
      el.classList.remove("outline", "outline-2", "outline-neon-pink/70", "outline-offset-2", "rounded");

      if (!commit) {
        el.textContent = original;
        return;
      }
      const newText = el.textContent ?? "";
      if (newText === original || !newText.trim()) {
        el.textContent = original;
        return;
      }
      const sourceFile = el.closest<HTMLElement>("[data-source-file]")?.dataset.sourceFile;
      if (!sourceFile) {
        el.textContent = original;
        return;
      }
      void submitEdit(el, sourceFile, original, newText);
    };

    const handleClick = (e: MouseEvent) => {
      if (e.altKey) return; // LiveInspectorのAlt+クリックに委ねる

      const target = e.target as Element | null;
      if (!target) return;

      // 編集中の要素自身への再クリックは通常のテキスト選択操作として許可。
      if (target instanceof HTMLElement && target.dataset.sourceEditing === "true") return;

      if (!isEditableLeaf(target)) return;

      e.preventDefault();
      e.stopPropagation();
      startEditing(target);
    };

    // blur/focusは bubbling しないが capture フェーズでは window まで届く。
    const handleBlur = (e: FocusEvent) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || el.dataset.sourceEditing !== "true") return;
      stopEditing(el, true);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || el.dataset.sourceEditing !== "true") return;
      if (e.key === "Enter") {
        // 複数行化は対象外（EditableTextと同じ制約）— Alt+クリックで
        // エディタを開いて手動編集してもらう。
        e.preventDefault();
        el.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        stopEditing(el, false);
        el.blur();
      }
    };

    window.addEventListener("click", handleClick, true);
    window.addEventListener("blur", handleBlur, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("click", handleClick, true);
      window.removeEventListener("blur", handleBlur, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [active]);

  if (!active) return null;

  return (
    <>
      {/* 編集対象になり得る要素へのホバー可視化。isEditableLeafの判定はJS側
          にしかないので、CSSだけでは対象/対象外を区別できない——代わりに
          data-source-file配下・data-cms-managed/インタラクティブ要素を除く
          汎用ルールで近似する（誤検知は無害: クリックしなければ何も起きない）。 */}
      <style>{`
        [data-source-file] :is(p, span, h1, h2, h3, h4, li, td, dt, dd, blockquote, figcaption):not([data-cms-managed] *):not(a):not(button):hover {
          outline: 1px dashed rgba(255, 0, 153, 0.5);
          outline-offset: 2px;
          cursor: text;
          border-radius: 2px;
        }
      `}</style>
      <div className="pointer-events-none fixed bottom-6 left-[15.5rem] z-[90] flex items-center gap-1.5 rounded-full border border-neon-pink/40 bg-surface/90 px-3 py-1.5 font-mono text-[10px] text-muted shadow-lg backdrop-blur-sm">
        ✏️ クリックで文言を直接編集（保存でソースファイルへ書き込み）
      </div>
    </>
  );
}
