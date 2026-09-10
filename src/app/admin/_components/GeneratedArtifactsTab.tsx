"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Download,
  Folder,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";

// ── 型 ───────────────────────────────────────────────────────────────
type GenKind = "angle" | "upscale" | "video" | "lora";
type Generation = {
  id: string;
  kind: GenKind;
  label: string;
  userId: string;
  userEmail: string | null;
  status: string;
  creditsCost: number;
  thumbUrl: string | null;
  extra: string | null;
  errorMessage: string | null;
  createdAt: string;
};

type StorageEntry = {
  name: string;
  path: string;
  isFolder: boolean;
  sizeBytes: number | null;
  updatedAt: string | null;
  mimeType: string | null;
  url: string | null;
};

type BucketInfo = { id: string; label: string; public: boolean };

function fmtBytes(n: number | null): string {
  if (n == null) return "";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", { hour12: false });
}

const KIND_STYLE: Record<GenKind, { label: string; cls: string }> = {
  angle: { label: "Multi-Angle", cls: "border-neon-pink/40 bg-neon-pink/10 text-neon-pink" },
  upscale: { label: "超解像", cls: "border-neon-violet/40 bg-neon-violet/10 text-neon-violet" },
  video: { label: "動画", cls: "border-blue-500/40 bg-blue-500/10 text-blue-300" },
  lora: { label: "LoRA", cls: "border-amber-500/40 bg-amber-500/10 text-amber-300" },
};

function statusCls(s: string): string {
  if (s === "completed") return "text-emerald-400";
  if (s === "failed") return "text-red-400";
  if (s === "processing" || s === "queued" || s === "pending") return "text-amber-300";
  return "text-muted";
}

