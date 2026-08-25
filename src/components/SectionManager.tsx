"use client";

import { ArrowDown, ArrowUp, Eye, EyeOff } from "lucide-react";

type SectionManagerProps = {
  label: string;
  isFirst: boolean;
  isLast: boolean;
  visible: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleVisible: () => void;
};

// Per-section control bar rendered by HomeSections when edit mode is ON —
// reorders and hides/shows homepage sections. Mutates the shared draft for
// the "page_sections_order" site_contents key; published later from
// AdminEditBar's bar like every other edit.
export function SectionManager({
  label,
  isFirst,
  isLast,
  visible,
  onMoveUp,
  onMoveDown,
  onToggleVisible,
}: SectionManagerProps) {
  return (
    <div className="absolute right-4 top-4 z-30 flex items-center gap-1 rounded-full border border-neon-violet/40 bg-surface/95 px-2 py-1 font-mono text-[10px] text-muted shadow-lg backdrop-blur-sm">
      <span className="px-1.5 text-foreground">{label}</span>
      <button
        type="button"
        onClick={onMoveUp}
        disabled={isFirst}
        aria-label="上へ"
        className="rounded-full p-1 transition-colors hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
      >
        <ArrowUp size={12} />
      </button>
      <button
        type="button"
        onClick={onMoveDown}
        disabled={isLast}
        aria-label="下へ"
        className="rounded-full p-1 transition-colors hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
      >
        <ArrowDown size={12} />
      </button>
      <button
        type="button"
        onClick={onToggleVisible}
        aria-label={visible ? "非表示にする" : "表示する"}
        className={`rounded-full p-1 transition-colors hover:bg-surface-hover ${visible ? "text-foreground" : "text-red-400"}`}
      >
        {visible ? <Eye size={12} /> : <EyeOff size={12} />}
      </button>
    </div>
  );
}
