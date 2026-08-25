"use client";

import { useState, type ReactNode } from "react";
import { Link as LinkIcon, X } from "lucide-react";
import { useSiteContentEditor } from "@/components/SiteContentEditorProvider";

type EditableLinkProps = {
  // site_contents key holding the href (e.g. "hero_cta_primary_href").
  siteKey: string;
  fallback: string;
  className?: string;
  children: ReactNode;
};

// Wraps an <a> whose destination is admin-editable. Outside edit mode it's
// a plain link; in edit mode, clicking the link itself is suppressed (so
// admins don't accidentally navigate away) and a small "🔗 リンク編集"
// badge opens a popup to change the href — applied to the shared draft
// state, published later from AdminEditBar's bar like every other edit.
export function EditableLink({ siteKey, fallback, className, children }: EditableLinkProps) {
  const { editMode, getValue, setDraft } = useSiteContentEditor();
  const [popupOpen, setPopupOpen] = useState(false);
  const [draftUrl, setDraftUrl] = useState("");
  const href = getValue(siteKey, fallback);

  if (!editMode) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }

  const openPopup = () => {
    setDraftUrl(href);
    setPopupOpen(true);
  };

  const handleSave = () => {
    setDraft(siteKey, draftUrl.trim() || fallback);
    setPopupOpen(false);
  };

  return (
    <span className="relative inline-block">
      <a href={href} className={className} onClick={(e) => e.preventDefault()}>
        {children}
      </a>

      <button
        type="button"
        onClick={openPopup}
        aria-label="リンク編集"
        className="absolute -right-2 -top-2 z-10 flex items-center gap-1 rounded-full border border-neon-violet/50 bg-surface px-2 py-0.5 text-[10px] font-medium text-neon-violet shadow-md transition-colors hover:bg-neon-violet/10"
      >
        <LinkIcon size={10} />
        リンク編集
      </button>

      {popupOpen && (
        <div
          className="absolute left-1/2 top-full z-20 mt-2 w-72 -translate-x-1/2 rounded-xl border-gradient bg-surface p-4 text-left shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">リンク先URLを編集</span>
            <button
              type="button"
              onClick={() => setPopupOpen(false)}
              aria-label="閉じる"
              className="text-muted transition-colors hover:text-foreground"
            >
              <X size={14} />
            </button>
          </div>
          <input
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            placeholder="#studio または https://..."
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none transition-colors focus:border-neon-violet/50"
          />
          <button
            type="button"
            onClick={handleSave}
            className="mt-2 w-full rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            適用（下部バーで公開）
          </button>
        </div>
      )}
    </span>
  );
}
