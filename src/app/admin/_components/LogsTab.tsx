"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  CheckCircle2,
  Coins,
  Cpu,
  DollarSign,
  Film,
  Loader2,
  Terminal,
  Trash2,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type { ActiveJob, GenerationLog, LogsSummary, ModalLogsResponse } from "./types";

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

function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString("ja-JP", { hour12: false });
}

function formatElapsed(startedAtIso: string, nowMs: number): string {
  const elapsedSec = Math.max(0, Math.floor((nowMs - new Date(startedAtIso).getTime()) / 1000));
  if (elapsedSec < 60) return `${elapsedSec}s`;
  const minutes = Math.floor(elapsedSec / 60);
  const seconds = elapsedSec % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function ActiveJobsList({
  jobs,
  onCleared,
}: {
  jobs: ActiveJob[];
  onCleared: (id: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [clearingId, setClearingId] = useState<string | null>(null);

  useEffect(() => {
    if (jobs.length === 0) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [jobs.length]);

  const handleForceClear = async (id: string) => {
    if (!window.confirm("このジョブの表示上の「実行中」記録だけをクリアします（Modal側のGPU処理自体は停止しません）。よろしいですか？")) {
      return;
    }
    setClearingId(id);
    try {
      const res = await fetch(`/api/admin/modal/logs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "クリアに失敗しました。");
      onCleared(id);
    } catch (err) {
      console.error("[ActiveJobsList] force-clear failed:", err);
    } finally {
      setClearingId(null);
    }
  };

  if (jobs.length === 0) {
    return (
      <div className="mb-4 rounded-xl border border-border bg-background px-4 py-6 text-center text-xs text-muted">
        現在実行中のジョブはありません。
      </div>
    );
  }

  return (
    <div className="mb-4 overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-surface/60 text-xs uppercase tracking-wide text-muted">
            <th className="px-4 py-2.5 font-medium">ユーザー</th>
            <th className="px-4 py-2.5 font-medium">GPU Tier</th>
            <th className="px-4 py-2.5 font-medium">ジョブ種別</th>
            <th className="px-4 py-2.5 font-medium">経過時間</th>
            <th className="px-4 py-2.5 font-medium" />
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="border-b border-border/60 last:border-0 hover:bg-surface-hover/40">
              <td className="max-w-[200px] truncate px-4 py-2.5 text-xs text-muted" title={job.user_email ?? job.user_id}>
                {job.user_email ?? job.user_id}
              </td>
              <td className="px-4 py-2.5">
                {job.gpu_tier === "ultra" ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-neon-violet/40 bg-neon-violet/10 px-2 py-0.5 text-[10px] text-neon-violet">
                    <Zap size={10} />
                    ULTRA
                  </span>
                ) : (
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted">
                    Standard
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5 text-foreground">{job.job_type}</td>
              <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-neon-pink">
                {formatElapsed(job.started_at, now)}
              </td>
              <td className="px-4 py-2.5 text-right">
                <button
                  type="button"
                  onClick={() => handleForceClear(job.id)}
                  disabled={clearingId === job.id}
                  title="表示上の「実行中」記録をクリアします（GPU処理自体は停止しません）"
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-red-400/50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {clearingId === job.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  強制クリア
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GpuTaskManager() {
  const [data, setData] = useState<ModalLogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Polls so a failure logged (or a job starting/finishing) while this tab
  // is open shows up without a manual page reload — GPU task list, running
  // counts, and the ComfyUI log console all come from this same response.
  useEffect(() => {
    let cancelled = false;

    const load = async (isInitial: boolean) => {
      if (isInitial) setLoading(true);
      try {
        const res = await fetch("/api/admin/modal/logs");
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error ?? "取得に失敗しました。");
        if (cancelled) return;
        setData(json as ModalLogsResponse);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Modalログの取得に失敗しました。");
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

  const handleJobCleared = (id: string) => {
    setData((prev) => {
      if (!prev) return prev;
      const clearedJob = prev.activeJobs.find((j) => j.id === id);
      if (!clearedJob) return prev;
      return {
        ...prev,
        activeJobs: prev.activeJobs.filter((j) => j.id !== id),
        gpuStatus: {
          ...prev.gpuStatus,
          [clearedJob.gpu_tier]: {
            ...prev.gpuStatus[clearedJob.gpu_tier],
            runningJobs: Math.max(0, prev.gpuStatus[clearedJob.gpu_tier].runningJobs - 1),
          },
        },
      };
    });
  };

  if (loading) {
    return (
      <div className="mb-8 flex items-center justify-center gap-2 rounded-2xl border-gradient bg-surface/40 py-10 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        GPUステータスを読み込み中...
      </div>
    );
  }

  if (error || !data) {
    return (
      <p className="mb-8 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
        {error ?? "GPUステータスの取得に失敗しました。"}
      </p>
    );
  }

  return (
    <div className="mb-8">
      <p className="mb-3 flex items-center gap-1.5 text-sm font-bold text-foreground">
        <Cpu size={15} className="text-neon-violet" />
        リアルタイムGPUタスクマネージャー
      </p>
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border-gradient bg-surface/40 p-4">
          <div className="flex items-center justify-between">
            <span className="font-mono text-sm font-bold text-foreground">{data.gpuStatus.standard.name}</span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted">Standard</span>
          </div>
          <p className="mt-2 text-xs text-muted">VRAM目安: {data.gpuStatus.standard.vramGb}GB</p>
          <p className="mt-1 text-xs text-neon-pink">実行中: {data.gpuStatus.standard.runningJobs}件</p>
        </div>
        <div className="rounded-2xl border-gradient bg-surface/40 p-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 font-mono text-sm font-bold text-foreground">
              <Zap size={13} className="text-neon-violet" />
              {data.gpuStatus.ultra.name}
            </span>
            <span className="rounded-full border border-neon-violet/40 bg-neon-violet/10 px-2 py-0.5 text-[10px] text-neon-violet">
              ULTRA
            </span>
          </div>
          <p className="mt-2 text-xs text-muted">VRAM目安: {data.gpuStatus.ultra.vramGb}GB</p>
          <p className="mt-1 text-xs text-neon-pink">実行中: {data.gpuStatus.ultra.runningJobs}件</p>
        </div>
      </div>

      <ActiveJobsList jobs={data.activeJobs} onCleared={handleJobCleared} />

      <p className="mb-2 flex items-center gap-1.5 text-sm font-bold text-foreground">
        <Terminal size={15} className="text-neon-violet" />
        ComfyUI実行ログコンソール
      </p>
      {data.comfyLogsUnavailable && (
        <p className="mb-2 text-xs text-muted">※ Modalからのログ取得に失敗したため空表示です。</p>
      )}
      <pre className="max-h-64 overflow-y-auto rounded-xl border border-border bg-black/80 p-3 font-mono text-[11px] leading-relaxed text-green-400">
        {data.comfyLogs.length === 0
          ? "ログがありません。"
          : data.comfyLogs
              .map((entry) => {
                const tier = entry.gpu_tier === "ultra" ? "ULTRA" : "STD";
                const mark = entry.status === "success" ? "OK" : "NG";
                const detail = entry.status === "success" ? entry.filename : entry.error;
                return `[${formatTs(entry.ts)}] [${tier}] [${mark}] ${entry.duration_s}s ${detail ?? ""}`;
              })
              .join("\n")}
      </pre>
    </div>
  );
}

export function LogsTab() {
  const [logs, setLogs] = useState<GenerationLog[]>([]);
  const [summary, setSummary] = useState<LogsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);

  // Polls so a just-failed generation's error appears in the history table
  // without a manual reload — same rationale as GpuTaskManager above.
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
      <GpuTaskManager />

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
