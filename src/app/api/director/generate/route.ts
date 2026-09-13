import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { downloadStudioUpload, deleteStudioUploads } from "@/lib/studioUploads.server";
import { readImageDimensions } from "@/lib/imageDimensions";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import {
  directorCostBreakdown,
  directorCreditsWorstCase,
  directorPollDeadlineS,
  validateDirectorScenes,
} from "@/lib/directorPricing";
import { DirectorPromptError, expandDirectorScenes } from "@/lib/directorPrompt";
import { buildCinematicWorkflow } from "@/lib/cinematicWorkflow";
import { CINEMATIC_MODE_BY_ID } from "@/lib/cinematicPricing";
import { spawnDirectorJob } from "@/lib/modalDirector";
import {
  CONTENT_POLICY_BLOCK_MESSAGE,
  evaluateContentPolicyMany,
  logContentPolicyBlock,
} from "@/lib/contentPolicy";

// Phase 1（Gemini によるシーン合成）+ Phase 2（MiniMax H3 ディスパッチ）を
// 1つの route でまとめて行う非同期ジョブ起点。生成そのものは待たない
// （spawnDirectorJob が .spawn() して即 ACK、実処理は generation_jobs の行を
// 直接 PATCH — /api/jobs/[id] でポーリング）。
export const maxDuration = 60;

export async function POST(request: Request) {
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
  const user = userData.user;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const storagePath = typeof body.storagePath === "string" ? body.storagePath : "";
  if (!storagePath) {
    return NextResponse.json({ error: "参照画像をアップロードしてください。" }, { status: 400 });
  }

  const validated = validateDirectorScenes(body.scenes);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const scenes = validated.scenes;

  // レッドライン・フィルター（他の生成系エンドポイントと同一の入口対策）。
  const policyResult = evaluateContentPolicyMany(scenes.map((s) => s.text));
  if (policyResult.blocked) {
    logContentPolicyBlock("director/generate", policyResult, user.id);
    return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
  }

  let imageBuffer: Buffer;
  try {
    imageBuffer = await downloadStudioUpload(user.id, storagePath);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  if (imageBuffer.length === 0) {
    return NextResponse.json({ error: "参照画像の取得に失敗しました。" }, { status: 400 });
  }

  const knobs = await getPricingKnobs();
  const breakdown = directorCostBreakdown({ sceneCount: scenes.length, knobs });
  const creditsCost = breakdown.credits || directorCreditsWorstCase(knobs);

  // --- credits ---------------------------------------------------------
  const { data: profile, error: profileError } = await getOrCreateProfile(
    user.id,
    "credits, credits_expire_at",
  );
  if (profileError) {
    console.error("[director/generate] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }
  const creditsExpireAt = profile?.credits_expire_at as string | null | undefined;
  const rawCredits = profile?.credits as number | null | undefined;
  const isExpired = creditsExpireAt ? new Date(creditsExpireAt).getTime() < Date.now() : false;
  const currentCredits = isExpired ? 0 : rawCredits ?? 0;

  if (isExpired && (rawCredits ?? 0) > 0) {
    await supabaseAdmin.from("profiles").update({ credits: 0 }).eq("id", user.id);
  }
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

  // --- Phase 1: Gemini でシーン合成（1本の連続した英語プロンプトへ） -------
  let combinedPrompt: string;
  try {
    combinedPrompt = await expandDirectorScenes(scenes);
  } catch (err) {
    const e = err as DirectorPromptError;
    const status = e.reason === "quota" ? 429 : e.reason === "busy" ? 503 : e.reason === "not_configured" ? 501 : 502;
    return NextResponse.json({ error: e.message }, { status });
  }

  // 課金前の最終防波堤としてもう一度（Gemini が合成した英語文にも念のため）。
  const combinedPolicy = evaluateContentPolicyMany([combinedPrompt]);
  if (combinedPolicy.blocked) {
    logContentPolicyBlock("director/generate:combined", combinedPolicy, user.id);
    return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
  }

  const debitedCredits = currentCredits - creditsCost;
  const { error: debitError } = await supabaseAdmin
    .from("profiles")
    .update({ credits: debitedCredits })
    .eq("id", user.id);
  if (debitError) {
    console.error("[director/generate] failed to debit credits:", debitError.message);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  // --- job row -----------------------------------------------------------
  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("generation_jobs")
    .insert({
      user_id: user.id,
      status: "queued",
      workflow_type: "director",
      inputs: {
        scenes,
        combined_prompt: combinedPrompt,
        total_duration_s: breakdown.totalDurationS,
      },
      credits_cost: creditsCost,
      metadata: { scene_count: scenes.length, total_duration_s: breakdown.totalDurationS },
    })
    .select("id")
    .single();

  if (jobError || !jobRow) {
    console.error("[director/generate] failed to create job row:", jobError?.message);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      { error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits },
      { status: 500 },
    );
  }
  const jobId = jobRow.id as string;

  // --- Phase 2: MiniMax H3 へディスパッチ ---------------------------------
  const mode = CINEMATIC_MODE_BY_ID.speed; // v1: 4ステップ・実測済みの安全な設定に固定
  const referenceImageName = storagePath.split("/").pop() || "reference.png";
  // 実画像の生の寸法を渡す（cinematicWorkflow.ts の cinematicSafeDimensions
  // が「ピクセル ≡ 16 (mod 32)」を満たす安全な width/height を計算する —
  // 2026-09-13 実障害の修正。渡さないと正方形前提にフォールバックし、
  // 任意アスペクト比の入力で patchify がクラッシュしうる）。
  const rawDims = readImageDimensions(imageBuffer);
  const workflow = buildCinematicWorkflow({
    mode,
    prompt: combinedPrompt,
    referenceImageName,
    durationS: breakdown.totalDurationS,
    promptIsComplete: true,
    rawImageWidth: rawDims?.width,
    rawImageHeight: rawDims?.height,
  });

  try {
    await spawnDirectorJob({
      jobId,
      userId: user.id,
      creditsCost,
      workflow,
      referenceImageName,
      referenceImageB64: imageBuffer.toString("base64"),
      pollDeadlineS: directorPollDeadlineS(breakdown.totalDurationS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[director/generate] dispatch failed:", message);
    await supabaseAdmin
      .from("generation_jobs")
      .update({ status: "failed", error_message: message.slice(0, 2000) })
      .eq("id", jobId);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      { error: "生成の開始に失敗しました。", remainingCredits: currentCredits },
      { status: 502 },
    );
  } finally {
    deleteStudioUploads([storagePath]);
  }

  return NextResponse.json({
    jobId,
    creditsCost,
    remainingCredits: debitedCredits,
    totalDurationS: breakdown.totalDurationS,
  });
}
