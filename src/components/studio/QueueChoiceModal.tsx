"use client";

import { createPortal } from "react-dom";
import { Flame, X } from "lucide-react";
import { formatWarmCountdown } from "@/hooks/useLocalWarmCountdown";

// scaledown_window=30 系（Multi-Angle / 超解像・超解像動画 / Cinematic
// Director）で共通の「実行中に生成ボタンを押した時」の選択モーダル。
// CLAUDE.md §6「実行中でも次のジョブを出せるようにする」参照。
export function QueueChoiceModal({
  open,
  surcharge,
  total,
  onCancel,
  onQueue,
  onParallel,
}: {
  open: boolean;
  surcharge: number;
  /** 通常料金 + 上乗せの合計。渡すと「+○C（合計 △C）」と出す（2026-09-23、
   * 「足されるのか置き換わるのか分からない」というホスト指摘への対応）。 */
  total?: number;
  onCancel: () => void;
  onQueue: () => void;
  onParallel: () => void;
}) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div className="w-full max-w-sm rounded-2xl border-gradient bg-surface p-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">まだ生成中です</h3>
          <button type="button" onClick={onCancel} aria-label="閉じる" className="text-muted transition-colors hover:text-foreground">
            <X size={20} />
          </button>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          今の生成が終わり次第、自動的に次を実行できます（無料）。待たずに今すぐ並列で実行することもできます（追加料金）。
          ※並列実行を選ぶと、今表示中の生成の進捗はこの画面では追えなくなります（生成自体は裏で完了します）。
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            onClick={onQueue}
            className="rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90"
          >
            順番待ち（無料）
          </button>
          <button
            type="button"
            onClick={onParallel}
            className="rounded-xl border border-border bg-background px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:border-neon-violet/40"
          >
            今すぐ並列実行（通常料金に +{surcharge}C{total != null ? `、合計 ${total}C` : ""}）
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-6 py-2 text-xs text-muted transition-colors hover:text-foreground"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// 完了後30秒（scaledown_window=30に合わせた既定）のwarmカウントダウン表示。
// busy中は出さない呼び出し側で制御する想定。
export function WarmCountdownBanner({ remainingMs }: { remainingMs: number }) {
  return (
    <div className="mt-3 flex items-center justify-center gap-2.5 rounded-xl border border-orange-500/50 bg-orange-500/10 px-4 py-3 shadow-[0_0_20px_-4px_rgba(249,115,22,0.6)]">
      <Flame size={20} className="shrink-0 animate-pulse text-orange-400" />
      <p className="text-center text-xs font-bold leading-snug text-orange-300">
        GPUシャットダウンまで残り{formatWarmCountdown(remainingMs)}秒
        <br />
        今なら起動を待たずにすぐ生成できます！
      </p>
    </div>
  );
}

// 予約中インジケーター（生成中フォームの下に出す小さなバナー）。
export function QueuedNextBanner({ onCancel, count }: { onCancel: () => void; count?: number }) {
  // count は複数件予約に対応したタブ（Multi-Angle、2026-09-23）だけが渡す。
  const label =
    count != null && count > 1
      ? `次の生成を ${count} 件予約中です。今の生成が終わり次第、予約した順に自動で始まります。`
      : "次の生成を予約中です。今の生成が終わり次第、自動的に始まります。";
  return (
    <p className="-mt-2 flex items-center justify-between gap-2 rounded-lg border border-neon-pink/30 bg-neon-pink/10 px-3 py-2 text-xs leading-relaxed text-neon-pink">
      <span>{label}</span>
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 rounded-md border border-neon-pink/40 px-2 py-1 text-[11px] font-semibold text-neon-pink transition-colors hover:bg-neon-pink/20"
      >
        {count != null && count > 1 ? "予約をすべて取り消す" : "予約を取り消す"}
      </button>
    </p>
  );
}
