"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export type ToastData = { id: number; message: string };

const AUTO_DISMISS_MS = 6000;

type ToastStackProps = {
  toasts: ToastData[];
  onDismiss: (id: number) => void;
};

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (typeof document === "undefined" || toasts.length === 0) return null;

  return createPortal(
    <div className="fixed bottom-4 right-4 z-[110] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2 sm:bottom-6 sm:right-6">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastData; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div className="flex items-center gap-3 rounded-xl border-gradient bg-surface px-4 py-3 shadow-xl">
      <p className="min-w-0 flex-1 text-sm font-medium text-foreground">{toast.message}</p>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="閉じる"
        className="shrink-0 text-muted transition-colors hover:text-foreground"
      >
        <X size={14} />
      </button>
    </div>
  );
}
