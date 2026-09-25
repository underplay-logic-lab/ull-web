import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// admin「最近の生成物」— 超解像の中止（2026-09-25、STATUS 000000 ②）。
// バッチ（まとめて処理）を途中で止めると、残りが pending のまま・クレジットも引き落とし済みのまま残っていた
// （2026-09-24 に 64 件・1,216C を手で閉じて返金）。LoRA の「強制終了」と同じく全額返金で閉じる。
//
// 閉じるのは「まだ始まっていない」行（pending）と、始まってから長く止まっている行（processing のまま
// STALE_PROCESSING_MS 以上）。今まさに処理中の 1 枚は完走させる（worker が完了を書くので、ここで閉じると
// 返金した画像が完成扱いになる）。worker は各画像の処理前に状態を見て failed なら飛ばすので
// （modal_seedvr2_worker.py の _process_one_upscale_item）、動いている worker もそこで止まる。
//
// 状態は 'failed'（upscale_jobs の CHECK に cancelled が無い）、metadata.refunded = true。
// generation_logs のトリガーが「始まっていない＝実行 0・原価 0」「返金済み＝売上 0」で記録する。
const STALE_PROCESSING_MS = 15 * 60 * 1000;
const ABORT_MESSAGE = "管理者が中止しました（返金済み）。";

type Row = {
  id: string;
  user_id: string;
  status: string;
  credits_cost: number | null;
  batch_id: string | null;
  processing_started_at: string | null;
  metadata: Record<string, unknown> | null;
};

export async function POST(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  let body: { jobId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です。" }, { status: 400 });
  }
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  if (!jobId) return NextResponse.json({ error: "jobId が必要です。" }, { status: 400 });

  const cols = "id, user_id, status, credits_cost, batch_id, processing_started_at, metadata";
  const { data: head, error: headErr } = await supabaseAdmin.from("upscale_jobs").select(cols).eq("id", jobId).maybeSingle();
  if (headErr || !head) {
    return NextResponse.json({ error: headErr?.message ?? "ジョブが見つかりません。" }, { status: 404 });
  }
  const first = head as Row;

  let rows: Row[] = [first];
  if (first.batch_id) {
    const { data, error } = await supabaseAdmin
      .from("upscale_jobs")
      .select(cols)
      .eq("batch_id", first.batch_id)
      .in("status", ["pending", "processing"]);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    rows = (data ?? []) as Row[];
  }

  const now = Date.now();
  const targets = rows.filter((r) => {
    if (r.metadata?.refunded === true) return false;
    if (r.status === "pending") return true;
    if (r.status !== "processing") return false;
    const started = r.processing_started_at ? Date.parse(r.processing_started_at) : NaN;
    return !Number.isFinite(started) || now - started >= STALE_PROCESSING_MS;
  });
  const running = rows.filter((r) => r.status === "processing" && !targets.includes(r)).length;

  // 1 行ずつ「pending/processing のときだけ」閉じる。worker が同時に完了を書いた行は触らない（二重返金しない）。
  const refundByUser = new Map<string, number>();
  let closed = 0;
  for (const r of targets) {
    const { data: updated, error } = await supabaseAdmin
      .from("upscale_jobs")
      .update({
        status: "failed",
        error_message: ABORT_MESSAGE,
        metadata: { ...(r.metadata ?? {}), refunded: true, aborted_by_admin: true },
      })
      .eq("id", r.id)
      .eq("status", r.status)
      .select("id");
    if (error) {
      console.error("[admin/upscale/abort] update failed:", r.id, error.message);
      continue;
    }
    if (!updated?.length) continue;
    closed += 1;
    refundByUser.set(r.user_id, (refundByUser.get(r.user_id) ?? 0) + (r.credits_cost ?? 0));
  }

  let refunded = 0;
  for (const [userId, amount] of refundByUser) {
    if (amount <= 0) continue;
    const { data } = await supabaseAdmin.from("profiles").select("credits").eq("id", userId).single();
    const current = (data?.credits as number | null) ?? 0;
    const { error } = await supabaseAdmin.from("profiles").update({ credits: current + amount }).eq("id", userId);
    if (error) {
      console.error("[admin/upscale/abort] refund failed:", userId, amount, error.message);
      continue;
    }
    refunded += amount;
  }

  console.log(
    `[admin/upscale/abort] job ${jobId} batch=${first.batch_id ?? "-"}: closed ${closed}, refunded ${refunded}C, ` +
      `left running ${running} (by ${user.email})`,
  );
  return NextResponse.json({ ok: true, closed, refunded, running });
}
