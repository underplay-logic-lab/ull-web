"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { ArrowDownUp, CheckCircle2, ChevronDown, Download, Eye, Folder, GitBranch, HardDrive, Loader2, Play, RefreshCw, Search, Trash2, Upload, XCircle } from "lucide-react";
import { GpuCostReferenceCard } from "@/components/admin/GpuCostReferenceCard";
import { ADMIN_UPLOAD_DIRS, ADMIN_UPLOAD_NAME_RE, uploadFileToVolume } from "@/lib/adminVolumeUpload";
import type { ModelDownload, VolumeDirEntry, VolumeFile } from "./types";

// --- 2026-09-21: ファイルエクスプローラーの使い勝手まわり --------------------
// ホスト指摘: ①フォルダごとのファイル数・容量が消えた（e271c62 の遅延読み込み
// 化で countFilesRecursive / sumSizeRecursive ごと削除された）②フォルダ名が
// UUID 2段で何のジョブか分からない ③ファイル名が長すぎて肝心の末尾
// （_step0001000 / _final）が見えない ④ソートできない ⑤プレビューが無い。
// ファイルの置き場所（パス規約）は変えず、表示だけで解決する方針。

type SortKey = "name" | "size" | "modified";
type SortState = { key: SortKey; dir: "asc" | "desc" };
const DEFAULT_SORT: SortState = { key: "name", dir: "asc" };

type VolumeDirStat = { files: number; bytes: number; truncated: boolean };
type VolumePathLabel = { kind: "user" | "job"; label: string; sub?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PREVIEW_IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];
const PREVIEW_VIDEO_EXTS = ["mp4", "webm", "mov"];
// 「原寸/本体」を出すときだけの上限。?inline=1 は Vercel 経由でバイトを
// 中継するため、大きいファイルは通さない（ダウンロードは署名付きの直リンク
// なので上限なし）。サムネイル経路（/thumb）はサイズに関係なく使える。
const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

function extOf(name: string): string {
  return name.toLowerCase().split(".").pop() ?? "";
}

function previewKindOf(file: VolumeFile): "image" | "video" | null {
  const ext = extOf(file.path);
  if (PREVIEW_IMAGE_EXTS.includes(ext)) return "image";
  if (PREVIEW_VIDEO_EXTS.includes(ext)) return "video";
  return null;
}

// 原寸/本体をブラウザへ中継してよいサイズか（サムネイルには無関係）。
function canStreamFull(file: VolumeFile): boolean {
  return file.size_bytes <= PREVIEW_MAX_BYTES;
}

// 長いファイル名は「中央」を省略する。末尾（_step0001000.safetensors /
// _final.safetensors）が何なのかを判別する肝なので、末尾は必ず残す。
function middleEllipsis(name: string, max = 52): string {
  if (name.length <= max) return name;
  const tail = Math.min(24, Math.floor(max / 2));
  return `${name.slice(0, max - tail - 1)}…${name.slice(-tail)}`;
}

function compareBy(sort: SortState, a: { name: string; size: number; modified: string }, b: typeof a): number {
  const sign = sort.dir === "asc" ? 1 : -1;
  if (sort.key === "size") return sign * (a.size - b.size);
  if (sort.key === "modified") return sign * a.modified.localeCompare(b.modified);
  return sign * a.name.localeCompare(b.name);
}

