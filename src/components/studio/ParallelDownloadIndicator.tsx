"use client";

import { useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import { getDownloadProgress, subscribeDownloadProgress } from "@/lib/parallelDownload";

// 分割ダウンロード（lib/parallelDownload.ts）の進み具合（2026-10-03）。ブラウザのダウンロード欄には保存の瞬間まで
// 何も出ないので、こちらで見せる。閉じると途中までの分は捨てられる旨も添える。
export function ParallelDownloadIndicator() {
  const p = useSyncExternalStore(subscribeDownloadProgress, getDownloadProgress, () => null);
  if (!p) return null;
  const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
  const pct = p.total > 0 ? Math.floor((p.done / p.total) * 100) : 0;
  return (
    <div className="fixed bottom-4 right-4 z-[90] w-72 rounded-xl border border-border bg-surface/95 p-3 text-xs shadow-lg backdrop-blur">
      <p className="flex items-center gap-1.5 font-semibold text-foreground">
        <Loader2 size={13} className="animate-spin" />
        保存中{p.count > 1 ? `（${p.index} / ${p.count} 本目）` : ""}
      </p>
      <p className="mt-1 truncate text-muted" title={p.filename}>
        {p.filename}
      </p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
        <div className="h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-violet" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-right tabular-nums text-muted">
        {mb(p.done)} / {mb(p.total)} MB
      </p>
      <p className="mt-1 text-[10px] text-muted/80">保存が終わるまで、このページを閉じないでください。</p>
    </div>
  );
}
