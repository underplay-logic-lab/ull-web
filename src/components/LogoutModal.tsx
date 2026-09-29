"use client";

import { Loader2, LogOut, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";

type LogoutModalProps = {
  open: boolean;
  onClose: () => void;
  /** clear=true なら Studio の作業状態をこの端末から消してからログアウトする。 */
  onLogout: (clear: boolean) => void;
  loading?: boolean;
};

// ログアウト時に Studio の作業状態（取り込んだ画像・下書き・実行中ジョブ）をこの端末に残すか選ぶ（2026-09-29 ホスト判断）。
// 残せば次にログインしたとき続きから戻れる。共用の端末なら消す（開発者ツールで中身を読めるため）。
export function LogoutModal({ open, onClose, onLogout, loading = false }: LogoutModalProps) {
  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      data-source-file="src/components/LogoutModal.tsx"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={() => !loading && onClose()}
    >
      <div className="w-full max-w-md rounded-2xl border-gradient bg-surface p-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-lg font-bold text-foreground">ログアウト</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            aria-label="閉じる"
            className="shrink-0 text-muted transition-colors hover:text-foreground"
          >
            <X size={20} />
          </button>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-foreground/80">
          Studio の作業状態（取り込んだ画像・入力中の設定など）をこの端末に残しますか？
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          残すと、次にこのアカウントでログインしたときに続きから始められます。ほかの人も使う端末では「消す」を選んでください。
          消すと、各タブの直近の結果（生成中のものを含む）はこの端末で表示し直せなくなります。必要な結果は先に保存してください。
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => onLogout(false)}
            disabled={loading}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-60"
          >
            <LogOut size={16} />
            残してログアウト
          </button>
          <button
            type="button"
            onClick={() => onLogout(true)}
            disabled={loading}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:border-neon-pink disabled:opacity-60"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
            この端末から消してログアウト
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