// その階層の子フォルダぶんの「ファイル数 / 容量」と、UUID の名前解決を
// まとめて1回ずつ取りに行く。一覧の描画はブロックせず、返ってきた順に
// 埋まる（集計は Volume の走査なので数秒かかることがある）。
function useDirMeta(dirs: VolumeDirEntry[] | null, enabled: boolean) {
  const [stats, setStats] = useState<Record<string, VolumeDirStat>>({});
  const [labels, setLabels] = useState<Record<string, VolumePathLabel>>({});
  // 「どの階層ぶんの集計が返ってきたか」を持つ。別途 loading フラグを立てると
  // effect 本体で setState することになり cascading render になるため、
  // 読み込み中かどうかはこれと pathKey の比較で導出する。
  const [statsDoneFor, setStatsDoneFor] = useState("");

  const pathKey = dirs ? dirs.map((d) => d.path).join("|") : "";
  const statsLoading = enabled && !!dirs && dirs.length > 0 && statsDoneFor !== pathKey;

  useEffect(() => {
    if (!enabled || !dirs || dirs.length === 0) return;
    let cancelled = false;
    fetch("/api/admin/modal/storage/stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: dirs.map((d) => d.path) }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setStats((d?.stats ?? {}) as Record<string, VolumeDirStat>);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setStatsDoneFor(pathKey);
      });

    const ids = dirs.map((d) => d.name).filter((n) => UUID_RE.test(n));
    if (ids.length > 0) {
      fetch("/api/admin/modal/storage/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setLabels((d?.labels ?? {}) as Record<string, VolumePathLabel>);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // pathKey が同じ間は再取得しない（削除で配列の identity だけ変わるケース）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey, enabled]);

  return { stats, labels, statsLoading };
}

// Mirrors MODEL_SUBFOLDERS in src/lib/modalStorage.ts / scripts/modal_wan_animate.py.
const MODEL_SUBFOLDERS = ["diffusion_models", "text_encoders", "clip_vision", "vae", "loras"] as const;

// Hidden-iframe GET so the browser's download bar picks up the file without
// the tab navigating away — the API route 302s to a signed direct Modal URL
// that carries Content-Disposition: attachment. Popup-blocker-proof.
function iframeDownload(url: string): void {
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = url;
  document.body.appendChild(iframe);
  setTimeout(() => iframe.remove(), 120_000);
}

// Top-level folder display order: model folders first (in this priority
// order), custom_nodes always last, everything else (outputs/, _logs/, ...)
// in an alphabetical middle tier.
const MODEL_FOLDER_PRIORITY = ["diffusion_models", "checkpoints", "clip_vision", "vae", "loras", "text_encoders"];

function folderSortRank(name: string): number {
  const priorityIndex = MODEL_FOLDER_PRIORITY.indexOf(name);
  if (priorityIndex !== -1) return priorityIndex;
  if (name === "custom_nodes") return 1000;
  return 500;
}

function formatSize(bytes: number): string {
  const tb = bytes / 1024 ** 4;
  if (tb >= 1) return `${tb.toFixed(2)} TB`;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(1)} MB`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { hour12: false });
}

// Pulls a save-path suggestion out of a pasted model URL — e.g.
// https://huggingface.co/Comfy-Org/.../diffusion_models/model.safetensors
// yields { subfolder: "diffusion_models", filename: "model.safetensors" }.
// subfolder is only returned when the URL's parent path segment is one of
// MODEL_SUBFOLDERS — otherwise the admin's current dropdown selection is
// left alone rather than being reset to something unrelated.
function extractDownloadInfo(url: string): {
  subfolder: (typeof MODEL_SUBFOLDERS)[number] | null;
  filename: string | null;
} {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return { subfolder: null, filename: null };
  }

  const segments = pathname.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (segments.length === 0) return { subfolder: null, filename: null };

  const filename = segments[segments.length - 1];
  if (!/\.[a-zA-Z0-9]+$/.test(filename)) return { subfolder: null, filename: null };

  const parent = segments.length >= 2 ? segments[segments.length - 2] : null;
  const subfolder = (MODEL_SUBFOLDERS as readonly string[]).includes(parent ?? "")
    ? (parent as (typeof MODEL_SUBFOLDERS)[number])
    : null;

  return { subfolder, filename };
}

const STATUS_LABEL: Record<ModelDownload["status"], string> = {
  pending: "待機中",
  downloading: "ダウンロード中",
  completed: "完了",
  failed: "失敗",
};

function sortedDirEntries(dirs: VolumeDirEntry[]): VolumeDirEntry[] {
  return [...dirs].sort((a, b) => {
    const rankDiff = folderSortRank(a.name) - folderSortRank(b.name);
    return rankDiff !== 0 ? rankDiff : a.name.localeCompare(b.name);
  });
}

// 絞り込み（名前 + 解決済みラベル）とソートをフォルダ一覧へ適用する。
// sort.key === "name" のときは従来の表示優先度（モデル系フォルダを先頭、
// custom_nodes を末尾）を維持する — 普段の並びを壊さないため。
function filterSortDirs(
  dirs: VolumeDirEntry[] | null,
  query: string,
  sort: SortState,
  stats: Record<string, VolumeDirStat>,
  labels: Record<string, VolumePathLabel>,
  hideEmpty: boolean,
): { rows: VolumeDirEntry[]; hiddenEmpty: number } {
  if (!dirs) return { rows: [], hiddenEmpty: 0 };
  const q = query.trim().toLowerCase();
  let rows = q
    ? dirs.filter((d) => {
        const l = labels[d.name];
        return (
          d.name.toLowerCase().includes(q) ||
          (l?.label ?? "").toLowerCase().includes(q) ||
          (l?.sub ?? "").toLowerCase().includes(q)
        );
      })
    : dirs;
  // 空フォルダ（ファイル0件）の非表示。集計が返ってきているものだけ判定する
  // ので、集計前は消えない（= 誤って隠すことがない）。
  let hiddenEmpty = 0;
  if (hideEmpty) {
    const kept = rows.filter((d) => {
      const st = stats[d.path];
      if (st && st.files === 0) {
        hiddenEmpty += 1;
        return false;
      }
      return true;
    });
    rows = kept;
  }
  const sorted =
    sort.key === "name"
      ? sortedDirEntries(rows)
      : [...rows].sort((a, b) =>
          compareBy(
            sort,
            { name: a.name, size: stats[a.path]?.bytes ?? -1, modified: a.modified_at ?? "" },
            { name: b.name, size: stats[b.path]?.bytes ?? -1, modified: b.modified_at ?? "" },
          ),
        );
  return { rows: sorted, hiddenEmpty };
}

function filterFiles(files: VolumeFile[] | null, query: string): VolumeFile[] {
  if (!files) return [];
  const q = query.trim().toLowerCase();
  if (!q) return files;
  return files.filter((f) => (f.path.split("/").pop() ?? "").toLowerCase().includes(q));
}

// Deletes one file via the shared DELETE route and reports ok/error — used
// by both FileTable (called from the owning level's own handler) so the
// network call itself isn't duplicated per call site.
async function deleteVolumePath(path: string, isDir: boolean): Promise<void> {
  const res = await fetch("/api/admin/modal/storage", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_path: path, is_dir: isDir }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? "削除に失敗しました。");
}

function SortHeader({
  label,
  col,
  sort,
  onSort,
  className = "",
}: {
  label: string;
  col: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === col;
  return (
    <th className={`px-4 py-2.5 font-medium ${className}`}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${active ? "text-foreground" : ""}`}
      >
        {label}
        {active ? (
          <span className="font-mono text-[10px]">{sort.dir === "asc" ? "▲" : "▼"}</span>
        ) : (
          <ArrowDownUp size={10} className="opacity-40" />
        )}
      </button>
    </th>
  );
}

