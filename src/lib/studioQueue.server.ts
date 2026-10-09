import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { dispatchAngleJob, type AngleDispatchSpec } from "@/lib/angleDispatch.server";
import {
  dispatchUpscaleBatch,
  dispatchUpscaleImage,
  dispatchUpscaleVideo,
  type UpscaleImageQueueSpec,
  type UpscaleVideoSpec,
} from "@/lib/upscaleDispatch.server";
import { dispatchDirectorJob, type DirectorDispatchSpec } from "@/lib/directorDispatch.server";
import { dispatchSongJob, type SongDispatchSpec } from "@/lib/modalSong";
import { dispatchFaceSwapJob, type FaceSwapDispatchSpec } from "@/lib/modalFaceSwap";
import { rememberGenerationCall } from "@/lib/modalCallRecord.server";
import { deleteStudioUploads } from "@/lib/studioUploads.server";

/**
 * 予約（順番待ち）をサーバー側で流す（2026-10-03）。
 *
 * それまでの予約は画面のメモリにだけあり、タブを閉じると消えた。今は:
 *   1. 予約した時点で検証・課金し、ジョブ行を status 'reserved' で作る（起動の引数は studio_dispatch_specs）。
 *   2. advanceQueue(kind, userId) が「同じ人・同じ種類で動いているものが無ければ」reserved の古い順 1 件を起動する。
 *      取り出しは DB 関数 claim_next_reserved_job（advisory lock で二重起動しない）。
 *   3. advance のきっかけ: 予約した直後／前のジョブの完了・失敗（DB トリガー → pg_net → /api/studio/queue/advance）／
 *      画面が完了を見たとき／画面を開いたとき。
 * 始まったら完走のルールは不変。取り消せるのは reserved のうちだけ（全額返金・行ごと消す）。
 */
export type QueueKind = "angle" | "upscale_image" | "upscale_video" | "director" | "song" | "face_swap";

// "song"（曲づくり、2026-10-06）は supabase/migrations/20260896000000_song_studio_queue.sql の適用が要る（kind の制約・取り出し・トリガー）。
// "face_swap"（顔入れ替え、2026-10-09）は supabase/migrations/20260900000000_face_swap_jobs.sql の適用が要る（同上）。
export const QUEUE_KINDS: QueueKind[] = ["angle", "upscale_image", "upscale_video", "director", "song", "face_swap"];

export function isQueueKind(v: unknown): v is QueueKind {
  return typeof v === "string" && (QUEUE_KINDS as string[]).includes(v);
}

type KindDef = {
  table: "angle_jobs" | "upscale_jobs" | "generation_jobs";
  /** 予約行を絞る追加条件（同じ表に別の種類が同居している分）。 */
  match: Record<string, string>;
  dispatch: (jobId: string, userId: string, spec: unknown) => Promise<void>;
  /** 予約の取り消しで消すアップロード。 */
  uploads: (spec: unknown) => string[];
  /** 1 つの予約で複数行を作る種類（超解像のまとめ）: 起動・返金をまとめて扱う行。無ければ取り出した 1 行だけ。 */
  unitJobIds?: (spec: unknown) => string[] | null;
};

const KINDS: Partial<Record<QueueKind, KindDef>> = {
  angle: {
    table: "angle_jobs",
    match: {},
    dispatch: (jobId, userId, spec) => dispatchAngleJob(jobId, userId, spec as AngleDispatchSpec),
    uploads: (spec) => (spec as AngleDispatchSpec).storagePaths ?? [],
  },
  upscale_image: {
    table: "upscale_jobs",
    match: { media_type: "image" },
    dispatch: (jobId, userId, spec) => {
      const s = spec as UpscaleImageQueueSpec;
      return s.type === "batch" ? dispatchUpscaleBatch(userId, s) : dispatchUpscaleImage(jobId, userId, s);
    },
    uploads: (spec) => {
      const s = spec as UpscaleImageQueueSpec;
      return s.type === "batch" ? s.items.map((it) => it.storagePath) : [s.storagePath];
    },
    unitJobIds: (spec) => {
      const s = spec as UpscaleImageQueueSpec;
      return s.type === "batch" ? s.items.map((it) => it.jobId) : null;
    },
  },
  upscale_video: {
    table: "upscale_jobs",
    match: { media_type: "video" },
    dispatch: (jobId, userId, spec) => dispatchUpscaleVideo(jobId, userId, spec as UpscaleVideoSpec),
    uploads: (spec) => [(spec as UpscaleVideoSpec).storagePath],
  },
  director: {
    table: "generation_jobs",
    match: { workflow_type: "director" },
    dispatch: (jobId, userId, spec) => dispatchDirectorJob(jobId, userId, spec as DirectorDispatchSpec),
    // 参照画像は作り直し用に 14 日残す（取り消しても消さない。作り直しの元が同じ画像のこともある）。
    uploads: () => [],
  },
  song: {
    table: "generation_jobs",
    match: { workflow_type: "song" },
    dispatch: async (jobId, userId, spec) => {
      const { callId } = await dispatchSongJob(jobId, userId, spec as SongDispatchSpec);
      await rememberGenerationCall(jobId, callId);
    },
    uploads: () => [],
  },
  face_swap: {
    table: "generation_jobs",
    match: { workflow_type: "face_swap" },
    dispatch: async (jobId, userId, spec) => {
      const { callId } = await dispatchFaceSwapJob(jobId, userId, spec as FaceSwapDispatchSpec);
      await rememberGenerationCall(jobId, callId);
    },
    // 同じ画像で入れ替え直すことがあるので消さない（R2 の 14 日の期限で消える）。
    uploads: () => [],
  },
};

