import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { cancelLoraTrainingCall, type LoraDispatchPayload } from "@/lib/modalLoraTrain";

// Cancelling a running call + terminating its container can take a moment.
export const maxDuration = 60;

const LORA_TRAINING_COST = 150;

type JobRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  status: string;
  inputs: {
    dispatch?: LoraDispatchPayload;
    modal_call_id?: string;
    training_config?: { custom_yaml_override?: unknown };
  } | null;
};

// Platform-defence: a job whose config came from the raw-YAML expert editor
// is the user's own responsibility — its failure / abort does NOT refund.
function isCustomYamlJob(job: JobRow): boolean {
  const inputs = job.inputs;
  if (inputs?.training_config?.custom_yaml_override != null) return true;
  const d = inputs?.dispatch as
    | { custom_yaml_override?: unknown; training_config?: { custom_yaml_override?: unknown } }
    | undefined;
  return Boolean(d?.custom_yaml_override || d?.training_config?.custom_yaml_override);
}

// The Modal FunctionCall id — from the column, or from inputs jsonb when the
// DB is behind on the modal_call_id migration.
function callIdOf(job: JobRow): string {
  if (typeof job.modal_call_id === "string" && job.modal_call_id) return job.modal_call_id;
  const fromInputs = job.inputs?.modal_call_id;
  return typeof fromInputs === "string" ? fromInputs : "";
}

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

// fc-... only — a Supabase UUID here would just whiff against Modal.
function isModalCallId(v: string): boolean {
  return /^fc-/.test(v) || (v.length > 8 && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v));
}

// Physically cancels the Modal FunctionCall for this job, if we have one.
// Returns { attempted, id, cancelled }.
async function cancelModalForJob(
  job: JobRow,
): Promise<{ attempted: boolean; id: string; cancelled: boolean }> {
  const id = callIdOf(job);
  if (!id) {
    console.error(`[recover] job ${job.id}: no modal_call_id on record — cannot physically cancel`);
    return { attempted: false, id: "", cancelled: false };
  }
  if (!isModalCallId(id)) {
    console.error(`[recover] job ${job.id}: modal_call_id looks like a UUID, not fc-... (${id}) — skipping`);
    return { attempted: false, id, cancelled: false };
  }
  const cancelled = await cancelLoraTrainingCall(id);
  console.log(`[recover] job ${job.id}: cancel_lora_job(${id}) -> ${cancelled}`);
  return { attempted: true, id, cancelled };
}

// Cancels the running / queued call (terminating its container), 100%-refunds
// the original cost once (guarded by `refunded` when the column exists), and
// closes the job. NEVER re-dispatches — a stuck job always ends here.
async function closeWithRefund(
  job: JobRow,
  opts: { status?: string; message?: string; refund?: boolean } = {},
): Promise<{ refunded: number; modalCancelled: boolean }> {
  const status = opts.status ?? "failed_timeout";
  const message = opts.message ?? "cloud congestion — auto-refunded";
  const doRefund = opts.refund ?? true;
  const cancel = await cancelModalForJob(job);

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
  if (!doRefund) {
    // Raw-YAML job — close it, mark the cost confirmed, no credit back.
    await updateJob(parentId, {
      refunded: false,
      metadata: { refunded: false, custom_yaml: true },
      status,
      error_message: message,
      completed_at: new Date().toISOString(),
    });
  } else if (!alreadyRefunded && amount > 0) {
    await refundCredits(job.user_id, amount);
    refunded = amount;
    await updateJob(parentId, {
      refunded: true,
      status,
      error_message: message,
      completed_at: new Date().toISOString(),
    });
  } else {
    // Already refunded once (or nothing to refund) — still make sure the row
    // isn't left stuck in 'processing'/'queued'.
    await updateJob(parentId, { status, error_message: message, completed_at: new Date().toISOString() });
  }
  if (parentId !== job.id) {
    await updateJob(job.id, {
      status,
      error_message: message,
      completed_at: new Date().toISOString(),
    });
  }
  return { refunded, modalCancelled: cancel.cancelled };
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
    // "abort"  — user pressed the stop button (queued OR processing).
    // "timeout"/"retry"/anything else — pending-stuck auto-failover.
    // Re-dispatch was removed entirely (it could loop and spawn GPU
    // containers without bound when the DB was behind on retry_count):
    // every path now just cancels + refunds + closes the job.
    const action: "abort" | "timeout" = body?.action === "abort" ? "abort" : "timeout";
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

    const abortable = job.status === "queued" || job.status === "processing";
    // Auto-failover only ever applies to a still-queued job; an explicit
    // abort also reaches a job the worker has already picked up.
    const acceptable = action === "abort" ? abortable : job.status === "queued";
    if (!acceptable) {
      return NextResponse.json({ ok: true, noop: true, status: job.status });
    }

    const yamlJob = isCustomYamlJob(job);

    if (action === "abort") {
      const { refunded, modalCancelled } = await closeWithRefund(job, {
        status: "cancelled",
        message: yamlJob
          ? "ユーザーによる中止（生YAMLモード — 返金対象外）"
          : "ユーザーによる中止 — 全額返金",
        refund: !yamlJob,
      });
      return NextResponse.json({ ok: true, status: "cancelled", refunded, modalCancelled, customYaml: yamlJob });
    }

    // "timeout" — pending-stuck failover. The job never left the queue, so no
    // GPU was billed: always refund, YAML or not.
    const { refunded, modalCancelled } = await closeWithRefund(job);
    return NextResponse.json({ ok: true, status: "failed_timeout", refunded, modalCancelled });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[studio/lora/recover] unhandled:", message, err instanceof Error ? err.stack : undefined);
    return NextResponse.json({ error: "リカバリ処理に失敗しました。", reason: message }, { status: 500 });
  }
}
