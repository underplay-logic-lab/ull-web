"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Flame, X } from "lucide-react";

export type LoginBonusToastData = {
  title: string;
  message: string;
};

type LoginBonusToastProps = LoginBonusToastData & {
  onDismiss: () => void;
};

const AUTO_DISMISS_MS = 8000;

export function LoginBonusToast({ title, message, onDismiss }: LoginBonusToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed top-20 right-4 left-4 z-[200] sm:left-auto sm:right-6 sm:w-full sm:max-w-sm">
      <div className="animate-float rounded-2xl border-gradient bg-surface p-4 shadow-2xl glow-pink">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neon-pink/10 text-neon-pink">
            <Flame size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-foreground">{title}</p>
            <p className="mt-1 text-xs leading-relaxed text-foreground/80">{message}</p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="閉じる"
            className="shrink-0 text-muted transition-colors hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
