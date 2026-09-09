import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { checkLoraCallStatus } from "@/lib/modalLoraTrain";
import {
  loraCallIdOf,
  markLoraJobContainerDead,
  markLoraJobCompletedFromModal,
} from "@/lib/loraJobHealth";

type RouteParams = { params: Promise<{ id: string }> };

// The stuck-row recovery below can run a ~2-min Volume-scan salvage — but only
// on the rare tick that first detects a stuck job. The common fast path
// returns in well under a second.
export const maxDuration = 120;

// A LoRA training container that dies by SIGKILL never runs its own failure
// handler, so the row is stuck 'processing'. Once it's been silent this long
// (normal runs PATCH progress every ~5s), ask Modal directly whether the
// FunctionCall is still alive — see check_call_status in modal_lora_worker.py.
const LORA_STUCK_PROBE_AFTER_MS = 180_000;

// True when generation_jobs.metadata[flag] is already set — used to make the
// stuck-row recovery below run at most once per job.
function existingMetaFlag(job: Record<string, unknown>, flag: string): boolean {
  const meta = job.metadata;
  return Boolean(meta && typeof meta === "object" && (meta as Record<string, unknown>)[flag] === true);
}

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
  // select("*") rather than a column list so a DB that's a migration or two
  // behind (missing progress_*/retry_count/...) never 500s this poll and
  // freezes the client's job tracker — every field is read defensively below.
  const { data: job, error } = (await supabaseAdmin
    .from("generation_jobs")
    .select("*")
    .eq("id", id)
    .eq("user_id", userData.user.id)
    .maybeSingle()) as {
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("[jobs/[id]] fetch failed:", error.message);
    return NextResponse.json({ error: "ジョブ状態の取得に失敗しました。" }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  }

  let effJob: Record<string, unknown> = job;
  let status = String(job.status ?? "queued");

  // Self-healing: a LoRA job whose Modal function died by SIGKILL (12h
  // timeout / OOM / eviction / a crashed CPU pre-cache orchestrator) never
  // ran its own except-block, so it's stuck here forever and the Studio UI
  // spins. Covers both 'processing' AND 'queued' (the dispatcher now returns
  // instantly and the CPU pre-cache + GPU spawn run async — a queued job
  // carries the orchestrator's fc-id until train_lora_job self-records its
  // own). Once it's gone quiet, ask Modal whether the FunctionCall is alive:
  // a "failed" verdict is authoritative; "running" (a long silent
  // model-download / latent-cache phase) and unknown are left untouched.
  if (
    (status === "processing" || status === "queued") &&
    job.workflow_type === "lora_training" &&
    Date.now() - new Date(String(job.updated_at ?? job.created_at ?? 0)).getTime() >
      LORA_STUCK_PROBE_AFTER_MS
  ) {
    const callId = loraCallIdOf(job);
    if (/^fc-/.test(callId)) {
      const probe = await checkLoraCallStatus(callId);
      if (probe.status === "failed") {
        console.error(`[jobs/[id]] job ${id}: Modal reports FunctionCall dead — closing. ${probe.error ?? ""}`);
        await markLoraJobContainerDead(job, probe.error ?? "");
        const { data: fresh } = await supabaseAdmin
          .from("generation_jobs")
          .select("*")
          .eq("id", id)
          .maybeSingle();
        if (fresh) {
          effJob = fresh as Record<string, unknown>;
          status = String((fresh as Record<string, unknown>).status ?? "failed");
        } else {
          status = "failed";
        }
      } else if (
        probe.status === "completed" &&
        status === "processing" &&
        !existingMetaFlag(job, "recovered_completed")
      ) {
        // 'processing' ONLY: by now the row carries train_lora_job's OWN
        // fc-id (self-recorded), so a "completed" verdict means the training
        // call genuinely returned a result — but the worker's final PATCH was
        // lost (same outage that froze the client's poll), leaving the row
        // stuck at its last-reported step. (A 'queued' row still carries the
        // ORCHESTRATOR's fc-id, which returns "completed" the instant it has
        // spawned the GPU job — that is NOT training-done, so it's excluded.)
        // Pull the finished artifacts off the Volume and flip the row so the
        // Studio advances to its download screen.
        console.warn(`[jobs/[id]] job ${id}: Modal reports FunctionCall completed but row is stuck 'processing' — recovering from Volume`);
        const rec = await markLoraJobCompletedFromModal(job);
        if (rec.recovered) {
          const { data: fresh } = await supabaseAdmin
            .from("generation_jobs")
            .select("*")
            .eq("id", id)
            .maybeSingle();
          if (fresh) {
            effJob = fresh as Record<string, unknown>;
            status = String((fresh as Record<string, unknown>).status ?? "completed");
          } else {
            status = "completed";
          }
        }
      }
    }
  }

  // While the job is still waiting/running, attach live queue telemetry so
  // the client can show "何人待ち / あと約何分". One indexed RPC round-trip
  // (see generation_job_queue_stats) — skipped entirely once the job is
  // completed/failed.
  let queue: { queuePosition: number; avgExecutionSeconds: number; estimatedWaitSeconds: number } | null =
    null;
  if (status === "queued" || status === "processing") {
    const { data: stats, error: statsError } = await supabaseAdmin.rpc("generation_job_queue_stats", {
      p_created_at: effJob.created_at as string,
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
    jobId: effJob.id,
    status,
    workflowType: effJob.workflow_type ?? null,
    videoUrl: effJob.video_url ?? null,
    errorMessage: effJob.error_message ?? null,
    createdAt: effJob.created_at ?? null,
    updatedAt: effJob.updated_at ?? null,
    progressPercent: effJob.progress_percent ?? null,
    progressMessage: effJob.progress_message ?? null,
    resultPath: effJob.result_path ?? null,
    metadata: effJob.metadata ?? null,
    retryCount: typeof effJob.retry_count === "number" ? effJob.retry_count : 0,
    ...(queue
      ? {
          queuePosition: queue.queuePosition,
          avgExecutionSeconds: queue.avgExecutionSeconds,
          estimatedWaitSeconds: queue.estimatedWaitSeconds,
        }
      : {}),
  });
}
