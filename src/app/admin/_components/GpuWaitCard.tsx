"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Cpu, RefreshCw } from "lucide-react";

// GPU 待ちの見張り（2026-10-01）。created_at → processing_started_at が種別ごとの基準（過去 7 日 p90 の 1.5 倍、
// 最低 2 分）を超えたら、Modal の同時 GPU 上限（10 台）が埋まり始めた兆候として赤く出す。判定は API 側。

type GpuWaitData = {
  generatedAt: string;
  gpuLimit: number;
  running: number;
  waiting: { id: string; kind: string; createdAt: string; ageSeconds: number; alert: boolean }[];
  stats: {
    kind: string;
    baselineCount: number;
    baselineP50: number | null;
    baselineP90: number | null;
    recentCount: number;
    recentP50: number | null;
    recentMax: number | null;
    alertAtSeconds: number;
  }[];
  slowRecent: { id: string; kind: string; createdAt: string; waitSeconds: number }[];
};

const fmt = (s: number | null) => {
  if (s == null) return "—";
  if (s < 60) return `${Math.round(s)}秒`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return r ? `${m}分${r}秒` : `${m}分`;
};
const hhmm = (iso: string) =>
  new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function GpuWaitCard() {
  const [data, setData] = useState<GpuWaitData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch("/api/admin/gpu-wait");
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setData(body as GpuWaitData);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 初回と 30 秒おきに取り直す（fetch の完了で state を更新する。effect 内の同期 setState ではない）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(true);
    const t = setInterval(() => void load(true), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const alerting = data?.waiting.filter((w) => w.alert) ?? [];
  const nearLimit = data ? data.running >= data.gpuLimit - 2 : false;
  const hot = alerting.length > 0 || nearLimit;

  return (
    <div
      className={`mb-4 rounded-xl border px-4 py-3 text-xs ${
        hot ? "border-red-500/40 bg-red-500/10" : "border-border bg-surface/40"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex items-center gap-1.5 font-mono font-medium text-foreground">
          <Cpu size={14} />
          GPU 待ちの見張り
        </span>
        {data && (
          <>
            <span className={nearLimit ? "text-red-300" : "text-muted"}>
              実行中 {data.running} / 上限 {data.gpuLimit} 台
            </span>
            <span className={alerting.length ? "text-red-300" : "text-muted"}>
              GPU 待ち {data.waiting.length} 件{alerting.length ? `（うち長い待ち ${alerting.length} 件）` : ""}
            </span>
            <span className="text-muted">更新 {hhmm(data.generatedAt)}・30 秒ごと</span>
          </>
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-muted hover:border-neon-violet/40 disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          更新
        </button>
      </div>

      {error && <p className="mt-2 text-red-300">読み込みに失敗しました: {error}</p>}

      {hot && (
        <p className="mt-2 flex items-start gap-1.5 text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {nearLimit
            ? "実行中のジョブが同時 GPU の上限に近づいています。"
            : "いつもより GPU の起動待ちが長いジョブがあります。"}
          上限が埋まると新しいジョブは空くまで待たされます（Team プランで 50 台）。
        </p>
      )}

      {data && data.waiting.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {data.waiting.map((w) => (
            <li key={w.id} className={w.alert ? "text-red-300" : "text-muted"}>
              {w.kind}・{hhmm(w.createdAt)} 投入・待ち {fmt(w.ageSeconds)}
              <span className="ml-2 font-mono opacity-60">{w.id.slice(0, 8)}</span>
            </li>
          ))}
        </ul>
      )}

      {data && data.stats.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-muted">種別ごとの起動待ち（基準 = 過去 7 日）</summary>
          <table className="mt-2 w-full text-left">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-3 font-normal">種別</th>
                <th className="py-1 pr-3 font-normal">7 日 中央値</th>
                <th className="py-1 pr-3 font-normal">7 日 p90</th>
                <th className="py-1 pr-3 font-normal">24 時間 中央値</th>
                <th className="py-1 pr-3 font-normal">24 時間 最長</th>
                <th className="py-1 pr-3 font-normal">警告の目安</th>
              </tr>
            </thead>
            <tbody>
              {data.stats.map((s) => (
                <tr key={s.kind} className="border-t border-border/50">
                  <td className="py-1 pr-3">
                    {s.kind}
                    <span className="ml-1 text-muted">
                      （{s.baselineCount}件 / 24h {s.recentCount}件）
                    </span>
                  </td>
                  <td className="py-1 pr-3">{fmt(s.baselineP50)}</td>
                  <td className="py-1 pr-3">{fmt(s.baselineP90)}</td>
                  <td className="py-1 pr-3">{fmt(s.recentP50)}</td>
                  <td
                    className={`py-1 pr-3 ${s.recentMax != null && s.recentMax > s.alertAtSeconds ? "text-red-300" : ""}`}
                  >
                    {fmt(s.recentMax)}
                  </td>
                  <td className="py-1 pr-3">{fmt(s.alertAtSeconds)} 超</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.slowRecent.length > 0 && (
            <div className="mt-2">
              <p className="text-muted">直近 24 時間で待ちが長かったジョブ</p>
              <ul className="mt-1 space-y-0.5">
                {data.slowRecent.map((r) => (
                  <li key={r.id}>
                    {r.kind}・{hhmm(r.createdAt)}・待ち {fmt(r.waitSeconds)}
                    <span className="ml-2 font-mono text-muted">{r.id.slice(0, 8)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </details>
      )}
    </div>
  );
}