function kindDef(kind: QueueKind): KindDef {
  const def = KINDS[kind];
  if (!def) throw new Error(`queue kind not supported yet: ${kind}`);
  return def;
}

/** 予約の起動引数を保存する（ジョブ行を reserved で作った直後に呼ぶ）。 */
export async function saveDispatchSpec(kind: QueueKind, jobId: string, userId: string, spec: unknown): Promise<void> {
  const { error } = await supabaseAdmin
    .from("studio_dispatch_specs")
    .insert({ job_id: jobId, kind, user_id: userId, spec });
  if (error) throw new Error(`予約の保存に失敗しました: ${error.message}`);
}

async function refundCredits(userId: string, amount: number): Promise<boolean> {
  if (amount <= 0) return true;
  const { data } = await supabaseAdmin.from("profiles").select("credits").eq("id", userId).single();
  const current = (data?.credits as number | null) ?? 0;
  const { error } = await supabaseAdmin.from("profiles").update({ credits: current + amount }).eq("id", userId);
  if (error) {
    console.error("[studioQueue] refund failed:", userId, amount, error.message);
    return false;
  }
  return true;
}

/** 起動の引数を探す。まとめの予約は代表 1 行（先頭）にだけ持つので、無ければ同じまとめの分を探す。 */
async function findSpec(def: KindDef, jobId: string): Promise<{ key: string; spec: unknown } | null> {
  const { data } = await supabaseAdmin
    .from("studio_dispatch_specs")
    .select("job_id, spec")
    .eq("job_id", jobId)
    .maybeSingle();
  if (data) return { key: data.job_id as string, spec: data.spec };
  if (def.table !== "upscale_jobs") return null;
  const { data: row } = await supabaseAdmin.from("upscale_jobs").select("batch_id").eq("id", jobId).maybeSingle();
  const batchId = row?.batch_id as string | null | undefined;
  if (!batchId) return null;
  const { data: bySpec } = await supabaseAdmin
    .from("studio_dispatch_specs")
    .select("job_id, spec")
    .eq("spec->>batchId", batchId)
    .maybeSingle();
  return bySpec ? { key: bySpec.job_id as string, spec: bySpec.spec } : null;
}

/** 起動に失敗した行を閉じて全額返す（始まっていないので GPU は使っていない）。 */
async function failAndRefund(def: KindDef, jobId: string, userId: string, message: string): Promise<void> {
  const { data: row } = await supabaseAdmin
    .from(def.table)
    .select("credits_cost, metadata")
    .eq("id", jobId)
    .maybeSingle();
  const cost = ((row?.credits_cost as number | null) ?? 0) | 0;
  const refunded = await refundCredits(userId, cost);
  const meta = (row?.metadata as Record<string, unknown> | null) ?? {};
  await supabaseAdmin
    .from(def.table)
    .update({
      status: "failed",
      error_message: `ジョブの起動に失敗しました: ${message}`.slice(0, 500),
      metadata: { ...meta, ...(refunded && cost > 0 ? { refunded: true } : {}) },
    })
    .eq("id", jobId);
}

/**
 * 順番が来ていれば次の 1 件を起動する。起動したジョブ id（無ければ null）を返す。
 * 起動に失敗した予約は返金して閉じ、その次を試す。
 */