// 2026-09-21: まずサムネイル（Modal 側で ffmpeg が1フレーム抜いた数十KBの
// JPEG。Volume にキャッシュ）だけを出し、動画の本体は再生ボタンを押した
// ときに初めて読む（ホスト指摘「動画の読み込みが遅い」）。
// <video preload="none" poster=...> なので、poster を出している間は本体への
// リクエストが1バイトも飛ばない。
function FilePreview({ file }: { file: VolumeFile }) {
  const kind = previewKindOf(file);
  const [playing, setPlaying] = useState(false);
  const thumbSrc = `/api/admin/modal/storage/thumb?file_path=${encodeURIComponent(file.path)}`;
  const fullSrc = `/api/admin/modal/storage/download?file_path=${encodeURIComponent(file.path)}&inline=1`;

  if (kind === "image") {
    // 画像も一旦サムネイル。原寸は「原寸で開く」で読む（20MB の PNG を
    // そのまま中継しないため）。
    return (
      <div className="flex flex-col items-start gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={playing ? fullSrc : thumbSrc}
          alt={file.path}
          className="max-h-72 rounded-lg border border-border"
        />
        {!playing && canStreamFull(file) && (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
          >
            <Eye size={12} />
            原寸で開く
          </button>
        )}
        {!playing && !canStreamFull(file) && (
          <span className="text-[11px] text-muted opacity-70">
            原寸は {formatSize(PREVIEW_MAX_BYTES)} を超えるため、ダウンロードで確認してください。
          </span>
        )}
      </div>
    );
  }

  if (kind === "video") {
    if (!playing) {
      return (
        <button
          type="button"
          onClick={() => canStreamFull(file) && setPlaying(true)}
          className="group relative inline-block overflow-hidden rounded-lg border border-border"
          title={
            canStreamFull(file)
              ? "クリックで本体を読み込んで再生します"
              : `本体が ${formatSize(PREVIEW_MAX_BYTES)} を超えるため、ダウンロードで確認してください`
          }
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumbSrc} alt={file.path} className="max-h-72" />
          <span className="absolute inset-0 flex items-center justify-center bg-black/30 transition-colors group-hover:bg-black/15">
            <span className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white">
              <Play size={12} />
              {canStreamFull(file) ? "再生（本体を読み込む）" : "サイズ超過 — DLで確認"}
            </span>
          </span>
        </button>
      );
    }
    return (
      <video src={fullSrc} controls autoPlay preload="none" className="max-h-72 rounded-lg border border-border" />
    );
  }
  return null;
}

