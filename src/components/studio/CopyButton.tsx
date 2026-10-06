"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** 文字列をクリップボードへ写す小さなボタン（Director / Photo Director のプロンプト表示で共用）。 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (err) {
          console.error("[CopyButton] clipboard copy failed:", err);
        }
      }}
      className="flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-[11px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
    >
      {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
      {copied ? "コピーしました" : label}
    </button>
  );
}
