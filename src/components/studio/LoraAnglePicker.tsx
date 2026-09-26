"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";

// LoRA Studio →「マルチアングルで足りない構図を作る」で、元にする画像を選ぶ（2026-09-26、ホスト要望:
// 「マルチアングルにどうぞ」で終わらず、選んだ画像がマルチアングルへ運ばれ、結果から選んで LoRA へ戻る導線）。

export type AnglePickItem = { id: string; url: string; file: File };

const MAX_PICK = 12;

export function LoraAnglePicker({
  open,
  items,
  onClose,
  onConfirm,
}: {
  open: boolean;
  items: AnglePickItem[];
  onClose: () => void;
  onConfirm: (files: File[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  if (!open || typeof document === "undefined") return null;

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_PICK) next.add(id);
      return next;
    });

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border-gradient bg-surface p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold">マルチアングルの元にする画像を選ぶ</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              選んだ画像ごとに、別の向き・距離の画像を作ります。顔と服がはっきり写っている画像がおすすめです（最大 {MAX_PICK} 枚）。
              作った画像は、マルチアングルの画面で選んでこのデータセットに戻せます。
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="閉じる" className="text-muted hover:text-foreground">
            <X size={20} />
          </button>
        </div>
        <div className="mt-4 grid flex-1 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
          {items.map((it) => {
            const on = picked.has(it.id);
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => toggle(it.id)}
                className={`relative aspect-square overflow-hidden rounded-lg border-2 transition-colors ${
                  on ? "border-neon-pink" : "border-transparent hover:border-border"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={it.url} alt={it.file.name} className={`h-full w-full object-cover ${on ? "" : "opacity-80"}`} />
                {on && (
                  <span className="absolute right-1 top-1 rounded-full bg-neon-pink p-0.5 text-white">
                    <Check size={12} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted">{picked.size} 枚を選択中</span>
          <button type="button" onClick={onClose} className="px-4 py-2 text-xs text-muted hover:text-foreground">
            キャンセル
          </button>
          <button
            type="button"
            disabled={picked.size === 0}
            onClick={() => {
              const files = items.filter((it) => picked.has(it.id)).map((it) => it.file);
              setPicked(new Set());
              onConfirm(files);
            }}
            className="rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-5 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            選んだ {picked.size} 枚をマルチアングルへ
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
