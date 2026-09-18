import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { estimateJobCostJpy, normalizeGpuTier } from "@/lib/pricing/gpuRates";

const RECENT_LIMIT = 50;
// Summary cards are computed over the most recent N rows rather than the
// whole table (no DB-side aggregate view exists yet) — a large enough
// window for the current log volume, but it should move to a Postgres
// view/RPC once generation_logs grows past this.
const SUMMARY_SCAN_LIMIT = 5000;
const ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const knobs = await getPricingKnobs();
  const alertSinceIso = new Date(Date.now() - ALERT_WINDOW_MS).toISOString();

  const [recentResult, pricingResult, summaryResult, alertResult] = await Promise.all([
    supabaseAdmin
      .from("generation_logs")
      .select(
        "id, user_id, job_type, prompt_input, output_file_name, execution_time_ms, credits_consumed, gpu_tier, status, error_message, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(RECENT_LIMIT),
    supabaseAdmin.from("studio_pricing").select("key, unit_cost_usd"),
    supabaseAdmin
      .from("generation_logs")
      .select("job_type, execution_time_ms, credits_consumed, gpu_tier, status")
      .order("created_at", { ascending: false })
      .limit(SUMMARY_SCAN_LIMIT),
    // 粗利アラート（2026-09-18導入）は「直近N件」ではなく「直近24時間」で
    // 見る必要があるため、SUMMARY_SCAN_LIMIT の行数窓とは別に時間窓で取る。
    supabaseAdmin
      .from("generation_logs")
      .select("job_type, execution_time_ms, credits_consumed, gpu_tier, status, created_at")
      .gte("created_at", alertSinceIso)
      .eq("status", "success"),
  ]);

  if (recentResult.error || pricingResult.error || summaryResult.error || alertResult.error) {
    console.error(
      "[admin/logs] fetch failed:",
      recentResult.error?.message ??
        pricingResult.error?.message ??
        summaryResult.error?.message ??
        alertResult.error?.message,
    );
    return NextResponse.json({ error: "ログの取得に失敗しました。" }, { status: 500 });
  }

  // generation_logs.user_id references auth.users(id), not public.profiles —
  // no FK relationship for PostgREST to embed, so resolve emails with a
  // second query keyed on the distinct ids actually present in this page.
  const userIds = Array.from(new Set((recentResult.data ?? []).map((row) => row.user_id as string)));
  const emailByUserId = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profileRows, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("id, email")
      .in("id", userIds);
    if (profileError) {
      console.error("[admin/logs] profile email lookup failed:", profileError.message);
    } else {
      for (const row of profileRows ?? []) {
        emailByUserId.set(row.id as string, row.email as string);
      }
    }
  }

  const unitCostByFeature = new Map(
    (pricingResult.data ?? []).map((row) => [row.key as string, row.unit_cost_usd as number]),
  );

  // gpu_tier が既知（トリガーが metadata.gpu_tier を拾えた行）なら実測GPU
  // 単価×実行時間で原価を出し、未知（旧ログ・gpu_tierを報告しないワーカー）
  // なら従来の job_type 単位フラット単価にフォールバックする。
  const rowCostJpy = (row: { job_type: string; execution_time_ms: number | null; gpu_tier: string | null }): number => {
    const tierCost = estimateJobCostJpy(row.execution_time_ms, row.gpu_tier, knobs);
    if (tierCost != null) return tierCost;
    const unitCostUsd = unitCostByFeature.get(row.job_type) ?? 0;
    const seconds = (row.execution_time_ms ?? 0) / 1000;
    return seconds * unitCostUsd * knobs.usd_jpy_rate;
  };

  const logs = (recentResult.data ?? []).map((row) => {
    const costJpy = rowCostJpy(row);
    const revenueJpy = (row.credits_consumed ?? 0) * knobs.credit_to_jpy;
    const marginPercent = revenueJpy > 0 ? ((revenueJpy - costJpy) / revenueJpy) * 100 : null;
    return {
      ...row,
      user_email: emailByUserId.get(row.user_id as string) ?? null,
      gpu_tier_label: normalizeGpuTier(row.gpu_tier)?.label ?? null,
      cost_jpy: costJpy,
      margin_percent: marginPercent,
    };
  });

  let totalCount = 0;
  let successCount = 0;
  let totalCreditsConsumed = 0;
  let totalModalCostJpy = 0;

  for (const row of summaryResult.data ?? []) {
    totalCount += 1;
    if (row.status === "success") successCount += 1;
    totalCreditsConsumed += row.credits_consumed ?? 0;
    totalModalCostJpy += rowCostJpy(row);
  }

  // 低粗利/原価割れアラート（2026-09-18導入）: 直近24時間・成功ジョブの
  // うち粗利率が alert_low_margin_percent（既定30%）を下回る件数。
  let lowMarginCount = 0;
  let negativeMarginCount = 0;
  for (const row of alertResult.data ?? []) {
    const costJpy = rowCostJpy(row);
    const revenueJpy = (row.credits_consumed ?? 0) * knobs.credit_to_jpy;
    if (revenueJpy <= 0) continue;
    const marginPercent = ((revenueJpy - costJpy) / revenueJpy) * 100;
    if (marginPercent < 0) negativeMarginCount += 1;
    if (marginPercent < knobs.alert_low_margin_percent) lowMarginCount += 1;
  }

  return NextResponse.json({
    logs,
    summary: {
      totalCount,
      successRate: totalCount > 0 ? (successCount / totalCount) * 100 : 0,
      totalCreditsConsumed,
      totalModalCostJpy,
      scanLimited: totalCount >= SUMMARY_SCAN_LIMIT,
    },
    alert: {
      windowHours: ALERT_WINDOW_MS / 3600_000,
      thresholdPercent: knobs.alert_low_margin_percent,
      lowMarginCount,
      negativeMarginCount,
    },
  });
}
