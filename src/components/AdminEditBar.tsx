"use client";

import { CheckCircle2, RotateCcw, Save, Wrench, X, XCircle } from "lucide-react";
import { useSiteContentEditor } from "@/components/SiteContentEditorProvider";

export function AdminEditBar() {
  const {
    isAdmin,
    editMode,
    setEditMode,
    hasUnsavedChanges,
    changeSummary,
    discardChanges,
    publishChanges,
    publishing,
    toasts,
    dismissToast,
  } = useSiteContentEditor();

  // Renders nothing at all for non-admins (and while the admin check is
  // still resolving) — the entire inline-editor surface is invisible to
  // regular visitors, not just visually hidden.
  if (!isAdmin) return null;

  return (
    <>
      {hasUnsavedChanges && (
        <div className="fixed inset-x-0 top-16 z-[90] flex flex-wrap items-center justify-center gap-3 border-b border-amber-500/30 bg-amber-500/15 px-4 py-2.5 text-xs font-medium text-amber-200 backdrop-blur-sm">
          <span>
            ⚠️ 未保存の変更があります
            {changeSummary.length > 0 && (
              <span className="ml-1.5 font-normal text-amber-300/80">
                （変更内容: {changeSummary.join(" / ")}）
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={discardChanges}
            disabled={publishing}
            className="flex items-center gap-1 rounded-full border border-border bg-background/70 px-3 py-1 text-foreground transition-colors hover:border-neon-violet/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw size={12} />
            元に戻す
          </button>
          <button
            type="button"
            onClick={publishChanges}
            disabled={publishing}
            className="flex items-center gap-1 rounded-full bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-1 text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save size={12} />
            {publishing ? "公開中..." : "💾 変更を本番公開"}
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => setEditMode(!editMode)}
        aria-label={`編集モード ${editMode ? "ON" : "OFF"}`}
        // Icon-only + smaller hit area below sm: on a narrow phone viewport
        // this FAB's fixed bottom-right position lands directly over the
        // Studio tabs' full-width "生成" button whenever the user scrolls
        // it near the bottom of the screen — a wide pill with a text label
        // covers roughly the button's right third and swallows the tap.
        // Shrinking to a small circular icon button keeps that overlap to
        // a sliver instead of a third of the CTA's width.
        className={`fixed bottom-4 right-4 z-[90] flex items-center gap-2 rounded-full border p-3 font-mono text-xs font-semibold shadow-lg backdrop-blur-sm transition-colors sm:bottom-6 sm:right-6 sm:px-4 sm:py-2.5 ${
          editMode
            ? "border-neon-pink/50 bg-neon-pink/15 text-neon-pink"
            : "border-border bg-surface/90 text-muted hover:border-neon-violet/40 hover:text-foreground"
        }`}
      >
        <Wrench size={14} />
        <span className="hidden sm:inline">編集モード [{editMode ? "ON" : "OFF"}]</span>
      </button>

      <div className="fixed bottom-16 right-4 z-[90] flex w-56 flex-col gap-2 sm:bottom-20 sm:right-6 sm:w-72">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            onClick={
              toast.action
                ? () => {
                    // Explicit navigation on click, per spec — retries the
                    // vscode:// jump even if the automatic one (fired
                    // alongside this toast) was blocked or missed.
                    window.location.href = toast.action!.url;
                  }
                : undefined
            }
            className={`flex items-start gap-2 rounded-lg border bg-surface/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm ${
              toast.kind === "success" ? "border-neon-pink/40 text-foreground" : "border-red-500/40 text-red-400"
            } ${toast.action ? "cursor-pointer transition-colors hover:border-neon-pink/70" : ""}`}
          >
            {toast.kind === "success" ? (
              <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-neon-pink" />
            ) : (
              <XCircle size={14} className="mt-0.5 shrink-0 text-red-400" />
            )}
            <span className="flex-1">{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  window.location.href = toast.action!.url;
                }}
                className="shrink-0 rounded-full bg-neon-pink/15 px-2 py-0.5 font-medium text-neon-pink transition-colors hover:bg-neon-pink/25"
              >
                {toast.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                dismissToast(toast.id);
              }}
              aria-label="閉じる"
              className="text-muted transition-colors hover:text-foreground"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
