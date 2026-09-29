"use client";

// 「前の結果」（2026-09-29、ホスト指摘「予約した次の生成が始まると前の結果が消え、終わるまで戻れない」）。
// 次の生成が始まるとき直前の完了分を、進行中の表示とは別枠で見せる。「今回の生成」一覧の「表示」も、
// 生成中はここへ出す（進行中の表示は差し替えない）。URL は署名切れ・R2 移動で切れるので、読めなかったら
// 取り直す（2 回まで）。保存も押した時点で取り直す（CLAUDE.md §6-11）。

import { useEffect, useRef, useState } from "react";
import { Download, Loader2, X } from "lucide-react";

export function PrevResultPanel({
  kind,
  resolveUrl,
  onDownload,
  onClose,
  label,
}: {
  kind: "image" | "video";
  /** 表示・保存に使う URL を取り直す（呼ぶたびに新しい署名）。 */
  resolveUrl: () => Promise<string | null>;
  onDownload: (url: string) => Promise<void> | void;
  onClose: () => void;
  label?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const reloads = useRef(0);
  const resolveRef = useRef(resolveUrl);
  useEffect(() => {
    resolveRef.current = resolveUrl;
  }, [resolveUrl]);

  useEffect(() => {
    let alive = true;
    resolveRef
      .current()
      .then((u) => {
        if (!alive) return;
        if (u) setUrl(u);
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
      void resolveRef.current().then((u) => u && setUrl(u));
    }, 1500);
  };

  const save = async () => {
    setSaving(true);
    try {
      const u = await resolveRef.current();
      if (u) await onDownload(u);
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
            disabled={!url || saving}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-foreground hover:bg-surface-hover disabled:opacity-50"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            保存
          </button>
          <button type="button" onClick={onClose} aria-label="閉じる" className="text-muted hover:text-foreground">
            <X size={14} />
          </button>
        </span>
      </div>
      {failed ? (
        <p className="text-[11px] text-red-400">前の結果を読み込めませんでした。</p>
      ) : !url ? (
        <div className="flex h-32 items-center justify-center text-muted">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : kind === "video" ? (
        <video src={url} controls playsInline className="w-full rounded-lg bg-black" onError={retry} />
      ) : (
        <a href={url} target="_blank" rel="noreferrer" title="別タブで原寸表示">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="前の結果" className="max-h-96 w-full rounded-lg bg-black/40 object-contain" onError={retry} />
        </a>
      )}
    </div>
  );
}
