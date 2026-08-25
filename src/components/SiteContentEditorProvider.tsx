"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { useSiteContents } from "@/hooks/useSiteContents";
import { getSiteContent } from "@/lib/siteContents";

type ToastKind = "success" | "error";
// Optional clickable action on a toast — used by LiveInspector's "💻 VS
// Codeで◯◯を開きます" toast so a blocked/missed automatic vscode:// navigation
// can be retried by clicking the toast itself.
type ToastAction = { label: string; url: string };
type EditorToast = { id: number; kind: ToastKind; message: string; action?: ToastAction };

type SiteContentEditorContextValue = {
  isAdmin: boolean;
  editMode: boolean;
  setEditMode: (value: boolean) => void;
  getValue: (key: string, fallback: string) => string;
  setDraft: (key: string, value: string) => void;
  hasUnsavedChanges: boolean;
  // Human-readable, deduped categories of what's pending — shown in
  // AdminEditBar's unsaved-changes bar (e.g. "セクションの並び順", "文言の変更").
  changeSummary: string[];
  discardChanges: () => void;
  publishChanges: () => Promise<void>;
  publishing: boolean;
  toasts: EditorToast[];
  dismissToast: (id: number) => void;
  pushToast: (kind: ToastKind, message: string, action?: ToastAction) => void;
};

// Categorizes a pending site_contents key for the unsaved-changes summary —
// special-cased keys first, then a suffix heuristic for the generic
// EditableLink (*_href) / EditableMedia (*_url) key-naming convention.
function categorizeDraftKey(key: string): string {
  if (key === "page_sections_order") return "セクションの並び順";
  if (key.endsWith("_href")) return "リンク先の変更";
  if (key.endsWith("_url")) return "メディアの変更";
  return "文言の変更";
}

const noop = () => {};

// Fallback used when EditableText/AdminEditBar somehow render outside the
// provider (e.g. a future isolated test) — read-only, never throws.
const READ_ONLY_CONTEXT: SiteContentEditorContextValue = {
  isAdmin: false,
  editMode: false,
  setEditMode: noop,
  getValue: (_key, fallback) => fallback,
  setDraft: noop,
  hasUnsavedChanges: false,
  changeSummary: [],
  discardChanges: noop,
  publishChanges: async () => {},
  publishing: false,
  toasts: [],
  dismissToast: noop,
  pushToast: noop,
};

const SiteContentEditorContext = createContext<SiteContentEditorContextValue>(READ_ONLY_CONTEXT);

export function useSiteContentEditor(): SiteContentEditorContextValue {
  return useContext(SiteContentEditorContext);
}

export function SiteContentEditorProvider({ children }: { children: ReactNode }) {
  const { user } = useSupabaseUser();
  const { isAdmin } = useIsAdmin(user);
  const { contents, setContents } = useSiteContents();

  const [editModeState, setEditModeState] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [publishing, setPublishing] = useState(false);
  const [toasts, setToasts] = useState<EditorToast[]>([]);

  // Non-admins can never actually flip this on, even if setEditMode were
  // somehow called (e.g. stale closure after a session change).
  const editMode = isAdmin && editModeState;

  const setEditMode = (value: boolean) => {
    if (!isAdmin) return;
    setEditModeState(value);
  };

  const getValue = (key: string, fallback: string) =>
    drafts[key] ?? getSiteContent(contents, key, fallback);

  const setDraft = (key: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [key]: value }));
  };

  const hasUnsavedChanges = Object.keys(drafts).length > 0;
  const changeSummary = Array.from(new Set(Object.keys(drafts).map(categorizeDraftKey)));

  const discardChanges = () => setDrafts({});

  const dismissToast = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const pushToast = (kind: ToastKind, message: string, action?: ToastAction) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, message, action }]);
    // Action toasts (e.g. the VS Code "開く" retry) stay up longer than a
    // plain confirmation, since clicking them is the point.
    setTimeout(() => dismissToast(id), action ? 8000 : 3500);
  };

  const publishChanges = async () => {
    const updates = Object.entries(drafts).map(([key, value]) => ({ key, value }));
    if (updates.length === 0) return;

    setPublishing(true);
    try {
      const res = await fetch("/api/admin/site-contents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "公開に失敗しました。");

      setContents((prev) => ({ ...prev, ...Object.fromEntries(updates.map((u) => [u.key, u.value])) }));
      setDrafts({});
      pushToast("success", `✅ ${updates.length}件の変更を本番公開しました`);
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : "公開に失敗しました。");
    } finally {
      setPublishing(false);
    }
  };

  const value: SiteContentEditorContextValue = {
    isAdmin,
    editMode,
    setEditMode,
    getValue,
    setDraft,
    hasUnsavedChanges,
    changeSummary,
    discardChanges,
    publishChanges,
    publishing,
    toasts,
    dismissToast,
    pushToast,
  };

  return <SiteContentEditorContext.Provider value={value}>{children}</SiteContentEditorContext.Provider>;
}
