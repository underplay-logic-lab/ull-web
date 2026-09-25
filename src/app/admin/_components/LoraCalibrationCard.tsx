"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw } from "lucide-react";

// LoRA の見積もりと実績の比較（2026-09-26）。前提の 1 step 秒数（loraRuntime.ts の LORA_SPI_BASELINE）と、
// 実ジョブの実測を arch ごとに並べる。直すかどうかは人が決める（/api/admin/lora-calibration の冒頭コメント参照）。

type Recent = {
  id: string;
  createdAt: string;
  gpuTier: string;
  sameTier: boolean;
  measuredSpi: number | null;
  normalizedSpi: number | null;
  measuredPrepS: number | null;
  estimatedPrepS: number | null;
  actualTotalS: number | null;
  estimatedTotalS: number | null;
  credits: number;
};
type Row = {
  arch: string;
  speed: "standard" | "fast";
  gpuTier: string;
  jobs: number;
  comparable: number;
  baselineSpi: number;
  medianMeasuredSpi: number | null;
  minMeasuredSpi: number | null;
  maxMeasuredSpi: number | null;
  suggestedSpi: number | null;
  ratio: number | null;
  prepRatio: number | null;
  chargeRatio: number | null;
  status: "over" | "under" | "ok" | "no_data";
  recent: Recent[];
};
type Feature = {
  jobType: string;
  gpuTier: string;
  count: number;
  failed: number;
  revenueJpy: number;
  costJpy: number;
  failedCostJpy: number;
  markup: number | null;
  medianMarkup: number | null;
  minMarkup: number | null;
  maxMarkup: number | null;
  negative: number;
  low: number;
  status: "negative" | "low" | "ok" | "no_data";
};
type Resp = {
  days: number;
  targetMargin: number;
  overRatio: number;
  underRatio: number;
  rows: Row[];
  featureDays: number;
  lowMarginPercent: number;
  features: Feature[];
};

const JOB_LABEL: Record<string, string> = {
  lora_training: "LoRA 学習",
  upscale_image: "超解像（画像）",
  upscale_video: "超解像（動画）",
  multi_angle: "Multi-Angle",
  director: "Director",
  lora_caption: "LoRA キャプション作成",
  lora_wd_tags: "構図判定（無料）",
};
const F_STATUS: Record<Feature["status"], { label: string; cls: string }> = {
  negative: { label: "赤字あり", cls: "border-red-500/50 bg-red-500/10 text-red-300" },
  low: { label: "低粗利あり", cls: "border-amber-500/50 bg-amber-500/10 text-amber-300" },
  ok: { label: "問題なし", cls: "border-green-500/40 bg-green-500/10 text-green-300" },
  no_data: { label: "売上なし", cls: "border-border text-muted" },
};
const yen = (v: number) => `¥${v.toLocaleString()}`;

const STATUS: Record<Row["status"], { label: string; cls: string }> = {
  over: { label: "取りすぎ", cls: "border-amber-500/50 bg-amber-500/10 text-amber-300" },
  under: { label: "見積もり不足", cls: "border-red-500/50 bg-red-500/10 text-red-300" },
  ok: { label: "目安どおり", cls: "border-green-500/40 bg-green-500/10 text-green-300" },
  no_data: { label: "実測なし", cls: "border-border text-muted" },
};

const fmt = (v: number | null, d = 2) => (v == null ? "—" : v.toFixed(d));
const x = (v: number | null) => (v == null ? "—" : `×${v.toFixed(2)}`);