function FileTable({
  files,
  deletingPath,
  onDeleteFile,
  sort,
  onSort,
}: {
  files: VolumeFile[];
  deletingPath: string | null;
  onDeleteFile: (path: string) => void;
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const sorted = useMemo(
    () =>
      [...files].sort((a, b) =>
        compareBy(
          sort,
          { name: a.path.split("/").pop() ?? "", size: a.size_bytes, modified: a.modified_at ?? "" },
          { name: b.path.split("/").pop() ?? "", size: b.size_bytes, modified: b.modified_at ?? "" },
        ),
      ),
    [files, sort],
  );
  return (
    <div className="overflow-x-auto rounded-xl border border-border" style={{ marginLeft: 16 }}>
      <table className="w-full min-w-[520px] text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-surface/60 text-xs uppercase tracking-wide text-muted">
            <SortHeader label="ファイル名" col="name" sort={sort} onSort={onSort} />
            <SortHeader label="サイズ" col="size" sort={sort} onSort={onSort} />
            <SortHeader label="更新日時" col="modified" sort={sort} onSort={onSort} />
            <th className="px-4 py-2.5 font-medium" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((file) => {
            const name = file.path.split("/").pop() ?? file.path;
            const canPreview = previewKindOf(file) !== null;
            const open = previewPath === file.path;
            return (
              <Fragment key={file.path}>
                <tr className="border-b border-border/60 last:border-0 hover:bg-surface-hover/40">
                  {/* 長い名前は中央省略。末尾（_step0001000 / _final）は肝なので必ず残す。 */}
                  <td className="px-4 py-2.5 font-mono text-xs text-foreground" title={file.path}>
                    {middleEllipsis(name)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">{formatSize(file.size_bytes)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted">
                    {formatDateTime(file.modified_at)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {canPreview && (
                        <button
                          type="button"
                          onClick={() => setPreviewPath(open ? null : file.path)}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                            open
                              ? "border-neon-violet/50 bg-neon-violet/10 text-neon-violet"
                              : "border-border text-muted hover:border-neon-violet/40 hover:text-foreground"
                          }`}
                        >
                          <Eye size={12} />
                          プレビュー
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          iframeDownload(`/api/admin/modal/storage/download?file_path=${encodeURIComponent(file.path)}`)
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
                      >
                        <Download size={12} />
                        ダウンロード
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteFile(file.path)}
                        disabled={deletingPath === file.path}
                        className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 px-2.5 py-1 text-xs text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {deletingPath === file.path ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                        削除
                      </button>
                    </div>
                  </td>
                </tr>
                {open && (
                  <tr className="border-b border-border/60 last:border-0">
                    <td colSpan={4} className="px-4 py-3">
                      <FilePreview file={file} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// 2026-09-19: 遅延読み込み版。開いた時点で自分の直下（1階層）だけを
// /api/admin/modal/storage?path=... で取得する — 実運用規模（数千ファイル）
// でVolume全体を毎回os.walkしていた旧実装の遅さを解消するため、フォルダ
// ごとに独立して自分の中身を持つ構造に作り替えた（以前は起動時に全ファイル
// を取得しクライアント側でツリーを構築していた）。
function FolderRow({
  path,
  name,
  depth,
  onRemoved,
  sort,
  onSort,
  query,
  hideEmpty,
  stat,
  label,
  statLoading,
  modifiedAt,
}: {
  path: string;
  name: string;
  depth: number;
  onRemoved: (path: string) => void;
  sort: SortState;
  onSort: (key: SortKey) => void;
  query: string;
  hideEmpty: boolean;
  stat?: VolumeDirStat;
  label?: VolumePathLabel;
  statLoading?: boolean;
  modifiedAt?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState<VolumeDirEntry[] | null>(null);
  const [files, setFiles] = useState<VolumeFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingSelf, setDeletingSelf] = useState(false);
  const [deletingFilePath, setDeletingFilePath] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/modal/storage?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました。");
      setDirs((data.dirs ?? []) as VolumeDirEntry[]);
      setFiles((data.files ?? []) as VolumeFile[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取得に失敗しました。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && dirs === null && !loading) {
      // setState is behind an await inside load() — not a synchronous cascading render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const { stats: childStats, labels: childLabels, statsLoading: childStatsLoading } = useDirMeta(dirs, open);
  const { rows: visibleDirs, hiddenEmpty } = useMemo(
    () => filterSortDirs(dirs, query, sort, childStats, childLabels, hideEmpty),
    [dirs, query, sort, childStats, childLabels, hideEmpty],
  );
  const visibleFiles = useMemo(() => filterFiles(files, query), [files, query]);

  const handleChildRemoved = (childPath: string) => {
    setDirs((prev) => (prev ? prev.filter((d) => d.path !== childPath) : prev));
  };

  const handleDeleteFile = async (filePath: string) => {
    setDeletingFilePath(filePath);
    try {
      await deleteVolumePath(filePath, false);
      setFiles((prev) => (prev ? prev.filter((f) => f.path !== filePath) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました。");
    } finally {
      setDeletingFilePath(null);
    }
  };

  const handleDeleteSelf = async () => {
    if (!window.confirm(`「${path}/」フォルダ内のファイルをすべて削除します。よろしいですか？`)) return;
    setDeletingSelf(true);
    try {
      await deleteVolumePath(path, true);
      onRemoved(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました。");
      setDeletingSelf(false);
    }
  };

  return (
    <div style={depth > 0 ? { marginLeft: 16 } : undefined}>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-1.5 text-left text-xs font-medium text-foreground"
        >
          <ChevronDown size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
          <Folder size={13} className="shrink-0 text-neon-violet" />
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {/* UUID フォルダは「何のジョブ/誰か」を解決して前に出す。元の
                UUID は同定に要るので薄い字で必ず併記する。 */}
            {label ? (
              <>
                <span className="truncate text-foreground">
                  {label.kind === "user" ? "👤 " : "🎯 "}
                  {label.label}
                </span>
                {label.sub && <span className="truncate text-[10px] text-muted">{label.sub}</span>}
                <span className="truncate font-mono text-[10px] text-muted opacity-50">{name}</span>
              </>
            ) : (
              <span className="truncate">{name}/</span>
            )}
            {/* 2026-09-21 復活: フォルダ配下のファイル数と容量（e271c62 で消えた）。 */}
            {stat ? (
              <span className="shrink-0 font-mono text-[10px] text-muted">
                {stat.truncated ? `${stat.files}+` : stat.files} ファイル · {formatSize(stat.bytes)}
                {stat.truncated ? "+" : ""}
              </span>
            ) : statLoading ? (
              <Loader2 size={10} className="shrink-0 animate-spin text-muted opacity-60" />
            ) : null}
            {/* フォルダの日時。Linux では作成日時が取れないので「更新」=
                直下の中身が最後に変わった時刻。ジョブフォルダは label.sub に
                generation_jobs.created_at 由来の本当の作成日が入っている。 */}
            {modifiedAt && (
              <span className="shrink-0 font-mono text-[10px] text-muted opacity-70" title="フォルダの更新日時（Linux では作成日時を取得できません）">
                更新 {formatDateTime(modifiedAt)}
              </span>
            )}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => iframeDownload(`/api/admin/modal/storage/zip?path=${encodeURIComponent(path)}`)}
            title="このフォルダ配下の全ファイルを CPU コンテナ（GPU課金0）でZIP化して一括ダウンロードします。"
            className="inline-flex items-center gap-1 rounded-lg border border-neon-violet/40 bg-neon-violet/10 px-2.5 py-1 text-xs font-medium text-neon-violet transition-colors hover:bg-neon-violet/20"
          >
            <Download size={12} />
            📦 このフォルダを一括DL (ZIP)
          </button>
          <button
            type="button"
            onClick={handleDeleteSelf}
            disabled={deletingSelf}
            className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 px-2.5 py-1 text-xs text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deletingSelf ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            📁 フォルダごと一括削除
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted">
              <Loader2 size={14} className="animate-spin" />
              読み込み中...
            </div>
          )}

          {error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>
          )}

          {visibleDirs.map((d) => (
            <FolderRow
              key={d.path}
              path={d.path}
              name={d.name}
              depth={depth + 1}
              onRemoved={handleChildRemoved}
              sort={sort}
              onSort={onSort}
              query={query}
              hideEmpty={hideEmpty}
              stat={childStats[d.path]}
              label={childLabels[d.name]}
              statLoading={childStatsLoading}
              modifiedAt={d.modified_at}
            />
          ))}

          {visibleFiles.length > 0 && (
            <FileTable
              files={visibleFiles}
              deletingPath={deletingFilePath}
              onDeleteFile={handleDeleteFile}
              sort={sort}
              onSort={onSort}
            />
          )}

          {hiddenEmpty > 0 && (
            <p className="text-[11px] text-muted opacity-60">空フォルダ {hiddenEmpty} 件を非表示にしています。</p>
          )}

          {dirs && files && visibleDirs.length === 0 && visibleFiles.length === 0 && (
            <p className="py-2 text-center text-[11px] text-muted opacity-70">
              {query ? "この絞り込みに一致するものはありません。" : "空のフォルダです。"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ローカルPC -> Volume の直アップロード（2026-09-21）。リモートダウンローダは
// 「URL から Modal に落とさせる」ものなので、手元にしか無いファイル（Civitai に
// 置かれていないマージモデル等）を持ち込めなかった（ホスト指摘）。
// 実体は Vercel を通らず、ブラウザから Modal へ直接 PUT する
// （CLAUDE.md §1・§6-4: リクエストボディ上限 4.5MB のため API route は通せない）。
function VolumeUploadPanel({ onUploaded }: { onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [subdir, setSubdir] = useState<string>(ADMIN_UPLOAD_DIRS[0]);
  const [uploading, setUploading] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const total = file?.size ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  const nameOk = file ? ADMIN_UPLOAD_NAME_RE.test(file.name) : true;

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setNotice(null);
    setLoaded(0);
    try {
      const res = await uploadFileToVolume(file, subdir, (l) => setLoaded(l));
      setNotice({ kind: "success", text: `✅ ${res.path} に保存しました（${formatSize(res.sizeBytes)}）` });
      setFile(null);
      onUploaded();
    } catch (err) {
      setNotice({
        kind: "error",
        text: err instanceof Error ? err.message : "アップロードに失敗しました。",
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="rounded-2xl border-gradient bg-surface/40 p-6">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-foreground">
        <Upload size={16} className="text-neon-violet" />
        ローカルファイルをアップロード
      </h3>
      <p className="mb-4 text-xs text-muted">
        手元の .safetensors などを Volume へ直接送ります。途中で中断しても、同じファイルを選び直せば続きから再開します。
      </p>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="file"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setNotice(null);
            setLoaded(0);
          }}
          disabled={uploading}
          className="flex-1 text-xs text-muted file:mr-3 file:rounded-lg file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-xs file:text-foreground"
        />
        <select
          value={subdir}
          onChange={(e) => setSubdir(e.target.value)}
          disabled={uploading}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground"
        >
          {ADMIN_UPLOAD_DIRS.map((d) => (
            <option key={d} value={d}>
              {d}/
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleUpload}
          disabled={!file || uploading || !nameOk}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-neon-violet/40 bg-neon-violet/10 px-3 py-1.5 text-xs font-medium text-neon-violet transition-colors hover:bg-neon-violet/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
          アップロード
        </button>
      </div>

      {file && !nameOk && (
        <p className="mt-2 text-xs text-red-400">
          このファイル名は使えません。英数字と . _ - のみ、拡張子は .safetensors / .ckpt / .pt / .pth / .bin / .gguf です。
        </p>
      )}

      {uploading && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-background">
            <div
              className="h-full bg-gradient-to-r from-neon-pink to-neon-violet transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1.5 font-mono text-[11px] text-muted">
            {formatSize(loaded)} / {formatSize(total)}（{pct}%）
          </p>
        </div>
      )}

      {notice && (
        <p
          className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
            notice.kind === "success"
              ? "border-neon-pink/30 bg-neon-pink/10 text-neon-pink"
              : "border-red-500/30 bg-red-500/10 text-red-400"
          }`}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}

// Polling interval for the "📥 ダウンロードタスク一覧" panel — short enough
// to feel live, long enough not to hammer the admin API while a big model
// download sits in the background for several minutes.
const DOWNLOAD_POLL_INTERVAL_MS = 3000;

function DownloadStatusIcon({ status }: { status: ModelDownload["status"] }) {
  if (status === "completed") return <CheckCircle2 size={14} className="shrink-0 text-neon-pink" />;
  if (status === "failed") return <XCircle size={14} className="shrink-0 text-red-400" />;
  return <Loader2 size={14} className="shrink-0 animate-spin text-neon-violet" />;
}

function DownloadTaskRow({ task }: { task: ModelDownload }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <DownloadStatusIcon status={task.status} />
          <span className="truncate font-mono text-xs text-foreground" title={task.save_path}>
            {task.save_path}
          </span>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            task.status === "completed"
              ? "bg-neon-pink/15 text-neon-pink"
              : task.status === "failed"
                ? "bg-red-500/15 text-red-400"
                : "bg-neon-violet/15 text-neon-violet"
          }`}
        >
          {STATUS_LABEL[task.status]}
          {task.status === "downloading" && ` ${task.progress_percent}%`}
        </span>
      </div>

      {(task.status === "downloading" || task.status === "pending") && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-violet transition-all"
            style={{ width: `${Math.max(task.status === "pending" ? 2 : task.progress_percent, 2)}%` }}
          />
        </div>
      )}

      {task.status === "failed" && task.error_message && (
        <p className="mt-1.5 truncate text-[11px] text-red-400" title={task.error_message}>
          {task.error_message}
        </p>
      )}
    </div>
  );
}

function DownloadTasksPanel({ refreshSignal }: { refreshSignal: number }) {
  const [tasks, setTasks] = useState<ModelDownload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const loadTasks = async () => {
    try {
      const res = await fetch("/api/admin/model-downloads");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました。");
      setTasks(data.downloads as ModelDownload[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取得に失敗しました。");
    }
  };

  useEffect(() => {
    // setState is behind an await inside loadTasks() — not a synchronous
    // cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTasks();
  }, [refreshSignal]);

  // Polls regardless of tab visibility complexity — the panel is small and
  // this is an admin-only page, so the extra requests are negligible.
  useEffect(() => {
    const id = setInterval(loadTasks, DOWNLOAD_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const hasFinished = tasks.some((t) => t.status === "completed" || t.status === "failed");

  const clearFinished = async () => {
    setClearing(true);
    try {
      const res = await fetch("/api/admin/model-downloads", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_finished: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "削除に失敗しました。");
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました。");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="rounded-2xl border-gradient bg-surface/40 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
          📥 ダウンロードタスク一覧
        </h3>
        {hasFinished && (
          <button
            type="button"
            onClick={clearFinished}
            disabled={clearing}
            className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-red-400/50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {clearing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            完了済みをクリア
          </button>
        )}
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>
      )}

      {tasks.length === 0 ? (
        <div className="rounded-lg border border-border bg-background py-8 text-center text-xs text-muted">
          ダウンロードタスクはありません。
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {tasks.map((task) => (
            <DownloadTaskRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ModalStorageTab() {
  // ルート直下（1階層）だけを保持する。以前はVolume全体を1回で取得して
  // クライアント側でツリーを組み立てていたが、実運用規模では開くだけで
  // 数秒〜十数秒かかっていたため、フォルダを開くたびに1階層ずつ取得する
  // 方式に作り替えた（FolderRow参照）。
  const [rootDirs, setRootDirs] = useState<VolumeDirEntry[] | null>(null);
  const [rootFiles, setRootFiles] = useState<VolumeFile[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [deletingRootFilePath, setDeletingRootFilePath] = useState<string | null>(null);
  // Collapsed by default — expanding fetches (rather than fetching eagerly
  // on mount), so admins who don't need it skip the Modal round-trip.
  const [filesOpen, setFilesOpen] = useState(false);
  // 2026-09-21: 全階層に効く絞り込みとソート。階層ごとに持つと「どこで何を
  // 並べ替えたか」が分からなくなるので、エクスプローラー全体で1つにする。
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  // 空フォルダ（ファイル0件）は既定で畳む。ジョブやアップロードの殻が大量に
  // 残るため（ホスト指摘。lora_dataset_uploads/ は 12 個とも中身0件だった）。
  // 消してはいない — トグルで出せる。
  const [hideEmpty, setHideEmpty] = useState(true);
  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  // Volume全体の実使用量。os.walkする重い処理（実測 ~6秒 / 949GB・5,227
  // ファイル）なので、閲覧の既定経路には含めず明示的なボタンで opt-in する。
  const [usage, setUsage] = useState<{ totalBytes: number; totalFiles: number } | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);

  // "file" = single-file URL download (existing behavior); "repo" = a whole
  // Hugging Face repo via snapshot_download (e.g. a sharded LLM) — see
  // download_repo_async in scripts/modal_wan_animate.py.
  const [downloadMode, setDownloadMode] = useState<"file" | "repo">("file");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadSubfolder, setDownloadSubfolder] = useState<string>(MODEL_SUBFOLDERS[0]);
  const [downloadFilename, setDownloadFilename] = useState("");
  const [repoId, setRepoId] = useState("");
  const [repoSaveDir, setRepoSaveDir] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  // Bumped after each successful download start so DownloadTasksPanel
  // refetches immediately instead of waiting for its next poll tick.
  const [downloadTasksRefresh, setDownloadTasksRefresh] = useState(0);

  const [gitUrl, setGitUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installNotice, setInstallNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const loadRoot = async () => {
    setFilesLoading(true);
    setFilesError(null);
    try {
      const res = await fetch("/api/admin/modal/storage?path=");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました。");
      setRootDirs((data.dirs ?? []) as VolumeDirEntry[]);
      setRootFiles((data.files ?? []) as VolumeFile[]);
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : "取得に失敗しました。");
    } finally {
      setFilesLoading(false);
    }
  };

  useEffect(() => {
    if (!filesOpen || rootDirs !== null) return;
    // setState is behind an await inside loadRoot() — not a synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesOpen]);

  const calcUsage = async () => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      const res = await fetch("/api/admin/modal/storage?usage=1");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました。");
      setUsage({ totalBytes: data.totalBytes as number, totalFiles: data.totalFiles as number });
    } catch (err) {
      setUsageError(err instanceof Error ? err.message : "取得に失敗しました。");
    } finally {
      setUsageLoading(false);
    }
  };

  const handleDownload = async () => {
    if (downloadMode === "repo") {
      if (!repoId.trim() || !repoSaveDir.trim()) return;
      setDownloading(true);
      setDownloadNotice(null);
      try {
        const res = await fetch("/api/admin/modal/storage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "repo", repo_id: repoId.trim(), save_dir: repoSaveDir.trim() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "ダウンロードに失敗しました。");
        setDownloadNotice({
          kind: "success",
          text: `✅ ${data.download.save_path}/ へのリポジトリ一括ダウンロードを開始しました。進捗は下の「📥 ダウンロードタスク一覧」でご確認ください。`,
        });
        setRepoId("");
        setRepoSaveDir("");
        setDownloadTasksRefresh((n) => n + 1);
      } catch (err) {
        setDownloadNotice({ kind: "error", text: err instanceof Error ? err.message : "ダウンロードに失敗しました。" });
      } finally {
        setDownloading(false);
      }
      return;
    }

    if (!downloadUrl.trim() || !downloadFilename.trim()) return;
    setDownloading(true);
    setDownloadNotice(null);
    try {
      const res = await fetch("/api/admin/modal/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: downloadUrl.trim(),
          subfolder: downloadSubfolder,
          filename: downloadFilename.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "ダウンロードに失敗しました。");
      setDownloadNotice({
        kind: "success",
        text: `✅ ${data.download.save_path} のダウンロードを開始しました。進捗は下の「📥 ダウンロードタスク一覧」でご確認ください。`,
      });
      setDownloadUrl("");
      setDownloadFilename("");
      setDownloadTasksRefresh((n) => n + 1);
    } catch (err) {
      setDownloadNotice({ kind: "error", text: err instanceof Error ? err.message : "ダウンロードに失敗しました。" });
    } finally {
      setDownloading(false);
    }
  };

  const handleDeleteRootFile = async (path: string) => {
    setDeletingRootFilePath(path);
    try {
      await deleteVolumePath(path, false);
      setRootFiles((prev) => (prev ? prev.filter((f) => f.path !== path) : prev));
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : "削除に失敗しました。");
    } finally {
      setDeletingRootFilePath(null);
    }
  };

  const handleRootFolderRemoved = (path: string) => {
    setRootDirs((prev) => (prev ? prev.filter((d) => d.path !== path) : prev));
  };

  const handleInstallNode = async () => {
    if (!gitUrl.trim()) return;
    setInstalling(true);
    setInstallNotice(null);
    try {
      const res = await fetch("/api/admin/modal/custom-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ git_url: gitUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "インストールに失敗しました。");
      setInstallNotice({ kind: "success", text: `✅ ${data.name} をインストールしました（次回生成から反映されます）` });
      setGitUrl("");
    } catch (err) {
      setInstallNotice({ kind: "error", text: err instanceof Error ? err.message : "インストールに失敗しました。" });
    } finally {
      setInstalling(false);
    }
  };

  const {
    stats: rootStats,
    labels: rootLabels,
    statsLoading: rootStatsLoading,
  } = useDirMeta(rootDirs, filesOpen);
  const { rows: visibleRootDirs, hiddenEmpty: rootHiddenEmpty } = useMemo(
    () => filterSortDirs(rootDirs, query, sort, rootStats, rootLabels, hideEmpty),
    [rootDirs, query, sort, rootStats, rootLabels, hideEmpty],
  );
  const visibleRootFiles = useMemo(() => filterFiles(rootFiles, query), [rootFiles, query]);
  const rootEmpty = rootDirs !== null && rootFiles !== null && rootDirs.length === 0 && rootFiles.length === 0;

  return (
    <div className="flex flex-col gap-8">
      {/* 0. File explorer — collapsed by default; lazy per-folder loading (2026-09-19) */}
      <div className="rounded-2xl border-gradient bg-surface/40 p-6">
        <button
          type="button"
          onClick={() => setFilesOpen((v) => !v)}
          className="flex w-full items-center justify-between text-left"
        >
          <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
            <HardDrive size={16} className="text-neon-violet" />
            ファイルエクスプローラー（Volume: ull-wan-models）
          </h3>
          <ChevronDown
            size={16}
            className={`shrink-0 text-muted transition-transform ${filesOpen ? "rotate-180" : ""}`}
          />
        </button>

        {filesOpen && (
          <div className="mt-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {usage ? (
                  <div className="flex items-center gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/5 px-3 py-1.5 text-xs">
                    <HardDrive size={13} className="text-neon-violet" />
                    <span className="text-muted">実使用量</span>
                    <span className="font-mono font-semibold text-foreground">{formatSize(usage.totalBytes)}</span>
                    <span className="text-muted opacity-70">/ {usage.totalFiles} ファイル</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={calcUsage}
                    disabled={usageLoading}
                    title="Volume全体を走査して合計サイズを計算します（数秒かかります）。通常のフォルダ閲覧には不要です。"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {usageLoading ? <Loader2 size={12} className="animate-spin" /> : <HardDrive size={12} />}
                    実使用量を計算
                  </button>
                )}
                {usageError && <span className="text-xs text-red-400">{usageError}</span>}
                {/* 2026-09-21: 読み込み済みの階層に対する絞り込み。フォルダは
                    解決済みのラベル（LoRA名・メールアドレス）にも当たる。 */}
                <div className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5">
                  <Search size={12} className="shrink-0 text-muted" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="名前 / LoRA名 / ユーザーで絞り込み"
                    className="w-56 bg-transparent text-xs text-foreground outline-none placeholder:text-muted/60"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      className="shrink-0 text-xs text-muted hover:text-foreground"
                    >
                      ×
                    </button>
                  )}
                </div>
                <label
                  className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-muted"
                  title="ファイルが1件も入っていないフォルダを畳みます（削除はしません）。ジョブやアップロードの殻が大量に残るため既定でON。"
                >
                  <input
                    type="checkbox"
                    checked={hideEmpty}
                    onChange={(e) => setHideEmpty(e.target.checked)}
                    className="accent-neon-violet"
                  />
                  空フォルダを隠す
                </label>
              </div>
              <button
                type="button"
                onClick={() => {
                  setRootDirs(null);
                  setRootFiles(null);
                  setUsage(null);
                  loadRoot();
                }}
                className="flex shrink-0 items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
              >
                <RefreshCw size={12} />
                再読み込み
              </button>
            </div>

            {filesError && (
              <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {filesError}
              </p>
            )}

            {filesLoading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
                <Loader2 size={18} className="animate-spin" />
                読み込み中...
              </div>
            ) : rootEmpty ? (
              <div className="rounded-lg border border-border bg-background py-12 text-center text-xs text-muted">
                ファイルがありません。
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {visibleRootDirs.map((d) => (
                  <FolderRow
                    key={d.path}
                    path={d.path}
                    name={d.name}
                    depth={0}
                    onRemoved={handleRootFolderRemoved}
                    sort={sort}
                    onSort={toggleSort}
                    query={query}
                    hideEmpty={hideEmpty}
                    stat={rootStats[d.path]}
                    label={rootLabels[d.name]}
                    statLoading={rootStatsLoading}
                    modifiedAt={d.modified_at}
                  />
                ))}
                {rootHiddenEmpty > 0 && (
                  <p className="text-[11px] text-muted opacity-60">
                    空フォルダ {rootHiddenEmpty} 件を非表示にしています。
                  </p>
                )}
                {visibleRootFiles.length > 0 && (
                  <FileTable
                    files={visibleRootFiles}
                    deletingPath={deletingRootFilePath}
                    onDeleteFile={handleDeleteRootFile}
                    sort={sort}
                    onSort={toggleSort}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 1. GPU selection reference — static, collapsed by default */}
      <GpuCostReferenceCard />

      {/* 2. ローカルアップロード（リモートダウンローダの手前 — 手元のファイルを
             送るケースの方が迷いやすいので先に見せる） */}
      <VolumeUploadPanel
        onUploaded={() => {
          setRootDirs(null);
          setRootFiles(null);
          loadRoot();
        }}
      />

      {/* 3. Remote downloader */}
      <div className="rounded-2xl border-gradient bg-surface/40 p-6">
        <h3 className="mb-4 flex items-center gap-2 text-sm font-bold text-foreground">
          <Download size={16} className="text-neon-violet" />
          リモートダウンローダー
        </h3>

        <div className="mb-3 flex gap-2">
          {(
            [
              { id: "file", label: "単一ファイルURL" },
              { id: "repo", label: "HFリポジトリ一括" },
            ] as const
          ).map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => {
                setDownloadMode(mode.id);
                setDownloadNotice(null);
              }}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                downloadMode === mode.id
                  ? "border-neon-pink/40 bg-neon-pink/10 text-neon-pink"
                  : "border-border bg-background text-muted hover:border-neon-violet/40 hover:text-foreground"
              }`}
            >
              {mode.label}
            </button>
          ))}
        </div>

        {downloadMode === "file" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <input
                type="text"
                value={downloadUrl}
                onChange={(e) => {
                  const value = e.target.value;
                  setDownloadUrl(value);
                  // Auto-fill save path from the URL itself (e.g. .../diffusion_models/model.safetensors)
                  // so pasting a model URL is enough — the admin can still edit either field afterward.
                  const { subfolder, filename } = extractDownloadInfo(value);
                  if (subfolder) setDownloadSubfolder(subfolder);
                  if (filename) setDownloadFilename(filename);
                }}
                placeholder="https://huggingface.co/... または https://civitai.com/..."
                className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
              />
              <select
                value={downloadSubfolder}
                onChange={(e) => setDownloadSubfolder(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none transition-colors focus:border-neon-violet/50"
              >
                {MODEL_SUBFOLDERS.map((sub) => (
                  <option key={sub} value={sub}>
                    {sub}
                  </option>
                ))}
              </select>
            </div>
            <input
              type="text"
              value={downloadFilename}
              onChange={(e) => setDownloadFilename(e.target.value)}
              placeholder="保存ファイル名（例: my_model.safetensors）"
              className="mt-3 w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
            />
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading || !downloadUrl.trim() || !downloadFilename.trim()}
              className="mt-3 flex items-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-5 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              ⚡ Modalへ直接ダウンロード
            </button>
            <p className="mt-2 text-[11px] text-muted">
              許可ドメイン: huggingface.co / civitai.com のみ。ダウンロードは Modal
              側でバックグラウンド実行され、このサーバーは経由しません。URLを貼り付けると保存先フォルダとファイル名を自動入力します。
            </p>
          </>
        ) : (
          <>
            <input
              type="text"
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              placeholder="リポジトリID（例: hotdogs/Qwen3.8-27B-Abliterated）"
              className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
            />
            <input
              type="text"
              value={repoSaveDir}
              onChange={(e) => setRepoSaveDir(e.target.value)}
              placeholder="保存先ディレクトリ（例: LLM/Qwen3.8-27B-Abliterated/）"
              className="mt-3 w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
            />
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading || !repoId.trim() || !repoSaveDir.trim()}
              className="mt-3 flex items-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-5 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              ⚡ リポジトリを一括ダウンロード
            </button>
            <p className="mt-2 text-[11px] text-muted">
              Hugging Face のリポジトリ全体（分割モデル等）を、Volume内の指定ディレクトリへまとめてダウンロードします。
              huggingface.co 上の公開リポジトリのみ対応です。
            </p>
          </>
        )}
        {downloadNotice && (
          <p
            className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
              downloadNotice.kind === "success"
                ? "border-neon-pink/30 bg-neon-pink/10 text-neon-pink"
                : "border-red-500/30 bg-red-500/10 text-red-400"
            }`}
          >
            {downloadNotice.text}
          </p>
        )}
      </div>

      {/* 3. Download task progress panel */}
      <DownloadTasksPanel refreshSignal={downloadTasksRefresh} />

      {/* 4. Custom node management */}
      <div className="rounded-2xl border-gradient bg-surface/40 p-6">
        <h3 className="mb-4 flex items-center gap-2 text-sm font-bold text-foreground">
          <GitBranch size={16} className="text-neon-violet" />
          カスタムノード管理
        </h3>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            placeholder="https://github.com/user/repo"
            className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
          />
          <button
            type="button"
            onClick={handleInstallNode}
            disabled={installing || !gitUrl.trim()}
            className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-5 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {installing ? <Loader2 size={16} className="animate-spin" /> : <GitBranch size={16} />}
            📦 ノードをインストール
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          許可ドメイン: github.com のみ。導入したノードは次回の生成リクエストから有効になります（実行中のコンテナへの即時反映ではありません）。
        </p>
        {installNotice && (
          <p
            className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
              installNotice.kind === "success"
                ? "border-neon-pink/30 bg-neon-pink/10 text-neon-pink"
                : "border-red-500/30 bg-red-500/10 text-red-400"
            }`}
          >
            {installNotice.text}
          </p>
        )}
      </div>
    </div>
  );
}
