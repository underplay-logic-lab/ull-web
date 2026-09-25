import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { estimateJobCostJpy } from "@/lib/pricing/gpuRates";

// 管理画面「実稼働ログ & 粗利監視」タブの API（直近N件/直近24時間の走査）
// とは別に、Discord日次/月次サマリー（2026-09-18導入）向けの「指定期間
// （JST日境界）で generation_logs を集計する」ための共通ロジック。
// 原価・粗利の計算ロジック自体は src/lib/pricing/gpuRates.ts を共有し、
// /api/admin/logs と食い違わないようにする。

export type GenerationLogsPeriodSummary = {
  fromIso: string;
  toIso: string;
  totalCount: number;
  successCount: number;
  failedCount: number;
  totalCreditsConsumed: number;
  totalCostJpy: number;
  /** うち失敗したジョブの原価（2026-09-25。合計に埋もれて原因が読めなかったので分けて出す）。 */
  failedCostJpy: number;
  totalRevenueJpy: number;
  marginPercent: number | null;
  lowMarginCount: number;
  negativeMarginCount: number;
  byJobType: { jobType: string; count: number; creditsConsumed: number; costJpy: number }[];
};

export async function summarizeGenerationLogs(fromIso: string, toIso: string): Promise<GenerationLogsPeriodSummary> {
  const knobs = await getPricingKnobs();

  const [{ data: rows, error }, { data: pricingRows }] = await Promise.all([
    supabaseAdmin
      .from("generation_logs")
      .select("job_type, execution_time_ms, credits_consumed, gpu_tier, status")
      .gte("created_at", fromIso)
      .lt("created_at", toIso),
    supabaseAdmin.from("studio_pricing").select("key, unit_cost_usd"),
  ]);
  if (error) {
    console.error("[adminLogsSummary] query failed:", error.message);
  }

  const unitCostByFeature = new Map(
    (pricingRows ?? []).map((row) => [row.key as string, row.unit_cost_usd as number]),
  );
  const rowCostJpy = (row: { job_type: string; execution_time_ms: number | null; gpu_tier: string | null }): number => {
    const tierCost = estimateJobCostJpy(row.execution_time_ms, row.gpu_tier, knobs);
    if (tierCost != null) return tierCost;
    const unitCostUsd = unitCostByFeature.get(row.job_type) ?? 0;
    const seconds = (row.execution_time_ms ?? 0) / 1000;
    return seconds * unitCostUsd * knobs.usd_jpy_rate;
  };

  let successCount = 0;
  let failedCount = 0;
  let totalCreditsConsumed = 0;
  let totalCostJpy = 0;
  let failedCostJpy = 0;
  let lowMarginCount = 0;
  let negativeMarginCount = 0;
  const byJobTypeMap = new Map<string, { count: number; creditsConsumed: number; costJpy: number }>();

  for (const row of rows ?? []) {
    if (row.status === "success") successCount += 1;
    else failedCount += 1;
    totalCreditsConsumed += row.credits_consumed ?? 0;
    const costJpy = rowCostJpy(row);
    totalCostJpy += costJpy;
    if (row.status !== "success") failedCostJpy += costJpy;

    const entry = byJobTypeMap.get(row.job_type) ?? { count: 0, creditsConsumed: 0, costJpy: 0 };
    entry.count += 1;
    entry.creditsConsumed += row.credits_consumed ?? 0;
    entry.costJpy += costJpy;
    byJobTypeMap.set(row.job_type, entry);

    if (row.status === "success") {
      const revenueJpy = (row.credits_consumed ?? 0) * knobs.credit_to_jpy;
      if (revenueJpy > 0) {
        const marginPercent = ((revenueJpy - costJpy) / revenueJpy) * 100;
        if (marginPercent < 0) negativeMarginCount += 1;
        if (marginPercent < knobs.alert_low_margin_percent) lowMarginCount += 1;
      }
    }
  }

  const totalCount = successCount + failedCount;
  const totalRevenueJpy = totalCreditsConsumed * knobs.credit_to_jpy;
  const marginPercent = totalRevenueJpy > 0 ? ((totalRevenueJpy - totalCostJpy) / totalRevenueJpy) * 100 : null;

  return {
    fromIso,
    toIso,
    totalCount,
    successCount,
    failedCount,
    totalCreditsConsumed,
    totalCostJpy,
    failedCostJpy,
    totalRevenueJpy,
    marginPercent,
    lowMarginCount,
    negativeMarginCount,
    byJobType: Array.from(byJobTypeMap.entries())
      .map(([jobType, v]) => ({ jobType, ...v }))
      .sort((a, b) => b.costJpy - a.costJpy),
  };
}
