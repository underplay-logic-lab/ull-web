"use client";

// 「表現の制限に引っかかりました。制限を解除しますか？」（2026-10-06 ホスト判断）。
// 台本・写真の指示文を書く AI に断られたとき（課金前の 409 code "restricted"）に出し、
// 解除すると同じ内容を制限なしモード（GPU 上の別の AI・追加料金）で送り直す。
// 使う AI の名前は出さない（CLAUDE.md §2）。

import { createPortal } from "react-dom";
import { ShieldOff, X } from "lucide-react";

export function RestrictedChoiceModal({
  open,
  surcharge,
  onCancel,
  onUnlock,
}: {
  open: boolean;
  surcharge: number;
  onCancel: () => void;
  onUnlock: () => void;
}) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-full max-w-sm rounded-2xl border-gradient bg-surface p-7" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-bold">
            <ShieldOff size={18} className="text-amber-400" />
            制限に抵触しました
          </h3>
          <button type="button" onClick={onCancel} aria-label="閉じる" className="text-muted transition-colors hover:text-foreground">
            <X size={20} />
          </button>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          入力した内容が、指示文を書く AI の表現制限に引っかかりました。制限を解除すると、制限のない AI で同じ内容のまま作ります。
          まだクレジットは使っていません。
        </p>
        <p className="mt-2 text-sm text-foreground">
          制限の解除: <span className="font-mono text-neon-pink">+{surcharge} C</span>
        </p>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-border bg-background px-4 py-2.5 text-sm text-muted transition-colors hover:text-foreground"
          >
            やめる
          </button>
          <button
            type="button"
            onClick={onUnlock}
            className="flex-1 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-4 py-2.5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
          >
            制限を解除して作る
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 最初から制限なしで作るスイッチ（毎回引っかかる人向け）。 */
export function UnrestrictedToggle({
  checked,
  onChange,
  surcharge,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  surcharge: number;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs text-muted">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-neon-violet" />
      <span>
        <span className="font-medium text-foreground">制限なしで作る（+{surcharge} C）</span>
        <br />
        指示文を書く AI の表現制限に毎回引っかかる内容のときに。最初から制限のない AI で作ります。
      </span>
    </label>
  );
}
