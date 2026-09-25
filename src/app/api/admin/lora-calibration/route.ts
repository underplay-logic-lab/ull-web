import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  LORA_SPI_BASELINE,
  loraArchGpuTier,
  loraFastOption,
  loraPrepLoadSeconds,
  loraPrepPerImageSeconds,
  type LoraSpeed,
} from "@/lib/pricing/loraRuntime";
import { makeRowCostJpy } from "@/lib/adminLogsSummary.server";

// admin「Pricing」— LoRA の見積もりと実績の比較（2026-09-26、ホスト判断）。
//
// 課金は「推定 GPU 秒 × 単価」で、推定の要になる 1 step 秒数（LORA_SPI_BASELINE）はコードの固定値。実ジョブの
// 実測（metadata.metrics.s_per_it / prep_s）は毎回記録されるが、前提へは自動で戻らない。minimax_h3 は前提 1.80 に
// 対し実測 0.31〜0.33 のまま放置され、原価の約 8 倍を請求していた。ここで arch ごとに並べて「ずれ」に気付けるようにする。
// 前提を直すかどうかは人が決める（自動で下げると、軽いジョブが続いたときに安く見積もりすぎて損切りが早撃ちになる）。
//
// 比べ方: ジョブごとに、見積もり時の内訳（inputs.training_config.price_breakdown）の「解像度・バッチ・rank 込みの 1 step 秒」
// と実測の s/it の比から、実測を「基準条件（1024px・バッチ1・rank32）の s/it」に直し、今のコードの前提と比べる。

const DAYS = 90;
const FEATURE_DAYS = 30;
// 前提は「実測 + 20%」で置く約束（loraRuntime.ts）。この範囲を外れたら目立たせる。
const TARGET_MARGIN = 1.2;
const OVER_RATIO = 1.5; // 前提が実測の 1.5 倍超 → 取りすぎ
const UNDER_RATIO = 1.0; // 前提が実測を下回る → 損切りが早撃ちになり得る

