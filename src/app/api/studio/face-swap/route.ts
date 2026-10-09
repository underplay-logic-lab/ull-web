import { NextResponse } from "next/server";
import { debitCredits, refundCredits } from "@/lib/credits.server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { requireFeature, userFromBearer } from "@/lib/features.server";
import { assertOwnedPath } from "@/lib/studioUploads.server";
import {
  FACE_SWAP_MAX_PEOPLE,
  faceSwapCredits,
  faceSwapPriorityParallelSurcharge,
  isFaceSwapSide,
} from "@/lib/faceSwapPricing";
import { dispatchFaceSwapJob, type FaceSwapDispatchSpec } from "@/lib/modalFaceSwap";
import { rememberGenerationCall } from "@/lib/modalCallRecord.server";
import { advanceQueue, saveDispatchSpec } from "@/lib/studioQueue.server";

// 顔入れ替え（2026-10-09・許可制 face_swap_head）: 入れ替え先の画像 1 枚と、顔の参照を人数分（最大 2）→ 課金 → Modal
// （modal_faceswap_worker.py・RTX PRO 6000）。ジョブは generation_jobs（workflow_type "face_swap"）。
// 結果は /api/jobs/[id] が R2 の署名 URL で返す。予約（順番待ち）は曲づくりと同じサーバー側の仕組み（要 migration 20260900000000）。
// 画像はブラウザが R2 へ直接上げ（studioUploads.ts）、ここには path だけが来る。
export const maxDuration = 60;

export async function POST(request: Request) {
  const user = await userFromBearer(request);
  if (!user) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  const denied = await requireFeature(user, "face_swap_head");
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const bodyPath = typeof body.bodyPath === "string" ? body.bodyPath : "";
  const rawSwaps = Array.isArray(body.swaps) ? body.swaps : [];
  if (!bodyPath) return NextResponse.json({ error: "入れ替え先の画像を入れてください。" }, { status: 400 });
  if (rawSwaps.length < 1) return NextResponse.json({ error: "顔の画像を入れてください。" }, { status: 400 });
  if (rawSwaps.length > FACE_SWAP_MAX_PEOPLE) {
    return NextResponse.json({ error: `一度に入れ替えられるのは ${FACE_SWAP_MAX_PEOPLE} 人までです。` }, { status: 400 });
  }
  const swaps: FaceSwapDispatchSpec["swaps"] = [];
  for (const raw of rawSwaps) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const facePath = typeof r.facePath === "string" ? r.facePath : "";
    if (!facePath) return NextResponse.json({ error: "顔の画像を入れてください。" }, { status: 400 });
    if (!isFaceSwapSide(r.side)) return NextResponse.json({ error: "入れ替える人の指定が正しくありません。" }, { status: 400 });
    swaps.push({ facePath, side: r.side === "auto" ? "" : r.side });
  }
  // 2 人のときは左右を必ず指定し、同じ側を 2 回選ばない（1 人目の結果に 2 人目を重ねるので、同じ人を 2 回描き直すことになる）。
  if (swaps.length > 1) {
    const sides = swaps.map((s) => s.side);
    if (sides.some((s) => !s) || new Set(sides).size !== sides.length) {
      return NextResponse.json({ error: "2 人を入れ替えるときは、左の人と右の人を 1 人ずつ選んでください。" }, { status: 400 });
    }
  }
  try {
    assertOwnedPath(user.id, bodyPath);
    for (const s of swaps) assertOwnedPath(user.id, s.facePath);
  } catch {
    return NextResponse.json({ error: "不正なファイル指定です。" }, { status: 400 });
  }

  const queue = body.queue === true;
  const priority = !queue && body.priority === true;
  const knobs = await getPricingKnobs();
  const baseCost = faceSwapCredits(swaps.length, knobs);
  const creditsCost = priority ? baseCost + faceSwapPriorityParallelSurcharge(knobs, baseCost) : baseCost;

  const { data: profile, error: profileError } = await getOrCreateProfile(user.id, "credits, credits_expire_at");
  if (profileError) return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  const expireAt = profile?.credits_expire_at as string | null | undefined;
  const rawCredits = (profile?.credits as number | null | undefined) ?? 0;
  const isExpired = expireAt ? new Date(expireAt).getTime() < Date.now() : false;
  const currentCredits = isExpired ? 0 : rawCredits;
  if (isExpired && rawCredits > 0) await supabaseAdmin.from("profiles").update({ credits: 0 }).eq("id", user.id);
  if (currentCredits < creditsCost) {
    return NextResponse.json(
      {
        error: isExpired
          ? "クレジットの有効期限が切れています。チャージしてから再度お試しください。"
          : "クレジットが不足しています。チャージしてから再度お試しください。",
        remainingCredits: currentCredits,
      },
      { status: 402 },
    );
  }

  // クレジットはその場で引く（確かめるのと引くのを 1 回の操作に、CLAUDE.md §3）。
  let debited: number;
  try {
    const after = await debitCredits(user.id, creditsCost);
    if (after === null) {
      return NextResponse.json(
        { error: "クレジットが不足しています。チャージしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 402 },
      );
    }
    debited = after;
  } catch (err) {
    console.error("[face-swap] failed to debit credits:", err);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  const seed = 1 + Math.floor(Math.random() * 2 ** 31);
  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("generation_jobs")
    .insert({
      user_id: user.id,
      status: queue ? "reserved" : "queued",
      workflow_type: "face_swap",
      credits_cost: creditsCost,
      inputs: { body_path: bodyPath, swaps, seed },
      metadata: { people: swaps.length, priority },
    })
    .select("id")
    .single();
  if (jobError || !jobRow) {
    await refundCredits(user.id, creditsCost);
    return NextResponse.json({ error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits }, { status: 500 });
  }
  const jobId = jobRow.id as string;
  const spec: FaceSwapDispatchSpec = { creditsCost, seed, bodyPath, swaps };

  if (queue) {
    try {
      await saveDispatchSpec("face_swap", jobId, user.id, spec);
    } catch (err) {
      console.error("[face-swap] save spec failed:", (err as Error).message);
      await supabaseAdmin.from("generation_jobs").delete().eq("id", jobId);
      await refundCredits(user.id, creditsCost);
      return NextResponse.json(
        { error: "予約に失敗しました。しばらくしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 500 },
      );
    }
    const started = await advanceQueue("face_swap", user.id);
    return NextResponse.json({ jobId, reserved: started !== jobId, creditsCost, remainingCredits: debited });
  }

  try {
    const { callId } = await dispatchFaceSwapJob(jobId, user.id, spec);
    await rememberGenerationCall(jobId, callId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[face-swap] dispatch failed:", message);
    await supabaseAdmin
      .from("generation_jobs")
      .update({ status: "failed", error_message: message.slice(0, 2000), metadata: { people: swaps.length, refunded: true } })
      .eq("id", jobId);
    await refundCredits(user.id, creditsCost);
    return NextResponse.json({ error: "生成の開始に失敗しました。", remainingCredits: currentCredits }, { status: 502 });
  }
  return NextResponse.json({ jobId, reserved: false, creditsCost, remainingCredits: debited });
}
