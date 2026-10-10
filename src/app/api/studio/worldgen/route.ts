import { NextResponse } from "next/server";
import { debitCredits, refundCredits } from "@/lib/credits.server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { requireFeature, userFromBearer } from "@/lib/features.server";
import { assertOwnedPath } from "@/lib/studioUploads.server";
import { WORLDGEN_PROMPT_MAX_LENGTH, worldgenCredits, worldgenPriorityParallelSurcharge } from "@/lib/worldgenPricing";
import { dispatchWorldgenJob, type WorldgenDispatchSpec } from "@/lib/modalWorldgen";
import { rememberGenerationCall } from "@/lib/modalCallRecord.server";
import { advanceQueue, saveDispatchSpec } from "@/lib/studioQueue.server";
import { DirectorPromptError, looksJapanese, translateJapanesePromptToEnglish } from "@/lib/directorPrompt";
import { CONTENT_POLICY_BLOCK_MESSAGE, evaluateContentPolicyMany, logContentPolicyBlock } from "@/lib/contentPolicy";

// 背景づくり（WorldGen・2026-10-10・許可制 worldgen_trial）: 部屋の説明（または部屋の画像 1 枚）→ 課金 → Modal
// （modal_worldgen_worker.py・RTX PRO 6000）で 360 度パノラマと 3DGS を作る。ジョブは generation_jobs（workflow_type "worldgen"）。
// 結果は /api/jobs/[id] が R2 の署名 URL（imageUrls＝パノラマ・plyUrl）で返す。予約は顔入れ替えと同じ（要 migration 20260901000000）。
// 説明は英語の方がよく効くので、日本語なら英語に直してから渡す（Director の翻訳を流用）。
export const maxDuration = 60;

export async function POST(request: Request) {
  const user = await userFromBearer(request);
  if (!user) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  const denied = await requireFeature(user, "worldgen_trial");
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const mode = body.mode === "i2s" ? "i2s" : "t2s";
  const promptIn = typeof body.prompt === "string" ? body.prompt.trim().slice(0, WORLDGEN_PROMPT_MAX_LENGTH) : "";
  const imagePath = typeof body.imagePath === "string" ? body.imagePath : "";
  if (mode === "t2s" && !promptIn) return NextResponse.json({ error: "どんな部屋にしたいかを書いてください。" }, { status: 400 });
  if (mode === "i2s") {
    if (!imagePath) return NextResponse.json({ error: "部屋の画像を入れてください。" }, { status: 400 });
    try {
      assertOwnedPath(user.id, imagePath);
    } catch {
      return NextResponse.json({ error: "不正なファイル指定です。" }, { status: 400 });
    }
  }
  const policy = evaluateContentPolicyMany([promptIn].filter(Boolean));
  if (policy.blocked) {
    logContentPolicyBlock("studio/worldgen", policy, user.id);
    return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
  }

  const queue = body.queue === true;
  const priority = !queue && body.priority === true;
  const knobs = await getPricingKnobs();
  const baseCost = worldgenCredits(knobs);
  const creditsCost = priority ? baseCost + worldgenPriorityParallelSurcharge(knobs, baseCost) : baseCost;

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

  // 説明を英語に（課金前。翻訳に失敗したら料金は引かずに止める）。
  let prompt = promptIn;
  if (prompt && looksJapanese(prompt)) {
    try {
      prompt = await translateJapanesePromptToEnglish(prompt);
    } catch (err) {
      const e = err as DirectorPromptError;
      const status = e.reason === "quota" ? 429 : e.reason === "busy" ? 503 : e.reason === "refusal" ? 409 : 502;
      return NextResponse.json({ error: e.message || "説明の翻訳に失敗しました。", remainingCredits: currentCredits }, { status });
    }
  }

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
    console.error("[worldgen] failed to debit credits:", err);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("generation_jobs")
    .insert({
      user_id: user.id,
      status: queue ? "reserved" : "queued",
      workflow_type: "worldgen",
      credits_cost: creditsCost,
      inputs: { mode, prompt_ja: promptIn || null, prompt, image_path: mode === "i2s" ? imagePath : null },
      metadata: { mode, priority },
    })
    .select("id")
    .single();
  if (jobError || !jobRow) {
    await refundCredits(user.id, creditsCost);
    return NextResponse.json({ error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits }, { status: 500 });
  }
  const jobId = jobRow.id as string;
  const spec: WorldgenDispatchSpec = { creditsCost, mode, prompt, imagePath: mode === "i2s" ? imagePath : null };

  if (queue) {
    try {
      await saveDispatchSpec("worldgen", jobId, user.id, spec);
    } catch (err) {
      console.error("[worldgen] save spec failed:", (err as Error).message);
      await supabaseAdmin.from("generation_jobs").delete().eq("id", jobId);
      await refundCredits(user.id, creditsCost);
      return NextResponse.json(
        { error: "予約に失敗しました。しばらくしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 500 },
      );
    }
    const started = await advanceQueue("worldgen", user.id);
    return NextResponse.json({ jobId, reserved: started !== jobId, creditsCost, remainingCredits: debited });
  }

  try {
    const { callId } = await dispatchWorldgenJob(jobId, user.id, spec);
    await rememberGenerationCall(jobId, callId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[worldgen] dispatch failed:", message);
    await supabaseAdmin
      .from("generation_jobs")
      .update({ status: "failed", error_message: message.slice(0, 2000), metadata: { mode, refunded: true } })
      .eq("id", jobId);
    await refundCredits(user.id, creditsCost);
    return NextResponse.json({ error: "生成の開始に失敗しました。", remainingCredits: currentCredits }, { status: 502 });
  }
  return NextResponse.json({ jobId, reserved: false, creditsCost, remainingCredits: debited });
}
