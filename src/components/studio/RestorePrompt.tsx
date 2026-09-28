"use client";

import { History, Loader2 } from "lucide-react";

// 「前回の続きを復元しますか？」（2026-09-28、ホスト指摘）。
// 素材づくりと LoRA Studio で同じ聞き方にする。片方だけ黙って復元すると「このサービスはリロードしても
// 消えない」と思い込み、もう片方でデータセットを失う事故につながる。復元するかはユーザーに選ばせる。
export function RestorePrompt({
  summary,
  savedAt,
  busy,
  onRestore,
  onDiscard,
}: {
  /** 何が残っているか（例: 「画像 52 枚・キャプション 52 件」）。 */
  summary: string;
  /** 最終保存の時刻（ms）。無ければ出さない。 */
  savedAt?: number | null;
  busy?: boolean;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  const when = savedAt ? new Date(savedAt) : null;
  const whenLabel = when
    ? `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
    : null;
  return (
    <div className="rounded-xl border border-neon-violet/40 bg-neon-violet/5 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-2">
          <History size={16} className="mt-0.5 shrink-0 text-neon-violet" />
          <div>
            <p className="text-sm font-semibold text-foreground">前回の続きを復元しますか？</p>
            <p className="mt-0.5 text-[11px] text-muted">
              この端末に {summary} が残っています{whenLabel ? `（最終保存 ${whenLabel}）` : ""}。
              復元しない場合は消去して、新しく始めます。
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onRestore}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            復元する
          </button>
          <button
            type="button"
            onClick={onDiscard}
            disabled={busy}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-50"
          >
            消去して新しく始める
          </button>
        </div>
      </div>
    </div>
  );
}
