"use client";

import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";

// 「今回の生成」一覧（2026-09-23、ホスト方針）。順番待ち・並列で続けて出したジョブ
// だけをブラウザ側（localStorage）に並べ、改めて生成するときは確認のうえ空にする。
// サーバー側の保持はユーザーに見せない安全弁で、ユーザーには「都度ダウンロード
// しなければ消える」感覚でいてもらう。保持期間は UI に書かない。
// Multi-Angle はサーバー一覧を id で絞る実装、超解像 画像/動画・Director はこの
// 共有部品で作成時のメタ情報だけを持つ（ジョブ本体は各タブの poll で読み直す）。

export type StudioSessionEntry = {
  id: string;
  createdAt: string;
  /** ユーザー自身のファイル名など。内部モデル名は入れない（CLAUDE.md §2）。 */
  label: string;
};

export function loadStudioSession(key: string): StudioSessionEntry[] {
  const raw = loadFormState<{ jobs: StudioSessionEntry[] }>(key)?.jobs;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is StudioSessionEntry =>
      Boolean(e) && typeof e === "object" && typeof e.id === "string" && typeof e.createdAt === "string",
  );
}

export function saveStudioSession(key: string, jobs: StudioSessionEntry[]): void {
  saveFormState(key, { jobs });
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function StudioSessionList({
  entries,
  currentId,
  busy,
  onShow,
}: {
  entries: StudioSessionEntry[];
  currentId: string | null;
  busy: boolean;
  onShow: (id: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-8 border-t border-border pt-6">
      <p className="text-xs font-medium text-muted">
        今回の生成
        <span className="ml-2 text-muted/60">続けて出した生成はここから表示し直せます。改めて生成すると一覧は消去されます。</span>
      </p>
      <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface/40">
        {entries.map((e) => {
          const current = e.id === currentId;
          return (
            <li key={e.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
              <span className="flex min-w-0 items-center gap-3">
                <span className="shrink-0 tabular-nums text-muted">{formatWhen(e.createdAt)}</span>
                <span className="truncate">{e.label || "生成"}</span>
              </span>
              <button
                type="button"
                onClick={() => onShow(e.id)}
                disabled={busy || current}
                className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:border-neon-pink/50 hover:bg-surface-hover disabled:opacity-50"
              >
                {current ? "表示中" : "表示"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SessionResetConfirmModal({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div className="w-full max-w-sm rounded-2xl border-gradient bg-surface p-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">これまでの生成結果は消去されます</h3>
          <button type="button" onClick={onCancel} aria-label="閉じる" className="text-muted transition-colors hover:text-foreground">
            <X size={20} />
          </button>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          新しく生成すると、今表示している結果と「今回の生成」の一覧は消去されます。必要なものは先にダウンロードしてください。続けますか？
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90"
          >
            消去して生成する
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
