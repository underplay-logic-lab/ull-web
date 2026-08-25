import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const RECENT_LIMIT = 50;
// Summary cards are computed over the most recent N rows rather than the
// whole table (no DB-side aggregate view exists yet) — a large enough
// window for the current log volume, but it should move to a Postgres
// view/RPC once generation_logs grows past this.
const SUMMARY_SCAN_LIMIT = 5000;

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const [recentResult, pricingResult, summaryResult] = await Promise.all([
    supabaseAdmin
      .from("generation_logs")
      .select(
        "id, user_id, job_type, prompt_input, output_file_name, execution_time_ms, credits_consumed, status, error_message, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(RECENT_LIMIT),
    supabaseAdmin.from("studio_pricing").select("key, unit_cost_usd"),
    supabaseAdmin
      .from("generation_logs")
      .select("job_type, execution_time_ms, credits_consumed, status")
      .order("created_at", { ascending: false })
      .limit(SUMMARY_SCAN_LIMIT),
  ]);

  if (recentResult.error || pricingResult.error || summaryResult.error) {
    console.error(
      "[admin/logs] fetch failed:",
      recentResult.error?.message ?? pricingResult.error?.message ?? summaryResult.error?.message,
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

  const logs = (recentResult.data ?? []).map((row) => ({
    ...row,
    user_email: emailByUserId.get(row.user_id as string) ?? null,
  }));

  const unitCostByFeature = new Map(
    (pricingResult.data ?? []).map((row) => [row.key as string, row.unit_cost_usd as number]),
  );

  let totalCount = 0;
  let successCount = 0;
  let totalCreditsConsumed = 0;
  let totalModalCostUsd = 0;

  for (const row of summaryResult.data ?? []) {
    totalCount += 1;
    if (row.status === "success") successCount += 1;
    totalCreditsConsumed += row.credits_consumed ?? 0;
    const unitCost = unitCostByFeature.get(row.job_type) ?? 0;
    const seconds = (row.execution_time_ms ?? 0) / 1000;
    totalModalCostUsd += seconds * unitCost;
  }

  return NextResponse.json({
    logs,
    summary: {
      totalCount,
      successRate: totalCount > 0 ? (successCount / totalCount) * 100 : 0,
      totalCreditsConsumed,
      totalModalCostUsd,
      scanLimited: totalCount >= SUMMARY_SCAN_LIMIT,
    },
  });
}
