import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { cancelLoraTrainingCall } from "@/lib/modalLoraTrain";

// admin「最近の生成物」— マルチアングル系（angle_jobs: マルチアングル・素材づくり・参照づくりの候補）と
// 動画（generation_jobs: Cinematic Director・特化 WF）の中止（2026-09-29、ホスト「停止ボタンを全般に」）。
// Modal 側を止めても DB が processing のまま残り、画面が生成中で固まっていた（angle_jobs cc508d01）。
//
// やること: ① 行を failed で閉じる（reserved/pending/processing のときだけ・二重に閉じない。reserved＝予約は全額）
//          ② 返金（refund=true のとき。angle は未完了の構図ぶん、動画は全額）
//          ③ 起動時に残した Modal の実行 id があれば、その実行を取り消す（GPU を止める）
// generation_logs はステータス変更のトリガーが拾う。
const ABORT_MESSAGE = "管理者が中止しました。";

type Kind = "angle" | "video";

export async function POST(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  let body: { kind?: unknown; jobId?: unknown; refund?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です。" }, { status: 400 });
  }
  const kind = body.kind === "angle" || body.kind === "video" ? (body.kind as Kind) : null;
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const refund = body.refund === true;
  if (!kind || !jobId) return NextResponse.json({ error: "kind と jobId が必要です。" }, { status: 400 });

  let userId = "";
  let refundAmount = 0;
  let callId = "";
  let closed = false;

  if (kind === "angle") {
    const { data: row, error } = await supabaseAdmin
      .from("angle_jobs")
      .select("id, user_id, status, credits_cost, total_angles, completed_angles, metadata")
      .eq("id", jobId)
      .maybeSingle();
    if (error || !row) return NextResponse.json({ error: error?.message ?? "ジョブが見つかりません。" }, { status: 404 });
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};
    callId = typeof meta.modal_call_id === "string" ? meta.modal_call_id : "";
    userId = row.user_id as string;
    if (row.status === "reserved" || row.status === "pending" || row.status === "processing") {
      const total = Math.max(1, (row.total_angles as number) ?? 1);
      const done = Math.min(total, (row.completed_angles as number) ?? 0);
      refundAmount = refund ? Math.round((((row.credits_cost as number) ?? 0) * (total - done)) / total) : 0;
      const { data: updated } = await supabaseAdmin
        .from("angle_jobs")
        .update({
          status: "failed",
          error_message: refundAmount > 0 ? `${ABORT_MESSAGE}（未完了分 ${refundAmount}C を返金）` : ABORT_MESSAGE,
          metadata: { ...meta, aborted_by_admin: true, ...(refundAmount > 0 ? { refunded: refundAmount } : {}) },
        })
        .eq("id", jobId)
        .eq("status", row.status)
        .select("id");
      closed = Boolean(updated?.length);
    }
  } else {
    const { data: row, error } = await supabaseAdmin
      .from("generation_jobs")
      .select("id, user_id, status, credits_cost, workflow_type, modal_call_id")
      .eq("id", jobId)
      .maybeSingle();
    if (error || !row) return NextResponse.json({ error: error?.message ?? "ジョブが見つかりません。" }, { status: 404 });
    if (row.workflow_type === "lora_training") {
      return NextResponse.json({ error: "LoRA 学習は「強制終了」を使ってください。" }, { status: 400 });
    }
    callId = typeof row.modal_call_id === "string" ? row.modal_call_id : "";
    userId = row.user_id as string;
    if (row.status === "reserved" || row.status === "queued" || row.status === "pending" || row.status === "processing") {
      refundAmount = refund ? ((row.credits_cost as number) ?? 0) : 0;
      const { data: updated } = await supabaseAdmin
        .from("generation_jobs")
        .update({
          status: "failed",
          error_message: refundAmount > 0 ? `${ABORT_MESSAGE}（${refundAmount}C を返金）` : ABORT_MESSAGE,
        })
        .eq("id", jobId)
        .eq("status", row.status)
        .select("id");
      closed = Boolean(updated?.length);
    }
  }

  // 予約（reserved）を閉じたら、起動の引数も捨てる（無ければ何もしない）。
  if (closed) await supabaseAdmin.from("studio_dispatch_specs").delete().eq("job_id", jobId);

  // 返金は行を閉じられたときだけ（ワーカーが同時に完了を書いたら触らない）。
  let refunded = 0;
  if (closed && refundAmount > 0 && userId) {
    const { data } = await supabaseAdmin.from("profiles").select("credits").eq("id", userId).single();
    const current = (data?.credits as number | null) ?? 0;
    const { error } = await supabaseAdmin.from("profiles").update({ credits: current + refundAmount }).eq("id", userId);
    if (error) console.error("[admin/jobs/abort] refund failed:", userId, refundAmount, error.message);
    else refunded = refundAmount;
  }

  // Modal の実行を取り消す（閉じられなかった＝既に終わっていたなら不要）。
  const cancelled = closed && callId.startsWith("fc-") ? await cancelLoraTrainingCall(callId) : false;

  console.log(
    `[admin/jobs/abort] ${kind} ${jobId}: closed=${closed} refunded=${refunded}C cancel=${callId || "-"}->${cancelled} (by ${user.email})`,
  );
  return NextResponse.json({ ok: true, closed, refunded, cancelled, hadCallId: Boolean(callId) });
}