export function LoraCalibrationCard() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/lora-calibration");
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "取得に失敗しました。");
      setData(json as Resp);
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
    <section className="mb-8 rounded-2xl border border-neon-violet/30 bg-neon-violet/5 p-4">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">見積もりと実績（価格が原価に合っているかの点検）</h3>
        <button
          type="button"
          onClick={() => void load()}
          className="flex items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
        >
          <RefreshCw size={12} />
          再読み込み
        </button>
      </div>
      {error && (
        <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>
      )}
      {!loading && data && data.features.length > 0 && (
        <>
          <h4 className="mb-1 mt-2 text-xs font-semibold text-foreground">機能ごとの売上と GPU 原価（直近 {data.featureDays} 日・成功分）</h4>
          <p className="mb-2 text-xs leading-relaxed text-muted">
            実行ログから、機能 × GPU ごとに「売上 ÷ 原価」（倍率）を出します。原価は実稼働ログと同じ計算（GPU 時給 × 実行時間）。
            1 件でも赤字（倍率 1 未満）があれば「赤字あり」、粗利 {data.lowMarginPercent}% 未満があれば「低粗利あり」。失敗の原価は返金で売上 0 なので別の列。
            構図判定は無料なので売上は無く、原価だけが出ます（2026-09-26 以降の分）。
          </p>
          <div className="mb-5 overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-surface/60 text-muted">
                  <th className="px-3 py-2 font-medium">機能（GPU）</th>
                  <th className="px-3 py-2 font-medium">判定</th>
                  <th className="px-3 py-2 text-right font-medium">件数</th>
                  <th className="px-3 py-2 text-right font-medium">売上</th>
                  <th className="px-3 py-2 text-right font-medium">原価</th>
                  <th className="px-3 py-2 text-right font-medium">倍率（合計）</th>
                  <th className="px-3 py-2 text-right font-medium">1 件ごとの倍率（中央値・範囲）</th>
                  <th className="px-3 py-2 text-right font-medium">失敗（件・原価）</th>
                </tr>
              </thead>
              <tbody>
                {data.features.map((f) => {
                  const st = F_STATUS[f.status];
                  return (
                    <tr key={`${f.jobType}|${f.gpuTier}`} className="border-b border-border/50">
                      <td className="px-3 py-2 text-foreground">
                        {JOB_LABEL[f.jobType] ?? f.jobType}
                        <span className="ml-1 font-mono text-muted">{f.gpuTier}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${st.cls}`}>
                          {f.status === "ok" ? <Check size={10} /> : f.status === "no_data" ? null : <AlertTriangle size={10} />}
                          {st.label}
                          {f.status === "negative" && `（${f.negative} 件）`}
                          {f.status === "low" && `（${f.low} 件）`}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-muted">{f.count}</td>
                      <td className="px-3 py-2 text-right font-mono">{yen(f.revenueJpy)}</td>
                      <td className="px-3 py-2 text-right font-mono">{yen(f.costJpy)}</td>
                      <td className="px-3 py-2 text-right font-mono">{x(f.markup)}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {x(f.medianMarkup)}
                        {f.count > 1 && f.minMarkup != null && (
                          <span className="ml-1 text-muted">
                            （{f.minMarkup.toFixed(1)}〜{f.maxMarkup?.toFixed(1)}）
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-muted">
                        {f.failed ? `${f.failed} 件・${yen(f.failedCostJpy)}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h4 className="mb-1 text-xs font-semibold text-foreground">LoRA の 1 step 秒数（課金の前提と実測）</h4>
      <p className="mb-3 text-xs leading-relaxed text-muted">
        課金の見積もりに使う「1 step の秒数」（コードの固定値 <code>LORA_SPI_BASELINE</code>）と、直近
        {data?.days ?? 90} 日の完了ジョブの実測を、モデルごとに並べます。実測は解像度・バッチ・rank を基準条件（1024px・バッチ
        1・rank 32）に直してあります。前提は「実測 +{Math.round(((data?.targetMargin ?? 1.2) - 1) * 100)}%」が約束で、前提が実測の
        {data?.overRatio ?? 1.5} 倍を超えたら「取りすぎ」、実測を下回ったら「見積もり不足」（損切りが早く発動し得る）と出します。
        直すときはコード（<code>loraRuntime.ts</code> と <code>lora_worker_core.py</code>）を変えます。自動では変わりません。
      </p>
      {loading ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted">
          <Loader2 size={14} className="animate-spin" /> 読み込み中...
        </div>
      ) : !data || data.rows.length === 0 ? (
        <p className="text-xs text-muted">比べられる完了ジョブがありません。</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead>
              <tr className="border-b border-border bg-surface/60 text-muted">
                <th className="px-3 py-2 font-medium">モデル（tier）</th>
                <th className="px-3 py-2 font-medium">判定</th>
                <th className="px-3 py-2 text-right font-medium">前提 s/it</th>
                <th className="px-3 py-2 text-right font-medium">実測 s/it（中央値・範囲）</th>
                <th className="px-3 py-2 text-right font-medium">前提 ÷ 実測</th>
                <th className="px-3 py-2 text-right font-medium">目安（実測+20%）</th>
                <th className="px-3 py-2 text-right font-medium" title="今の前提での準備時間 ÷ 実測の準備時間">
                  準備時間 見積÷実測
                </th>
                <th className="px-3 py-2 text-right font-medium" title="課金したときの見積もり秒 ÷ 実際の処理時間（当時の前提）">
                  当時の請求 見積÷実時間
                </th>
                <th className="px-3 py-2 text-right font-medium">件数</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const key = `${r.arch}|${r.speed}`;
                const st = STATUS[r.status];
                return (
                  <FragmentRow key={key}>
                    <tr
                      className="cursor-pointer border-b border-border/50 hover:bg-surface/40"
                      onClick={() => setOpen((o) => (o === key ? null : key))}
                    >
                      <td className="px-3 py-2 font-mono text-foreground">
                        {r.arch}
                        {r.speed === "fast" && <span className="ml-1 text-neon-violet">（高速）</span>}
                        <span className="ml-1 text-muted">{r.gpuTier}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${st.cls}`}>
                          {r.status === "ok" ? <Check size={10} /> : r.status === "no_data" ? null : <AlertTriangle size={10} />}
                          {st.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(r.baselineSpi)}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {fmt(r.medianMeasuredSpi, 3)}
                        {r.comparable > 1 && (
                          <span className="ml-1 text-muted">
                            （{fmt(r.minMeasuredSpi, 2)}〜{fmt(r.maxMeasuredSpi, 2)}）
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{x(r.ratio)}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(r.suggestedSpi)}</td>
                      <td className="px-3 py-2 text-right font-mono">{x(r.prepRatio)}</td>
                      <td className="px-3 py-2 text-right font-mono">{x(r.chargeRatio)}</td>
                      <td className="px-3 py-2 text-right text-muted">
                        {r.comparable}/{r.jobs}
                      </td>
                    </tr>
                    {open === key && (
                      <tr className="border-b border-border/50 bg-background/40">
                        <td colSpan={9} className="px-3 py-2">
                          <p className="mb-1 text-[10px] text-muted">
                            直近 {r.recent.length} 件（件数の「比較可/全体」は、今の前提と同じ tier で s/it が記録されたジョブ数）
                          </p>
                          <table className="w-full text-[10px]">
                            <thead className="text-muted">
                              <tr>
                                <th className="py-1 pr-2 text-left font-medium">ジョブ</th>
                                <th className="py-1 pr-2 text-left font-medium">tier</th>
                                <th className="py-1 pr-2 text-right font-medium">実測 s/it（基準条件）</th>
                                <th className="py-1 pr-2 text-right font-medium">準備 実測/見積（秒）</th>
                                <th className="py-1 pr-2 text-right font-medium">全体 実時間/当時の見積（秒）</th>
                                <th className="py-1 text-right font-medium">請求 C</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.recent.map((j) => (
                                <tr key={j.id} className={j.sameTier ? "" : "opacity-50"}>
                                  <td className="py-0.5 pr-2 font-mono">
                                    {j.id.slice(0, 8)} <span className="text-muted">{j.createdAt.slice(0, 10)}</span>
                                  </td>
                                  <td className="py-0.5 pr-2">{j.gpuTier || "—"}{!j.sameTier && "（別 tier・比較外）"}</td>
                                  <td className="py-0.5 pr-2 text-right font-mono">
                                    {fmt(j.measuredSpi, 3)}（{fmt(j.normalizedSpi, 3)}）
                                  </td>
                                  <td className="py-0.5 pr-2 text-right font-mono">
                                    {j.measuredPrepS ?? "—"} / {j.estimatedPrepS ?? "—"}
                                  </td>
                                  <td className="py-0.5 pr-2 text-right font-mono">
                                    {j.actualTotalS ?? "—"} / {j.estimatedTotalS ?? "—"}
                                  </td>
                                  <td className="py-0.5 text-right font-mono">{j.credits}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
