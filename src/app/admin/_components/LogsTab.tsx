"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Coins,
  DollarSign,
  Download,
  Film,
  Loader2,
  RefreshCw,
  TrendingUp,
  X,
  XCircle,
} from "lucide-react";
import type { GenerationLog, GenerationLogEntry, LogsAlert, LogsSummary } from "./types";

function formatJpy(value: number): string {
  return `¥${Math.round(value).toLocaleString()}`;
}

function formatMargin(percent: number | null): string {
  if (percent === null) return "-";
  return `${percent.toFixed(0)}%`;
}

function marginColorClass(percent: number | null, thresholdPercent: number): string {
  if (percent === null) return "text-muted";
  if (percent < 0) return "text-red-400 font-semibold";
  if (percent < thresholdPercent) return "text-amber-400";
  return "text-muted";
}

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

// 期間の選択肢（JST の日境界）。「今日」は JST 0 時から今まで。
type RangePreset = "today" | "yesterday" | "7d" | "30d" | "custom";
const JST = 9 * 3600_000;
function jstDayStart(offsetDays: number): Date {
  const now = new Date(Date.now() + JST);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays) - JST);
}
function rangeOf(preset: RangePreset, customFrom: string, customTo: string): { from: string; to: string } {
  const end = new Date(Date.now() + 60_000).toISOString();
  switch (preset) {
    case "today":
      return { from: jstDayStart(0).toISOString(), to: end };
    case "yesterday":
      return { from: jstDayStart(-1).toISOString(), to: jstDayStart(0).toISOString() };
    case "30d":
      return { from: jstDayStart(-29).toISOString(), to: end };
    case "custom": {
      // 日付入力（YYYY-MM-DD、JST）。終了日はその日の終わりまで含める。
      const f = customFrom
        ? new Date(Date.parse(`${customFrom}T00:00:00+09:00`)).toISOString()
        : jstDayStart(-6).toISOString();
      const t = customTo ? new Date(Date.parse(`${customTo}T00:00:00+09:00`) + 24 * 3600_000).toISOString() : end;
      return { from: f, to: t };
    }
    default:
      return { from: jstDayStart(-6).toISOString(), to: end };
  }
}

const JOB_TYPES = ["lora_training", "upscale_image", "upscale_video", "multi_angle", "director", "custom_workflow"];

type LogsResponse = {
  page: number;
  pageSize: number;
  totalEntries: number;
  totalRows: number;
  truncated: boolean;
  entries: GenerationLogEntry[];
  summary: LogsSummary;
  alert: LogsAlert;
};