type Breakdown = {
  arch?: string;
  spi?: number;
  speed?: LoraSpeed;
  secondsPerStep?: number;
  prepSeconds?: number;
  totalSeconds?: number;
  imageCount?: number;
  gpuTier?: string;
  credits?: number;
};
type Metrics = { arch?: string; s_per_it?: number; prep_s?: number; raw_yaml?: boolean; images?: number };

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (v: number | null, d = 3) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("generation_jobs")
    .select(
      "id, created_at, processing_started_at, completed_at, credits_cost, metadata->metrics, " +
        "inputs->training_config->price_breakdown, inputs->dispatch->gpu_tier, inputs->dispatch->target_model",
    )
    .eq("workflow_type", "lora_training")
    .eq("status", "completed")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { rowCostJpy, knobs } = await makeRowCostJpy();

  type Job = {
    id: string;
    createdAt: string;
    arch: string;
    speed: LoraSpeed;
    gpuTier: string;
    /** 今の前提で回す tier と同じか（違う tier の実測は比べない）。 */
    sameTier: boolean;
    measuredSpi: number | null;
    /** 実測を基準条件（1024px・バッチ1・rank32）へ直した s/it。 */
    normalizedSpi: number | null;
    estimatedPrepS: number | null;
    measuredPrepS: number | null;
    estimatedTotalS: number | null;
    /** 処理開始〜完了の実時間（GPU コンテナ課金の近似）。 */
    actualTotalS: number | null;
    credits: number;
  };
  const jobs: Job[] = [];
  for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
    const m = (r.metrics ?? {}) as Metrics;
    if (m.raw_yaml) continue; // 生 YAML（admin 限定）は条件がばらばらなので比べない
    const b = (r.price_breakdown ?? {}) as Breakdown;
    const arch = String(b.arch ?? m.arch ?? r.target_model ?? "").trim().toLowerCase();
    if (!arch) continue;
    const speed: LoraSpeed = b.speed === "fast" ? "fast" : "standard";
    // tier の記録が無いのは tier の振り分け（2026-09-23）より前のジョブで、当時は全部 B300 だった。
    const gpuTier = String(r.gpu_tier ?? b.gpuTier ?? "b300");
    const expectedTier = loraArchGpuTier(arch, speed);
    const measuredSpi = typeof m.s_per_it === "number" && m.s_per_it > 0 ? m.s_per_it : null;
    const condFactor =
      typeof b.spi === "number" && b.spi > 0 && typeof b.secondsPerStep === "number" && b.secondsPerStep > 0
        ? b.secondsPerStep / b.spi
        : 1;
    const started = r.processing_started_at ? Date.parse(String(r.processing_started_at)) : NaN;
    const done = r.completed_at ? Date.parse(String(r.completed_at)) : NaN;
    const images = typeof b.imageCount === "number" ? b.imageCount : typeof m.images === "number" ? m.images : 0;
    jobs.push({
      id: String(r.id),
      createdAt: String(r.created_at),
      arch,
      speed,
      gpuTier,
      sameTier: gpuTier === expectedTier,
      measuredSpi,
      normalizedSpi: measuredSpi != null ? measuredSpi / condFactor : null,
      // 準備時間の見積もりは「今のコードの前提」で出し直す（当時の内訳ではなく、直すべき今の値と比べる）。
      estimatedPrepS: loraPrepLoadSeconds(arch, knobs) + loraPrepPerImageSeconds(arch, knobs) * images,
      measuredPrepS: typeof m.prep_s === "number" && m.prep_s > 0 ? m.prep_s : null,
      estimatedTotalS: typeof b.totalSeconds === "number" ? b.totalSeconds : null,
      actualTotalS: Number.isFinite(started) && Number.isFinite(done) && done > started ? (done - started) / 1000 : null,
      credits: Number(r.credits_cost ?? 0),
    });
  }

  // arch × speed ごとにまとめる。
  const groups = new Map<string, Job[]>();
  for (const j of jobs) {
    const k = `${j.arch}|${j.speed}`;
    groups.set(k, [...(groups.get(k) ?? []), j]);
  }
  const rows = [...groups.entries()].map(([k, list]) => {
    const [arch, speed] = k.split("|") as [string, LoraSpeed];
    const fast = speed === "fast" ? loraFastOption(arch) : null;
    const baseline = fast?.spi ?? LORA_SPI_BASELINE[arch] ?? knobs.lora_spi_baseline_default;
    const comparable = list.filter((j) => j.sameTier && j.normalizedSpi != null);
    const med = median(comparable.map((j) => j.normalizedSpi as number));
    const ratio = med ? baseline / med : null;
    const prepList = list.filter((j) => j.sameTier && j.measuredPrepS != null && j.estimatedPrepS);
    const prepRatio = median(prepList.map((j) => (j.estimatedPrepS as number) / (j.measuredPrepS as number)));
    const chargeList = list.filter((j) => j.actualTotalS && j.estimatedTotalS);
    const chargeRatio = median(chargeList.map((j) => (j.estimatedTotalS as number) / (j.actualTotalS as number)));
    const status: "over" | "under" | "ok" | "no_data" =
      ratio == null ? "no_data" : ratio > OVER_RATIO ? "over" : ratio < UNDER_RATIO ? "under" : "ok";
    return {
      arch,
      speed,
      gpuTier: loraArchGpuTier(arch, speed),
      jobs: list.length,
      comparable: comparable.length,
      baselineSpi: baseline,
      medianMeasuredSpi: round(med),
      minMeasuredSpi: round(comparable.length ? Math.min(...comparable.map((j) => j.normalizedSpi as number)) : null),
      maxMeasuredSpi: round(comparable.length ? Math.max(...comparable.map((j) => j.normalizedSpi as number)) : null),
      suggestedSpi: med ? round(med * TARGET_MARGIN, 2) : null,
      ratio: round(ratio, 2),
      prepRatio: round(prepRatio, 2),
      chargeRatio: round(chargeRatio, 2),
      status,
      recent: list.slice(0, 5).map((j) => ({
        id: j.id,
        createdAt: j.createdAt,
        gpuTier: j.gpuTier,
        sameTier: j.sameTier,
        measuredSpi: round(j.measuredSpi),
        normalizedSpi: round(j.normalizedSpi),
        measuredPrepS: round(j.measuredPrepS, 0),
        estimatedPrepS: round(j.estimatedPrepS, 0),
        actualTotalS: round(j.actualTotalS, 0),
        estimatedTotalS: round(j.estimatedTotalS, 0),
        credits: j.credits,
      })),
    };
  });
  const order = { over: 0, under: 1, ok: 2, no_data: 3 } as const;
  rows.sort((a, b) => order[a.status] - order[b.status] || b.jobs - a.jobs);

  // ---- LoRA 以外も含む、機能ごとの売上と原価（2026-09-26、ホスト要望「LoRA 以外も欲しい」）----
  // 超解像・Multi-Angle・Director は「1 step 秒数」のような前提を持たず、単価（knob）で課金している。ここでは
  // 実行ログ（generation_logs）から「売上 ÷ GPU 原価」を機能 × GPU ごとに出す。原価の計算は実稼働ログ・日次サマリーと
  // 共通（makeRowCostJpy）。成功だけで倍率を出し、失敗の原価は別に数える（失敗は返金で売上 0 のため）。
  const featureSince = new Date(Date.now() - FEATURE_DAYS * 86400_000).toISOString();
  const { data: logs, error: logErr } = await supabaseAdmin
    .from("generation_logs")
    .select("job_type, status, gpu_tier, execution_time_ms, credits_consumed")
    .gte("created_at", featureSince)
    .limit(20000);
  if (logErr) return NextResponse.json({ error: logErr.message }, { status: 500 });
  type Agg = { jobType: string; gpuTier: string; count: number; failed: number; revenueJpy: number; costJpy: number; failedCostJpy: number; markups: number[]; negative: number; low: number };
  const aggs = new Map<string, Agg>();
  const lowMarkup = 1 / (1 - Math.min(0.99, Math.max(0, knobs.alert_low_margin_percent / 100)));
  for (const l of logs ?? []) {
    const tier = String(l.gpu_tier ?? "").trim() || "none";
    const k = `${l.job_type}|${tier}`;
    const a =
      aggs.get(k) ??
      { jobType: String(l.job_type), gpuTier: tier, count: 0, failed: 0, revenueJpy: 0, costJpy: 0, failedCostJpy: 0, markups: [], negative: 0, low: 0 };
    const cost = rowCostJpy({ job_type: String(l.job_type), execution_time_ms: l.execution_time_ms, gpu_tier: l.gpu_tier });
    if (l.status === "success") {
      const rev = (l.credits_consumed ?? 0) * knobs.credit_to_jpy;
      a.count += 1;
      a.revenueJpy += rev;
      a.costJpy += cost;
      if (cost > 0 && rev > 0) {
        const mk = rev / cost;
        a.markups.push(mk);
        if (mk < 1) a.negative += 1;
        else if (mk < lowMarkup) a.low += 1;
      }
    } else {
      a.failed += 1;
      a.failedCostJpy += cost;
    }
    aggs.set(k, a);
  }
  const features = [...aggs.values()]
    .filter((a) => a.count > 0 || a.failedCostJpy > 0)
    .map((a) => {
      const markup = a.costJpy > 0 ? a.revenueJpy / a.costJpy : null;
      const status: "negative" | "low" | "ok" | "no_data" =
        a.markups.length === 0 ? "no_data" : a.negative > 0 ? "negative" : a.low > 0 ? "low" : "ok";
      return {
        jobType: a.jobType,
        gpuTier: a.gpuTier,
        count: a.count,
        failed: a.failed,
        revenueJpy: Math.round(a.revenueJpy),
        costJpy: Math.round(a.costJpy),
        failedCostJpy: Math.round(a.failedCostJpy),
        markup: round(markup, 2),
        medianMarkup: round(median(a.markups), 2),
        minMarkup: round(a.markups.length ? Math.min(...a.markups) : null, 2),
        maxMarkup: round(a.markups.length ? Math.max(...a.markups) : null, 2),
        negative: a.negative,
        low: a.low,
        status,
      };
    });
  const fOrder = { negative: 0, low: 1, ok: 2, no_data: 3 } as const;
  features.sort((a, b) => fOrder[a.status] - fOrder[b.status] || b.revenueJpy - a.revenueJpy);

  return NextResponse.json({
    featureDays: FEATURE_DAYS,
    lowMarginPercent: knobs.alert_low_margin_percent,
    features,
    days: DAYS,
    targetMargin: TARGET_MARGIN,
    overRatio: OVER_RATIO,
    underRatio: UNDER_RATIO,
    rows,
  });
}
