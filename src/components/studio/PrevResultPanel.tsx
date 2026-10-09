"use client";

// 「前の結果」（2026-09-29、ホスト指摘「予約した次の生成が始まると前の結果が消え、終わるまで戻れない」）。
// 次の生成が始まるとき直前の完了分を、進行中の表示とは別枠で見せる。「今回の生成」一覧の「表示」も、
// 生成中はここへ出す（進行中の表示は差し替えない）。URL は署名切れ・R2 移動で切れるので、読めなかったら
// 取り直す（2 回まで）。保存も押した時点で取り直す（CLAUDE.md §6-11）。
// 2026-10-09: 複数の結果（Photo Director の写真・曲づくりの曲）と音声にも対応（resolveUrls・kind "audio"）。保存は全部を順に。

import { useEffect, useRef, useState } from "react";
import { Download, Loader2, X } from "lucide-react";

export function PrevResultPanel({
  kind,
  resolveUrl,
  resolveUrls,
  onDownload,
  onClose,
  label,
}: {
  kind: "image" | "video" | "audio";
  /** 表示・保存に使う URL を取り直す（呼ぶたびに新しい署名）。結果が 1 つのタブ用。 */
  resolveUrl?: () => Promise<string | null>;
  /** 結果が複数のタブ用（並びは結果の順）。resolveUrl とどちらか一方を渡す。 */
  resolveUrls?: () => Promise<string[]>;
  /** index は resolveUrls の並びでの位置（1 つのタブは常に 0）。 */
  onDownload: (url: string, index: number) => Promise<void> | void;
  onClose: () => void;
  label?: string;
}) {
  const [urls, setUrls] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const reloads = useRef(0);
  const resolveRef = useRef(async (): Promise<string[]> => []);
  useEffect(() => {
    resolveRef.current = resolveUrls
      ? resolveUrls
      : async () => {
          const u = resolveUrl ? await resolveUrl() : null;
          return u ? [u] : [];
        };
  }, [resolveUrl, resolveUrls]);

  useEffect(() => {
    let alive = true;
    resolveRef
      .current()
      .then((list) => {
        if (!alive) return;
        if (list.length) setUrls(list);
        else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const retry = () => {
    if (reloads.current >= 2) return;
    reloads.current += 1;
    window.setTimeout(() => {
      void resolveRef.current().then((list) => list.length && setUrls(list));
    }, 1500);
  };

  const save = async () => {
    setSaving(true);
    try {
      const list = await resolveRef.current();
      for (let i = 0; i < list.length; i++) await onDownload(list[i], i);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6 rounded-xl border border-border bg-surface/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted">
          前の結果{label ? <span className="ml-2 text-muted/60">{label}</span> : null}
        </p>
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!urls || saving}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-foreground hover:bg-surface-hover disabled:opacity-50"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {urls && urls.length > 1 ? `${urls.length} 件を保存` : "保存"}
          </button>
          <button type="button" onClick={onClose} aria-label="閉じる" className="text-muted hover:text-foreground">
            <X size={14} />
          </button>
        </span>
      </div>
      {failed ? (
        <p className="text-[11px] text-red-400">前の結果を読み込めませんでした。</p>
      ) : !urls ? (
        <div className="flex h-32 items-center justify-center text-muted">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : kind === "video" ? (
        <div className="space-y-2">
          {urls.map((u) => (
            <video key={u} src={u} controls playsInline className="w-full rounded-lg bg-black" onError={retry} />
          ))}
        </div>
      ) : kind === "audio" ? (
        <div className="space-y-2">
          {urls.map((u) => (
            <audio key={u} src={u} controls preload="metadata" className="w-full" onError={retry} />
          ))}
        </div>
      ) : (
        <div className={`grid gap-2 ${urls.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
          {urls.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" title="別タブで原寸表示">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="前の結果" className="max-h-96 w-full rounded-lg bg-black/40 object-contain" onError={retry} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