// ── 1. 最近の生成物 ───────────────────────────────────────────────────
function RecentGenerations() {
  const [rows, setRows] = useState<Generation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/generations");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました。");
      setRows(data.generations as Generation[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  return (
    <div className="rounded-2xl border-gradient bg-surface/40 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
          <ImageIcon size={16} className="text-neon-violet" />
          最近の生成物（各スタジオ横断・新しい順 {rows.length} 件）
        </h3>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
        >
          <RefreshCw size={12} />
          再読み込み
        </button>
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" /> 読み込み中...
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-background py-10 text-center text-xs text-muted">
          生成物がありません。
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="py-2 pr-3 font-medium">種別</th>
                <th className="py-2 pr-3 font-medium">内容</th>
                <th className="py-2 pr-3 font-medium">ユーザー</th>
                <th className="py-2 pr-3 font-medium">状態</th>
                <th className="py-2 pr-3 text-right font-medium">C</th>
                <th className="py-2 pr-3 font-medium">日時</th>
                <th className="py-2 font-medium">成果物</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ks = KIND_STYLE[r.kind];
                return (
                  <tr key={`${r.kind}-${r.id}`} className="border-b border-border/50 align-top">
                    <td className="py-2 pr-3">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${ks.cls}`}>
                        {ks.label}
                      </span>
                    </td>
                    <td className="max-w-[220px] py-2 pr-3 text-foreground">
                      {r.label}
                      {r.errorMessage && (
                        <span className="mt-0.5 flex items-start gap-1 text-[10px] leading-tight text-red-400">
                          <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                          {r.errorMessage}
                        </span>
                      )}
                    </td>
                    <td className="max-w-[160px] truncate py-2 pr-3 text-muted">{r.userEmail ?? r.userId.slice(0, 8)}</td>
                    <td className={`py-2 pr-3 ${statusCls(r.status)}`}>{r.status}</td>
                    <td className="py-2 pr-3 text-right font-mono text-muted">{r.creditsCost}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-muted">{fmtDate(r.createdAt)}</td>
                    <td className="py-2">
                      {r.thumbUrl ? (
                        <a
                          href={r.thumbUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-neon-violet underline decoration-dotted hover:opacity-80"
                        >
                          開く
                        </a>
                      ) : (
                        <span className="text-muted opacity-60">—</span>
                      )}
                      {r.extra && <span className="ml-1 text-[10px] text-muted">({r.extra})</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── 2. バケットブラウザ ──────────────────────────────────────────────
function BucketBrowser() {
  const [buckets, setBuckets] = useState<BucketInfo[]>([]);
  const [bucket, setBucket] = useState<string>("");
  const [prefix, setPrefix] = useState<string>("");
  const [entries, setEntries] = useState<StorageEntry[]>([]);
  const [emailByFolder, setEmailByFolder] = useState<Record<string, string | null>>({});
  const [isPublic, setIsPublic] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // バケット一覧の初期取得
  useEffect(() => {
    (async () => {
      const res = await fetch("/api/admin/storage/objects");
      const data = await res.json();
      if (res.ok && Array.isArray(data.buckets)) {
        setBuckets(data.buckets);
        setBucket(data.buckets[0]?.id ?? "");
      }
    })();
  }, []);

  const loadPrefix = useCallback(
    async (b: string, p: string) => {
      if (!b) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/storage/objects?bucket=${encodeURIComponent(b)}&prefix=${encodeURIComponent(p)}`,
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました。");
        setEntries(data.entries as StorageEntry[]);
        setEmailByFolder(data.emailByFolder ?? {});
        setIsPublic(Boolean(data.public));
      } catch (e) {
        setError(e instanceof Error ? e.message : "取得に失敗しました。");
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!bucket) return;
    (async () => {
      await loadPrefix(bucket, prefix);
    })();
  }, [bucket, prefix, loadPrefix]);

  const crumbs = useMemo(() => (prefix ? prefix.split("/") : []), [prefix]);

  const handleDelete = async (e: StorageEntry) => {
    const what = e.isFolder ? `フォルダ「${e.name}」配下すべて` : `「${e.name}」`;
    if (!window.confirm(`${what} を削除します。取り消せません。`)) return;
    setDeleting(e.path);
    try {
      const res = await fetch("/api/admin/storage/objects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucket, path: e.path, is_folder: e.isFolder }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "削除に失敗しました。");
      setEntries((prev) => prev.filter((x) => x.path !== e.path));
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました。");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="rounded-2xl border-gradient bg-surface/40 p-6">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-bold text-foreground">
        <Folder size={16} className="text-neon-violet" />
        生成物ストレージ（Supabase バケット）
      </h3>

      {/* バケット選択 */}
      <div className="mb-3 flex flex-wrap gap-2">
        {buckets.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => {
              setBucket(b.id);
              setPrefix("");
            }}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              bucket === b.id
                ? "border-neon-pink/40 bg-neon-pink/10 text-neon-pink"
                : "border-border bg-background text-muted hover:border-neon-violet/40"
            }`}
          >
            {b.label}
            {!b.public && <span className="ml-1 opacity-60">🔒</span>}
          </button>
        ))}
      </div>

      {/* パンくず */}
      <div className="mb-3 flex flex-wrap items-center gap-1 text-xs text-muted">
        <button type="button" onClick={() => setPrefix("")} className="hover:text-foreground">
          {bucket || "—"}
        </button>
        {crumbs.map((c, i) => {
          const p = crumbs.slice(0, i + 1).join("/");
          const isUser = i === 0 && emailByFolder && Object.keys(emailByFolder).length === 0;
          void isUser;
          return (
            <span key={p} className="flex items-center gap-1">
              <ChevronRight size={11} />
              <button type="button" onClick={() => setPrefix(p)} className="hover:text-foreground">
                {i === 0 ? emailByFolder[c] ?? c : c}
              </button>
            </span>
          );
        })}
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" /> 読み込み中...
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-border bg-background py-10 text-center text-xs text-muted">
          この階層は空です。
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border/50">
          {entries.map((e) => (
            <div key={e.path} className="flex items-center gap-3 py-2 text-xs">
              {e.isFolder ? (
                <button
                  type="button"
                  onClick={() => setPrefix(e.path)}
                  className="flex flex-1 items-center gap-2 text-left text-foreground hover:text-neon-violet"
                >
                  <Folder size={14} className="shrink-0 text-neon-violet" />
                  <span className="truncate">
                    {crumbs.length === 0 ? emailByFolder[e.name] ?? e.name : e.name}
                  </span>
                </button>
              ) : (
                <div className="flex flex-1 items-center gap-2 truncate text-muted">
                  <ImageIcon size={14} className="shrink-0 opacity-60" />
                  <span className="truncate text-foreground">{e.name}</span>
                  <span className="shrink-0 opacity-60">{fmtBytes(e.sizeBytes)}</span>
                  <span className="hidden shrink-0 opacity-50 sm:inline">{fmtDate(e.updatedAt)}</span>
                </div>
              )}

              {!e.isFolder && e.url && (
                <a
                  href={e.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-neon-violet hover:opacity-80"
                  title="開く / ダウンロード"
                >
                  <Download size={13} />
                </a>
              )}
              <button
                type="button"
                onClick={() => handleDelete(e)}
                disabled={deleting === e.path}
                className="shrink-0 text-muted transition-colors hover:text-red-400 disabled:opacity-40"
                title="削除"
              >
                {deleting === e.path ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} />
                )}
              </button>
            </div>
          ))}
        </div>
      )}

      {!isPublic && (
        <p className="mt-3 text-[11px] text-muted">
          🔒 非公開バケット。リンクは 15 分間有効な署名 URL です。
        </p>
      )}
    </div>
  );
}

export function GeneratedArtifactsTab() {
  return (
    <div className="flex flex-col gap-8">
      <RecentGenerations />
      <BucketBrowser />
    </div>
  );
}
