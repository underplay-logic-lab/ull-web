import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type RouteParams = { params: Promise<{ id: string }> };

// Polled by the frontend (every couple seconds while a job is queued/
// processing — see CinematicVideoTab.tsx) instead of the old design where
// the generate route's own HTTP response blocked until the render
// finished. Same Authorization-header bearer-token auth as
// /api/generate/cinematic, since this is called from the same client code
// with the same Supabase session.
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;

  const authHeader = request.headers.get("authorization");
  const accessToken = authHeader?.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  }

  // Scoped to the requesting user explicitly (not just relying on the
  // table's RLS policy) — same defense-in-depth convention the rest of
  // this app's user-facing routes follow with supabaseAdmin.
  const { data: job, error } = await supabaseAdmin
    .from("generation_jobs")
    .select(
      "id, status, workflow_type, video_url, error_message, created_at, updated_at, progress_percent, progress_message, result_path",
    )
    .eq("id", id)
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (error) {
    console.error("[jobs/[id]] fetch failed:", error.message);
    return NextResponse.json({ error: "ジョブ状態の取得に失敗しました。" }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  }

  // While the job is still waiting/running, attach live queue telemetry so
  // the client can show "何人待ち / あと約何分". One indexed RPC round-trip
  // (see generation_job_queue_stats) — skipped entirely once the job is
  // completed/failed.
  let queue: { queuePosition: number; avgExecutionSeconds: number; estimatedWaitSeconds: number } | null =
    null;
  if (job.status === "queued" || job.status === "processing") {
    const { data: stats, error: statsError } = await supabaseAdmin.rpc("generation_job_queue_stats", {
      p_created_at: job.created_at,
    });
    if (statsError) {
      console.error("[jobs/[id]] queue stats failed:", statsError.message);
    } else {
      const row = Array.isArray(stats) ? stats[0] : stats;
      const queuePosition = Math.max(0, Math.round(Number(row?.queue_position ?? 0)));
      const avgExecutionSeconds = Math.max(1, Math.round(Number(row?.avg_execution_seconds ?? 28)));
      // Full renders queued ahead + ~10s left on the one currently running.
      const estimatedWaitSeconds = queuePosition * avgExecutionSeconds + 10;
      queue = { queuePosition, avgExecutionSeconds, estimatedWaitSeconds };
    }
  }

  return NextResponse.json({
    jobId: job.id,
    status: job.status as "queued" | "processing" | "completed" | "failed",
    workflowType: job.workflow_type,
    videoUrl: job.video_url,
    errorMessage: job.error_message,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    progressPercent: job.progress_percent ?? null,
    progressMessage: job.progress_message ?? null,
    resultPath: job.result_path ?? null,
    ...(queue
      ? {
          queuePosition: queue.queuePosition,
          avgExecutionSeconds: queue.avgExecutionSeconds,
          estimatedWaitSeconds: queue.estimatedWaitSeconds,
        }
      : {}),
  });
}
