import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  cancelLoraTrainingCall,
  redispatchLoraTrainingJob,
  type LoraDispatchPayload,
} from "@/lib/modalLoraTrain";

// Covers the re-dispatch (Modal cold start is possible though the dispatcher
// keeps a warm container).
export const maxDuration = 60;

const MAX_RETRIES = 2;
const LORA_TRAINING_COST = 150;

type JobRow = {
  id: string;
  user_id: string;
  status: string;
  retry_count: number | null;
  modal_call_id: string | null;
  parent_job_id: string | null;
  credits_cost: number | null;
  refunded: boolean | null;
  inputs: { dispatch?: LoraDispatchPayload } | null;
};

async function refundCredits(userId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  const { data } = await supabaseAdmin.from("profiles").select("credits").eq("id", userId).single();
  const current = (data?.credits as number | null) ?? 0;
  await supabaseAdmin.from("profiles").update({ credits: current + amount }).eq("id", userId);
}

// Marks the current job failed_timeout and 100%-refunds the original job's
// cost (once — guarded by `refunded`).
async function closeWithRefund(job: JobRow): Promise<number> {
  if (job.modal_call_id) await cancelLoraTrainingCall(job.modal_call_id);

  const originalId = job.parent_job_id ?? job.id;
  const { data: original } = await supabaseAdmin
    .from("generation_jobs")
    .select("id, user_id, credits_cost, refunded")
    .eq("id", originalId)
    .maybeSingle();

  let refunded = 0;
  const alreadyRefunded = (original?.refunded as boolean | null) ?? false;
  const amount = (original?.credits_cost as number | null) ?? LORA_TRAINING_COST;
  if (!alreadyRefunded && amount > 0) {
    await refundCredits(job.user_id, amount);
    refunded = amount;
    await supabaseAdmin
      .from("generation_jobs")
      .update({ refunded: true, status: "failed_timeout", error_message: "cloud congestion — auto-refunded", completed_at: new Date().toISOString() })
      .eq("id", originalId);
  }

  await supabaseAdmin
    .from("generation_jobs")
    .update({
      status: "failed_timeout",
      error_message: "cloud congestion — auto-refunded",
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  return refunded;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const authHeader = request.headers.get("authorization");
    const accessToken = authHeader?.replace(/^Bearer\s+/i, "");
    if (!accessToken) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });

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
    const user = userData.user;

    const body = await request.json().catch(() => null);
    const jobId = typeof body?.jobId === "string" ? body.jobId : "";
    const action = body?.action === "timeout" ? "timeout" : "retry";
    if (!jobId) return NextResponse.json({ error: "jobId が必要です。" }, { status: 400 });

    const { data: jobData, error: jobErr } = await supabaseAdmin
      .from("generation_jobs")
      .select("id, user_id, status, retry_count, modal_call_id, parent_job_id, credits_cost, refunded, inputs")
      .eq("id", jobId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (jobErr) {
      return NextResponse.json({ error: "ジョブの取得に失敗しました。", reason: jobErr.message }, { status: 500 });
    }
    if (!jobData) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
    const job = jobData as JobRow;

    // The worker already picked it up (or it's terminal) — nothing to recover.
    if (job.status !== "queued") {
      return NextResponse.json({ ok: true, noop: true, status: job.status });
    }

    const retryCount = job.retry_count ?? 0;
    const dispatch = job.inputs?.dispatch;

    // Explicit timeout, retry cap reached, or no re-dispatchable payload.
    if (action === "timeout" || retryCount >= MAX_RETRIES || !dispatch) {
      const refunded = await closeWithRefund(job);
      return NextResponse.json({ ok: true, status: "failed_timeout", refunded });
    }

    // --- retry: cancel the stuck call, supersede this job, re-dispatch ---
    if (job.modal_call_id) await cancelLoraTrainingCall(job.modal_call_id);

    await supabaseAdmin
      .from("generation_jobs")
      .update({
        status: "cancelled",
        error_message: `auto-rerouted (pending timeout, retry ${retryCount + 1})`,
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    const { data: newJob, error: newJobErr } = await supabaseAdmin
      .from("generation_jobs")
      .insert({
        user_id: user.id,
        status: "queued",
        workflow_type: "lora_training",
        inputs: job.inputs,
        credits_cost: 0,
        retry_count: retryCount + 1,
        parent_job_id: job.parent_job_id ?? job.id,
        progress_percent: 0,
        progress_message: "rerouting to another node",
      })
      .select("id")
      .single();
    if (newJobErr || !newJob) {
      // couldn't create the retry row — fall back to refund so credits aren't lost
      const refunded = await closeWithRefund(job);
      return NextResponse.json(
        { ok: true, status: "failed_timeout", refunded, reason: newJobErr?.message },
        { status: 200 },
      );
    }
    const newJobId = newJob.id as string;

    try {
      const { modalCallId } = await redispatchLoraTrainingJob({
        jobId: newJobId,
        userId: user.id,
        payload: dispatch,
      });
      if (modalCallId) {
        await supabaseAdmin.from("generation_jobs").update({ modal_call_id: modalCallId }).eq("id", newJobId);
      }
    } catch (err) {
      await supabaseAdmin
        .from("generation_jobs")
        .update({ status: "failed", error_message: `re-dispatch failed: ${err instanceof Error ? err.message : String(err)}` })
        .eq("id", newJobId);
      const refunded = await closeWithRefund({ ...job, id: newJobId });
      return NextResponse.json({ ok: true, status: "failed_timeout", refunded }, { status: 200 });
    }

    return NextResponse.json({ ok: true, status: "queued", jobId: newJobId, retryCount: retryCount + 1 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[studio/lora/recover] unhandled:", message, err instanceof Error ? err.stack : undefined);
    return NextResponse.json({ error: "リカバリ処理に失敗しました。", reason: message }, { status: 500 });
  }
}