export async function advanceQueue(kind: QueueKind, userId: string): Promise<string | null> {
  const def = kindDef(kind);
  for (let guard = 0; guard < 5; guard++) {
    const { data: claimed, error } = await supabaseAdmin.rpc("claim_next_reserved_job", {
      p_kind: kind,
      p_user_id: userId,
    });
    if (error) {
      console.error("[studioQueue] claim failed:", kind, userId, error.message);
      return null;
    }
    const jobId = typeof claimed === "string" ? claimed : null;
    if (!jobId) return null;

    const found = await findSpec(def, jobId);
    const unit = (found && def.unitJobIds?.(found.spec)) || [jobId];
    try {
      if (!found) throw new Error("予約の内容が見つかりません。");
      await def.dispatch(jobId, userId, found.spec);
      await supabaseAdmin.from("studio_dispatch_specs").delete().eq("job_id", found.key);
      console.log(`[studioQueue] dispatched ${kind} ${jobId} (${unit.length} rows, user ${userId})`);
      return jobId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[studioQueue] dispatch failed:", kind, jobId, message);
      for (const id of unit) await failAndRefund(def, id, userId, message);
      await supabaseAdmin.from("studio_dispatch_specs").delete().eq("job_id", found?.key ?? jobId);
    }
  }
  return null;
}

/**
 * その人の予約（古い順）。画面の「予約中」一覧用。超解像のまとめの行は含めない（まとめの画面は自分の行の状態で見る）。
 */
export async function listReserved(kind: QueueKind, userId: string): Promise<{ id: string; created_at: string }[]> {
  const def = kindDef(kind);
  let q = supabaseAdmin
    .from(def.table)
    .select("id, created_at")
    .eq("user_id", userId)
    .eq("status", "reserved");
  for (const [k, v] of Object.entries(def.match)) q = q.eq(k, v);
  if (def.table === "upscale_jobs") q = q.is("batch_id", null);
  const { data } = await q.order("created_at", { ascending: true });
  return (data ?? []) as { id: string; created_at: string }[];
}

/**
 * 予約を取り消す（jobIds を省くとその人の同じ種類の予約を全部）。reserved のうちだけ・全額返金・行ごと消す
 * （始まっていないので生成ログにも残さない）。取り消したジョブ id と返金額を返す。
 */
export async function cancelReserved(
  kind: QueueKind,
  userId: string,
  jobIds?: string[],
): Promise<{ cancelled: string[]; refunded: number }> {
  const def = kindDef(kind);
  let q = supabaseAdmin
    .from(def.table)
    .delete()
    .eq("user_id", userId)
    .eq("status", "reserved");
  for (const [k, v] of Object.entries(def.match)) q = q.eq(k, v);
  if (jobIds && jobIds.length > 0) q = q.in("id", jobIds);
  // status を条件に消すので、同時に起動へ回った行（pending へ変わった）は消えない。
  const { data: rows, error } = await q.select("id, credits_cost");
  if (error) throw new Error(error.message);
  const deleted = (rows ?? []) as { id: string; credits_cost: number | null }[];
  if (deleted.length === 0) return { cancelled: [], refunded: 0 };

  const ids = deleted.map((r) => r.id);
  const { data: specs } = await supabaseAdmin
    .from("studio_dispatch_specs")
    .delete()
    .in("job_id", ids)
    .select("spec");
  deleteStudioUploads((specs ?? []).flatMap((s) => def.uploads(s.spec)));

  const total = deleted.reduce((t, r) => t + (r.credits_cost ?? 0), 0);
  const ok = await refundCredits(userId, total);
  return { cancelled: ids, refunded: ok ? total : 0 };
}

/** 予約が残っている人をすべて advance する（日次 cron の取りこぼし掃除）。 */
export async function sweepAllQueues(): Promise<number> {
  let started = 0;
  for (const kind of QUEUE_KINDS) {
    const def = KINDS[kind];
    if (!def) continue;
    let q = supabaseAdmin.from(def.table).select("user_id").eq("status", "reserved");
    for (const [k, v] of Object.entries(def.match)) q = q.eq(k, v);
    const { data } = await q.limit(1000);
    const users = [...new Set((data ?? []).map((r) => r.user_id as string))];
    for (const uid of users) if (await advanceQueue(kind, uid)) started++;
  }
  return started;
}

/** Authorization: Bearer <ユーザーのアクセストークン> からユーザー id を取る（無効なら null）。 */
export async function userIdFromBearer(request: Request): Promise<string | null> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  return error || !data?.user ? null : data.user.id;
}
