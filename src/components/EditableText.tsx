"use client";

import { useLayoutEffect, useRef, type FocusEvent, type FormEvent, type KeyboardEvent } from "react";
import { useSiteContentEditor } from "@/components/SiteContentEditorProvider";

type EditableTag = "span" | "p" | "h1" | "h2" | "div";

type EditableTextProps = {
  // site_contents.key this text is bound to.
  siteKey: string;
  // Shown until the DB value loads, and forever if it never does.
  fallback: string;
  as?: EditableTag;
  className?: string;
};

// Renders plain text bound to site_contents everywhere; when the admin's
// inline Visual Editor is ON (see SiteContentEditorProvider/AdminEditBar)
// it becomes contentEditable, tracking keystrokes into the shared draft
// state instead of writing to the DB directly — publishing happens once,
// in bulk, from the "💾 変更を本番公開" bar.
export function EditableText({ siteKey, fallback, as = "span", className }: EditableTextProps) {
  const { editMode, publishing, getValue, setDraft } = useSiteContentEditor();
  const value = getValue(siteKey, fallback);
  const Tag = as;

  const elRef = useRef<HTMLElement | null>(null);
  // Latest typed text, updated silently on every keystroke (no setState, so
  // no re-render). Only committed to the shared draft state on blur — see
  // handleBlur. Keeping the element uncontrolled while it's focused is what
  // stops React from re-writing the DOM's text node mid-keystroke, which is
  // what threw the caret to the start and reversed the typed characters.
  const draftRef = useRef(value);

  // Pushes an externally-changed value (initial load, discard, publish)
  // into the DOM — but never while the user is actively editing it.
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    draftRef.current = value;
    if (document.activeElement === el) return;
    if (el.textContent !== value) el.textContent = value;
  }, [value]);

  if (!editMode) {
    return <Tag className={className}>{value}</Tag>;
  }

  const handleInput = (e: FormEvent<HTMLElement>) => {
    draftRef.current = e.currentTarget.textContent ?? "";
  };

  const handleBlur = (_e: FocusEvent<HTMLElement>) => {
    setDraft(siteKey, draftRef.current);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Keep these single-line — contentEditable's default Enter behavior
    // inserts <div>/<br> that a plain TEXT column can't round-trip cleanly.
    if (e.key === "Enter") e.preventDefault();
  };

  return (
    <Tag
      ref={(node: HTMLElement | null) => {
        elRef.current = node;
      }}
      className={`${className ?? ""} cursor-text rounded border border-dashed border-transparent transition-colors hover:border-neon-pink/60 hover:bg-neon-pink/5 focus:border-neon-pink focus:bg-neon-pink/5 focus:outline-none`}
      contentEditable={!publishing}
      suppressContentEditableWarning
      onInput={handleInput}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onClick={(e) => e.preventDefault()}
    />
  );
}
