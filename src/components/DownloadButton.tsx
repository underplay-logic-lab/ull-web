"use client";

import { Download, Clock } from "lucide-react";

type DownloadButtonProps = {
  productName: string;
  version: string;
  variant: "pink" | "violet";
  downloadUrl?: string;
};

export function DownloadButton({
  productName,
  version,
  variant,
  downloadUrl,
}: DownloadButtonProps) {
  const className =
    variant === "pink"
      ? "bg-gradient-to-r from-neon-pink to-neon-pink/80 hover:opacity-90 glow-pink"
      : "bg-gradient-to-r from-neon-violet to-neon-violet/80 hover:opacity-90 glow-violet";

  if (downloadUrl) {
    return (
      <a
        href={downloadUrl}
        download
        className={`mt-8 inline-flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-sm font-semibold text-white transition-all ${className}`}
      >
        <Download size={16} />
        無料ダウンロード
      </a>
    );
  }

  return (
    <button
      type="button"
      disabled
      className="mt-8 inline-flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-border bg-background px-6 py-3.5 text-sm font-semibold text-muted"
      title={`「${productName} ${version}」は近日公開予定です。`}
    >
      <Clock size={16} />
      近日公開
    </button>
  );
}
