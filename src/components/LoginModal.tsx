"use client";

import { createPortal } from "react-dom";
import { X } from "lucide-react";

type LoginModalProps = {
  open: boolean;
  onClose: () => void;
  message?: string;
};

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4c-7.5 0-14 4.2-17.7 10.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.5 0 10.4-1.9 14.3-5.1l-6.6-5.6C29.6 35.4 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.6 5.1C9.9 39.7 16.4 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.3-4.1 5.7l6.6 5.6C41.7 36.5 44 30.7 44 24c0-1.3-.1-2.7-.4-3.5z"
      />
    </svg>
  );
}

export function LoginModal({ open, onClose, message }: LoginModalProps) {
  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border-gradient bg-surface p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">ログイン</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-muted transition-colors hover:text-foreground"
          >
            <X size={20} />
          </button>
        </div>

        <p className="mt-2 text-sm leading-relaxed text-muted">
          {message ?? "続行するにはログインしてください。"}
        </p>

        <button
          type="button"
          onClick={() =>
            alert("Googleログイン連携は準備中です。公開時にここから利用できます。")
          }
          className="mt-6 flex w-full items-center justify-center gap-2.5 rounded-xl border border-border bg-background px-6 py-3 text-sm font-medium transition-colors hover:bg-surface-hover"
        >
          <GoogleIcon />
          Googleでログイン
        </button>

        <p className="mt-4 text-center text-xs text-muted">
          ログインすると10クレジットが付与されます。
        </p>
      </div>
    </div>,
    document.body,
  );
}
