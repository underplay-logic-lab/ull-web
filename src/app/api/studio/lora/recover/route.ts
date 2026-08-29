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

type JobRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  status: string;
  inputs: { dispatch?: LoraDispatchPayload } | null;
};

// generation_jobs UPDATE that survives a DB that's behind on migrations:
// downgrades 'cancelled'/'failed_timeout' -> 'failed' if the status CHECK
// rejects them, and drops any column PostgREST doesn't know about.
async function updateJob(id: string, fields: Record<string, unknown>): Promise<void> {
  let f: Record<string, unknown> = { ...fields };
  for (let attempt = 0; attempt < 6; attempt++) {
    const { error } = await supabaseAdmin.from("generation_jobs").update(f).eq("id", id);
    if (!error) return;
    const msg = `${error.message} ${(error as { details?: string }).details ?? ""}`.toLowerCase();

    if (
      /check constraint|generation_jobs_status_check/.test(msg) &&
      (f.status === "cancelled" || f.status === "failed_timeout")
    ) {
      f = { ...f, status: "failed" };
      continue;
    }
    const col = msg.match(/'([a-z_]+)' column|column ["']?([a-z_]+)["']?/)?.slice(1).find(Boolean);
    if (col && col in f) {
      delete f[col];
      continue;
    }
    if (/schema cache|could not find/.test(msg)) {
      const base = new Set([
        "status",
        "error_message",
        "completed_at",
        "updated_at",
        "video_url",
        "progress_percent",
        "progress_message",
        "result_path",
        "inputs",
        "credits_cost",
      ]);
      let changed = false;
      for (const k of Object.keys(f)) {
        if (!base.has(k)) {
          delete f[k];
          changed = true;
        }
      }
      if (changed) continue;
    }
    console.error("[recover] updateJob gave up:", error.message);
    return;
  }
}

async function refundCredits(userId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  const { data } = await supabaseAdmin.from("profiles").select("credits").eq("id", userId).single();
  const current = (data?.credits as number | null) ?? 0;
  await supabaseAdmin.from("profiles").update({ credits: current + amount }).eq("id", userId);
}

// Cancels the stuck call, 100%-refunds the original cost once (guarded by
// `refunded` when the column exists), and closes the job.
async function closeWithRefund(job: JobRow): Promise<number> {
  const modalCallId = typeof job.modal_call_id === "string" ? job.modal_call_id : "";
  if (modalCallId) await cancelLoraTrainingCall(modalCallId);

  const parentId = typeof job.parent_job_id === "string" ? job.parent_job_id : job.id;
  const { data: original } = await supabaseAdmin
    .from("generation_jobs")
    .select("*")
    .eq("id", parentId)
    .maybeSingle();

  const alreadyRefunded = Boolean((original as Record<string, unknown> | null)?.refunded);
  const amount =
    (typeof (original as Record<string, unknown> | null)?.credits_cost === "number"
      ? ((original as Record<string, unknown>).credits_cost as number)
      : LORA_TRAINING_COST);

  let refunded = 0;
  if (!alreadyRefunded && amount > 0) {
    await refundCredits(job.user_id, amount);
    refunded = amount;
    await updateJob(parentId, {
      refunded: true,
      status: "failed_timeout",
      error_message: "cloud congestion — auto-refunded",
      completed_at: new Date().toISOString(),
    });
  }
  if (parentId !== job.id) {
    await updateJob(job.id, {
      status: "failed_timeout",
      error_message: "cloud congestion — auto-refunded",
      completed_at: new Date().toISOString(),
    });
  }
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
      .select("*")
      .eq("id", jobId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (jobErr) {
      return NextResponse.json({ error: "ジョブの取得に失敗しました。", reason: jobErr.message }, { status: 500 });
    }
    if (!jobData) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
    const job = jobData as JobRow;

    // Worker already picked it up (or it's terminal) — nothing to recover.
    if (job.status !== "queued") {
      return NextResponse.json({ ok: true, noop: true, status: job.status });
    }

    const retryCount = typeof job.retry_count === "number" ? job.retry_count : 0;
    const dispatch = job.inputs?.dispatch;
    const modalCallId = typeof job.modal_call_id === "string" ? job.modal_call_id : "";

    // Explicit timeout, retry cap reached, or nothing to re-dispatch.
    if (action === "timeout" || retryCount >= MAX_RETRIES || !dispatch) {
      const refunded = await closeWithRefund(job);
      return NextResponse.json({ ok: true, status: "failed_timeout", refunded });
    }

    // --- retry: cancel the stuck call, supersede this job, re-dispatch ---
    if (modalCallId) await cancelLoraTrainingCall(modalCallId);
    await updateJob(job.id, {
      status: "cancelled",
      error_message: `auto-rerouted (pending timeout, retry ${retryCount + 1})`,
      completed_at: new Date().toISOString(),
    });

    // Insert the fresh (already-priced) child job — strip retry columns if
    // the DB doesn't have them yet.
    let newJobId = "";
    const childShapes: Record<string, unknown>[] = [
      {
        user_id: user.id,
        status: "queued",
        workflow_type: "lora_training",
        inputs: job.inputs,
        credits_cost: 0,
        retry_count: retryCount + 1,
        parent_job_id: typeof job.parent_job_id === "string" ? job.parent_job_id : job.id,
        progress_percent: 0,
        progress_message: "rerouting",
      },
      {
        user_id: user.id,
        status: "queued",
        workflow_type: "lora_training",
        inputs: job.inputs,
        credits_cost: 0,
      },
    ];
    for (const shape of childShapes) {
      const { data, error } = await supabaseAdmin
        .from("generation_jobs")
        .insert(shape)
        .select("id")
        .single();
      if (!error && data) {
        newJobId = data.id as string;
        break;
      }
      console.error("[recover] child job insert failed, trying leaner shape:", error?.message);
    }
    if (!newJobId) {
      const refunded = await closeWithRefund(job);
      return NextResponse.json({ ok: true, status: "failed_timeout", refunded });
    }

    try {
      const { modalCallId: newCallId } = await redispatchLoraTrainingJob({
        jobId: newJobId,
        userId: user.id,
        payload: dispatch,
      });
      if (newCallId) await updateJob(newJobId, { modal_call_id: newCallId });
    } catch (err) {
      await updateJob(newJobId, {
        status: "failed",
        error_message: `re-dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      const refunded = await closeWithRefund({ ...job, id: newJobId });
      return NextResponse.json({ ok: true, status: "failed_timeout", refunded });
    }

    return NextResponse.json({ ok: true, status: "queued", jobId: newJobId, retryCount: retryCount + 1 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[studio/lora/recover] unhandled:", message, err instanceof Error ? err.stack : undefined);
    return NextResponse.json({ error: "リカバリ処理に失敗しました。", reason: message }, { status: 500 });
  }
}