// admin「実稼働ログ & 粗利監視」（2026-09-25 に作り直し、ホスト指摘「50 件しか見えず、何日分かも分からず、
// CSV にも出せない」）。期間・機能・状態・ユーザーで絞り、その範囲の集計・ページ送り・CSV 書き出しができる。
// 超解像の「まとめて処理」は 1 行に畳み、開くと 1 枚ずつ見られる。
export function LogsTab() {
  const [preset, setPreset] = useState<RangePreset>("7d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [email, setEmail] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
  const [openBatches, setOpenBatches] = useState<Set<string>>(new Set());

  const params = useCallback(() => {
    const r = rangeOf(preset, customFrom, customTo);
    const p = new URLSearchParams({ from: r.from, to: r.to, page: String(page) });
    if (type) p.set("type", type);
    if (status) p.set("status", status);
    if (email) p.set("email", email);
    return p;
  }, [preset, customFrom, customTo, type, status, email, page]);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const res = await fetch(`/api/admin/logs?${params().toString()}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error ?? "取得に失敗しました。");
        setData(json as LogsResponse);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "取得に失敗しました。");
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [params],
  );

  useEffect(() => {
    // 条件が変わったら取り直す（fetch の完了で state を更新する。effect 内の同期 setState ではない）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // 1 ページ目を見ている間だけ 30 秒おきに取り直す（失敗したジョブがすぐ出るように。以前は 5 秒・50 件固定）。
  useEffect(() => {
    if (page !== 1) return;
    const t = setInterval(() => void load(true), 30_000);
    return () => clearInterval(t);
  }, [load, page]);

  const resetPage = () => setPage(1);
  const csvParams = params();
  csvParams.delete("page");
  csvParams.set("format", "csv");
  const csvHref = `/api/admin/logs?${csvParams.toString()}`;

  const summary = data?.summary;
  const alert = data?.alert;
  const totalPages = data ? Math.max(1, Math.ceil(data.totalEntries / data.pageSize)) : 1;
  const threshold = alert?.thresholdPercent ?? 30;
  const selectCls =
    "rounded-lg border border-border bg-background/70 px-2 py-1.5 text-xs text-foreground outline-none focus:border-neon-violet/50";

  return (
    <div>
      {alert && (alert.negativeMarginCount > 0 || alert.lowMarginCount > 0) && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p>
            直近{alert.windowHours}時間で、原価割れ {alert.negativeMarginCount}件 / 粗利率
            {alert.thresholdPercent}%未満 {alert.lowMarginCount}件 のジョブがあります（成功分）。
          </p>
        </div>
      )}

      {/* 絞り込み */}
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface/40 p-3">
        <div className="flex flex-wrap gap-1">
          {(
            [
              ["today", "今日"],
              ["yesterday", "昨日"],
              ["7d", "7日"],
              ["30d", "30日"],
              ["custom", "日付指定"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                setPreset(v);
                resetPage();
              }}
              className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                preset === v
                  ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                  : "border-border text-muted hover:border-neon-violet/40"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <span className="flex items-center gap-1 text-xs text-muted">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => {
                setCustomFrom(e.target.value);
                resetPage();
              }}
              className={selectCls}
            />
            〜
            <input
              type="date"
              value={customTo}
              onChange={(e) => {
                setCustomTo(e.target.value);
                resetPage();
              }}
              className={selectCls}
            />
          </span>
        )}
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            resetPage();
          }}
          className={selectCls}
        >
          <option value="">すべての機能</option>
          {JOB_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            resetPage();
          }}
          className={selectCls}
        >
          <option value="">成功・失敗</option>
          <option value="success">成功のみ</option>
          <option value="failed">失敗のみ</option>
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setEmail(emailInput.trim());
            resetPage();
          }}
          className="flex items-center gap-1"
        >
          <input
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="ユーザー（メールの一部）"
            className={`${selectCls} w-48`}
          />
          <button
            type="submit"
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted hover:text-foreground"
          >
            絞る
          </button>
        </form>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted hover:text-foreground"
          >
            <RefreshCw size={12} />
            更新
          </button>
          <a
            href={csvHref}
            className="inline-flex items-center gap-1 rounded-lg border border-neon-violet/40 bg-neon-violet/10 px-2.5 py-1.5 text-xs font-medium text-neon-violet hover:bg-neon-violet/20"
          >
            <Download size={12} />
            CSV で書き出す（{data ? data.totalRows.toLocaleString() : "-"} 行）
          </a>
        </span>
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>
      )}

      {summary && (
        <>
          <div className="mb-3 grid gap-3 sm:grid-cols-5">
            <SummaryCard
              icon={<Activity size={16} />}
              label="生成数"
              value={summary.totalCount.toLocaleString()}
              sub={`成功 ${summary.successCount} / 失敗 ${summary.failedCount}`}
            />
            <SummaryCard
              icon={<Coins size={16} />}
              label="消費クレジット"
              value={summary.totalCreditsConsumed.toLocaleString()}
              sub={`推定売上 ${formatJpy(summary.totalRevenueJpy)}`}
            />
            <SummaryCard
              icon={<DollarSign size={16} />}
              label="推定原価"
              value={formatJpy(summary.totalCostJpy)}
              sub={summary.failedCostJpy >= 1 ? `うち失敗分 ${formatJpy(summary.failedCostJpy)}` : undefined}
            />
            <SummaryCard icon={<TrendingUp size={16} />} label="粗利率" value={formatMargin(summary.marginPercent)} />
            <SummaryCard
              icon={<AlertTriangle size={16} />}
              label="低粗利 / 原価割れ（成功分）"
              value={`${summary.lowMarginCount} / ${summary.negativeMarginCount}件`}
            />
          </div>
          {summary.byJobType.length > 0 && (
            <p className="mb-6 text-[11px] text-muted">
              機能別（原価順）:{" "}
              {summary.byJobType
                .map((t) => `${t.jobType} ${t.count}件・${t.credits.toLocaleString()}C・${formatJpy(t.cost)}`)
                .join(" ／ ")}
            </p>
          )}
        </>
      )}
      {data?.truncated && (
        <p className="mb-4 text-xs text-amber-400">
          ※ 範囲内が多すぎるため、新しい順に {data.totalRows.toLocaleString()} 行までで集計しています。期間を絞ってください。
        </p>
      )}

      <div className="mb-2 flex items-center justify-between text-xs text-muted">
        <span>
          {data
            ? `全 ${data.totalEntries.toLocaleString()} 件中 ${
                data.totalEntries === 0 ? 0 : (data.page - 1) * data.pageSize + 1
              }〜${Math.min(data.page * data.pageSize, data.totalEntries)} 件目（まとめて処理は 1 件）`
            : ""}
          {loading && <Loader2 size={12} className="ml-2 inline animate-spin" />}
        </span>
        <Pager page={page} totalPages={totalPages} onChange={setPage} />
      </div>

      {data && data.entries.length === 0 ? (
        <div className="rounded-2xl border-gradient bg-surface/40 px-6 py-16 text-center text-sm text-muted">
          この条件のログはありません。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[1200px] text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface/60 text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">日時</th>
                <th className="px-4 py-3 font-medium">ユーザー</th>
                <th className="px-4 py-3 font-medium">ジョブ種別</th>
                <th className="px-4 py-3 font-medium">入力プロンプト</th>
                <th className="px-4 py-3 font-medium">実行時間</th>
                <th className="px-4 py-3 font-medium">GPU</th>
                <th className="px-4 py-3 font-medium">消費クレジット</th>
                <th className="px-4 py-3 font-medium">原価</th>
                <th className="px-4 py-3 font-medium">粗利率</th>
                <th className="px-4 py-3 font-medium">状態</th>
                <th className="px-4 py-3 font-medium">エラー</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {(data?.entries ?? []).map((entry) => {
                if (entry.kind === "row") {
                  return <LogRow key={entry.key} log={entry.log} threshold={threshold} onPreview={setPreviewLog} />;
                }
                const b = entry.batch;
                const open = openBatches.has(entry.key);
                return [
                  <tr
                    key={entry.key}
                    onClick={() =>
                      setOpenBatches((prev) => {
                        const next = new Set(prev);
                        if (next.has(entry.key)) next.delete(entry.key);
                        else next.add(entry.key);
                        return next;
                      })
                    }
                    className="cursor-pointer border-b border-border/60 bg-neon-violet/[0.04] hover:bg-surface-hover/40"
                  >
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">
                      {open ? (
                        <ChevronDown size={12} className="mr-1 inline" />
                      ) : (
                        <ChevronRight size={12} className="mr-1 inline" />
                      )}
                      {formatDateTime(b.created_at)}
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-3 text-xs text-muted" title={b.user_email ?? b.user_id}>
                      {b.user_email ?? b.user_id}
                    </td>
                    <td className="px-4 py-3 text-foreground">
                      {b.job_type}
                      <span className="ml-1 text-xs text-neon-violet">まとめて {b.count}枚</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">-</td>
                    <td className="px-4 py-3 text-muted">{formatDuration(b.execution_time_ms)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{b.gpu_tier_label ?? "-"}</td>
                    <td className="px-4 py-3 text-muted">{b.credits_consumed}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{formatJpy(b.cost_jpy)}</td>
                    <td className={`whitespace-nowrap px-4 py-3 text-xs ${marginColorClass(b.margin_percent, threshold)}`}>
                      {formatMargin(b.margin_percent)}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className="text-neon-pink">成功 {b.success}</span>
                      {b.failed > 0 && <span className="ml-1 text-red-400">失敗 {b.failed}</span>}
                    </td>
                    <td className="max-w-[240px] truncate px-4 py-3 text-xs text-muted">
                      {b.items.find((i) => i.error_message)?.error_message ?? "-"}
                    </td>
                    <td />
                  </tr>,
                  ...(open
                    ? b.items.map((log) => (
                        <LogRow key={log.id} log={log} threshold={threshold} onPreview={setPreviewLog} nested />
                      ))
                    : []),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <Pager page={page} totalPages={totalPages} onChange={setPage} />
      </div>

      {previewLog && <OutputPreviewModal log={previewLog} onClose={() => setPreviewLog(null)} />}
    </div>
  );
}

function Pager({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null;
  const btn = "rounded-lg border border-border px-2 py-1 text-xs text-muted hover:text-foreground disabled:opacity-40";
  return (
    <span className="flex items-center gap-1">
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onChange(1)}>
        最初
      </button>
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onChange(page - 1)}>
        前へ
      </button>
      <span className="px-2 text-xs text-muted">
        {page} / {totalPages}
      </span>
      <button type="button" className={btn} disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        次へ
      </button>
      <button type="button" className={btn} disabled={page >= totalPages} onClick={() => onChange(totalPages)}>
        最後
      </button>
    </span>
  );
}

function LogRow({
  log,
  threshold,
  onPreview,
  nested = false,
}: {
  log: GenerationLog;
  threshold: number;
  onPreview: (log: GenerationLog) => void;
  nested?: boolean;
}) {
  return (
    <tr className={`border-b border-border/60 last:border-0 hover:bg-surface-hover/40 ${nested ? "bg-background/40" : ""}`}>
      <td className={`whitespace-nowrap px-4 py-3 font-mono text-xs text-muted ${nested ? "pl-10" : ""}`}>
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
      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{log.gpu_tier_label ?? "-"}</td>
      <td className="px-4 py-3 text-muted">{log.credits_consumed ?? "-"}</td>
      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{formatJpy(log.cost_jpy)}</td>
      <td className={`whitespace-nowrap px-4 py-3 text-xs ${marginColorClass(log.margin_percent, threshold)}`}>
        {formatMargin(log.margin_percent)}
      </td>
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
      <td className="max-w-[240px] truncate px-4 py-3 text-xs text-muted" title={log.error_message ?? undefined}>
        {log.error_message ?? "-"}
      </td>
      <td className="px-4 py-3">
        {log.output_file_name && (
          <button
            type="button"
            onClick={() => onPreview(log)}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
          >
            <Film size={12} />
            プレビュー
          </button>
        )}
      </td>
    </tr>
  );
}

function SummaryCard({ icon, label, value, sub }: { icon: ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border-gradient bg-surface/40 p-4">
      <div className="flex items-center gap-2 text-neon-violet">
        {icon}
        <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      </div>
      <div className="mt-2 font-mono text-xl font-bold text-foreground">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
