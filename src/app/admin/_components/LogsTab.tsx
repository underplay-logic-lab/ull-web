"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  CheckCircle2,
  Coins,
  DollarSign,
  Film,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import type { GenerationLog, LogsSummary } from "./types";

function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { hour12: false });
}

function inferPreviewKind(filename: string): "image" | "video" {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return ext === "mp4" || ext === "webm" || ext === "mov" ? "video" : "image";
}

function OutputPreviewModal({ log, onClose }: { log: GenerationLog; onClose: () => void }) {
  if (typeof document === "undefined") return null;

  const src = `/api/admin/modal/storage/download?inline=1&file_path=${encodeURIComponent(log.output_file_name ?? "")}`;
  const kind = inferPreviewKind(log.output_file_name ?? "");

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 py-8 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border-gradient bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs text-muted">
            {formatDateTime(log.created_at)} — {log.job_type}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-muted transition-colors hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-black">
          {kind === "video" ? (
            <video src={src} controls autoPlay className="max-h-[70vh] w-full" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt="生成結果プレビュー" className="max-h-[70vh] w-full object-contain" />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function LogsTab() {
  const [logs, setLogs] = useState<GenerationLog[]>([]);
  const [summary, setSummary] = useState<LogsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);

  // Polls so a just-failed generation's error appears in the history table
  // without a manual reload.
  useEffect(() => {
    let cancelled = false;

    const load = async (isInitial: boolean) => {
      if (isInitial) setLoading(true);
      try {
        const res = await fetch("/api/admin/logs");
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました。");
        if (cancelled) return;
        setLogs(data.logs as GenerationLog[]);
        setSummary(data.summary as LogsSummary);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "取得に失敗しました。");
      } finally {
        if (!cancelled && isInitial) setLoading(false);
      }
    };

    load(true);
    const interval = setInterval(() => load(false), 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
        <Loader2 size={18} className="animate-spin" />
        読み込み中...
      </div>
    );
  }

  if (error) {
    return (
      <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>
    );
  }

  return (
    <div>
      {summary && (
        <div className="mb-8 grid gap-3 sm:grid-cols-4">
          <SummaryCard icon={<Activity size={16} />} label="総生成数" value={summary.totalCount.toLocaleString()} />
          <SummaryCard
            icon={<DollarSign size={16} />}
            label="Modal累計推定原価"
            value={`$${summary.totalModalCostUsd.toFixed(3)}`}
          />
          <SummaryCard
            icon={<Coins size={16} />}
            label="総消費クレジット"
            value={summary.totalCreditsConsumed.toLocaleString()}
          />
          <SummaryCard
            icon={<CheckCircle2 size={16} />}
            label="成功率"
            value={`${summary.successRate.toFixed(1)}%`}
          />
        </div>
      )}
      {summary?.scanLimited && (
        <p className="mb-4 text-xs text-muted">
          ※ サマリーは直近{summary.totalCount.toLocaleString()}件を集計しています。
        </p>
      )}

      <p className="mb-3 text-sm text-muted">直近ログ（降順 最大50件）</p>

      {logs.length === 0 ? (
        <div className="rounded-2xl border-gradient bg-surface/40 px-6 py-16 text-center text-sm text-muted">
          ログがまだありません。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface/60 text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">日時</th>
                <th className="px-4 py-3 font-medium">ユーザー</th>
                <th className="px-4 py-3 font-medium">ジョブ種別</th>
                <th className="px-4 py-3 font-medium">入力プロンプト</th>
                <th className="px-4 py-3 font-medium">実行時間</th>
                <th className="px-4 py-3 font-medium">消費クレジット</th>
                <th className="px-4 py-3 font-medium">状態</th>
                <th className="px-4 py-3 font-medium">エラー</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-border/60 last:border-0 hover:bg-surface-hover/40">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">
                    {formatDateTime(log.created_at)}
                  </td>
                  <td className="max-w-[200px] truncate px-4 py-3 text-xs text-muted" title={log.user_email ?? log.user_id}>
                    {log.user_email ?? log.user_id}
                  </td>
                  <td className="px-4 py-3 text-foreground">{log.job_type}</td>
                  <td className="max-w-[220px] truncate px-4 py-3 text-xs text-muted" title={log.prompt_input ?? undefined}>
                    {log.prompt_input ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-muted">{formatDuration(log.execution_time_ms)}</td>
                  <td className="px-4 py-3 text-muted">{log.credits_consumed ?? "-"}</td>
                  <td className="px-4 py-3">
                    {log.status === "success" ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-neon-pink">
                        <CheckCircle2 size={14} />
                        成功
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
                        <XCircle size={14} />
                        失敗
                      </span>
                    )}
                  </td>
                  <td className="max-w-[240px] truncate px-4 py-3 text-xs text-muted">
                    {log.error_message ?? "-"}
                  </td>
                  <td className="px-4 py-3">
                    {log.output_file_name && (
                      <button
                        type="button"
                        onClick={() => setPreviewLog(log)}
                        className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
                      >
                        <Film size={12} />
                        プレビュー
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {previewLog && <OutputPreviewModal log={previewLog} onClose={() => setPreviewLog(null)} />}
    </div>
  );
}

function SummaryCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border-gradient bg-surface/40 p-4">
      <div className="flex items-center gap-2 text-neon-violet">
        {icon}
        <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      </div>
      <div className="mt-2 font-mono text-xl font-bold text-foreground">{value}</div>
    </div>
  );
}
