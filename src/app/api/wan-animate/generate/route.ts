import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { generateWithModal } from "@/lib/modalWanAnimate";
import { buildWanAnimateWorkflow } from "@/lib/wanAnimateWorkflow";
import { logGenerationActivity } from "@/lib/generationLogger";
import { getWanAnimateGenerationCost } from "@/lib/wanAnimatePricing";
import { getGpuTierUltraAddon } from "@/lib/gpuTierPricing";
import type { GpuTier } from "@/lib/gpuTier";
import { startActiveJob, endActiveJob } from "@/lib/activeGenerationJobs";
import { autoExtendGpuWarmOnSuccess } from "@/lib/gpuWarmAutoExtend";
import { getAdminEmails } from "@/lib/adminAuth";

// Cold-started GPU inference on Modal (container spin-up + model load +
// sampling) runs ~2-3 minutes end to end — see modalWanAnimate.ts.
export const maxDuration = 300;

function extensionFromMime(mime: string): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  return ".png";
}

async function fileToBase64(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer());
  return buf.toString("base64");
}

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
  // Admin-triggered generations are also persisted into the Modal Volume
  // (outputs/admin/) so staff can review/download them later from the
  // Storage tab — see requirement in the "管理者生成動画のVolume保存" task.
  const isAdmin = getAdminEmails().includes((user.email ?? "").toLowerCase());

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const characterImage = formData.get("characterImage");
  const motionMode = formData.get("motionMode");
  const presetId = formData.get("presetId");
  const customMotionVideo = formData.get("customMotionVideo");
  const prompt = formData.get("prompt");
  const gpuTierRaw = formData.get("gpuTier");
  const gpuTier: GpuTier = gpuTierRaw === "ultra" ? "ultra" : "standard";

  if (!(characterImage instanceof File) || characterImage.size === 0) {
    return NextResponse.json({ error: "キャラクター画像をアップロードしてください。" }, { status: 400 });
  }

  if (motionMode !== "preset" && motionMode !== "custom") {
    return NextResponse.json({ error: "動作の指定方法が不正です。" }, { status: 400 });
  }

  let preset: { id: string; video_url: string; category: string } | null = null;
  if (motionMode === "preset") {
    if (typeof presetId !== "string" || !presetId) {
      return NextResponse.json({ error: "プリセットを選択してください。" }, { status: 400 });
    }
    const { data: presetRow, error: presetError } = await supabaseAdmin
      .from("studio_presets")
      .select("id, video_url, category")
      .eq("id", presetId)
      .eq("is_active", true)
      .maybeSingle();
    if (presetError) {
      console.error("[wan-animate/generate] failed to load preset:", presetError.message);
      return NextResponse.json({ error: "プリセットの取得に失敗しました。" }, { status: 500 });
    }
    if (!presetRow) {
      return NextResponse.json({ error: "プリセットを選択してください。" }, { status: 400 });
    }
    preset = presetRow;
  }
  if (motionMode === "custom" && !(customMotionVideo instanceof File)) {
    return NextResponse.json({ error: "カスタム動画をアップロードしてください。" }, { status: 400 });
  }

  const [baseGenerationCost, gpuTierAddon] = await Promise.all([
    getWanAnimateGenerationCost(motionMode),
    gpuTier === "ultra" ? getGpuTierUltraAddon() : Promise.resolve(0),
  ]);
  const generationCost = baseGenerationCost + gpuTierAddon;

  const { data: profile, error: profileError } = await getOrCreateProfile(
    user.id,
    "credits, credits_expire_at",
  );

  if (profileError) {
    console.error("[wan-animate/generate] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }

  const creditsExpireAt = profile?.credits_expire_at as string | null | undefined;
  const rawCredits = profile?.credits as number | null | undefined;
  const isExpired = creditsExpireAt ? new Date(creditsExpireAt).getTime() < Date.now() : false;
  const currentCredits = isExpired ? 0 : (rawCredits ?? 0);

  if (isExpired && (rawCredits ?? 0) > 0) {
    const { error: expireError } = await supabaseAdmin
      .from("profiles")
      .update({ credits: 0 })
      .eq("id", user.id);
    if (expireError) {
      console.error("[wan-animate/generate] failed to apply credit expiry reset:", expireError.message);
    }
  }

  if (currentCredits < generationCost) {
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

  // Deducted up front (refunded below on failure) so two concurrent
  // requests can't both pass the balance check and overdraw the account.
  const debitedCredits = currentCredits - generationCost;
  const { error: debitError } = await supabaseAdmin
    .from("profiles")
    .update({ credits: debitedCredits })
    .eq("id", user.id);

  if (debitError) {
    console.error("[wan-animate/generate] failed to debit credits:", debitError.message);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  const startedAt = Date.now();
  const promptText = typeof prompt === "string" ? prompt : "";
  const activeJobId = await startActiveJob(user.id, "wan-animate-2", gpuTier);

  try {
    const referenceImageName = `character${extensionFromMime(characterImage.type)}`;
    const referenceImageB64 = await fileToBase64(characterImage);

    let poseVideoName: string;
    let poseVideoB64: string;
    if (motionMode === "preset" && preset) {
      poseVideoName = path.basename(preset.video_url);
      const posePath = path.join(process.cwd(), "public", preset.video_url);
      const poseBuf = await readFile(posePath);
      poseVideoB64 = poseBuf.toString("base64");
    } else {
      const video = customMotionVideo as File;
      poseVideoName = video.name?.trim() || "pose.mp4";
      poseVideoB64 = await fileToBase64(video);
    }

    const workflow = buildWanAnimateWorkflow({
      prompt: promptText,
      motionCategory: motionMode === "preset" ? (preset?.category ?? null) : null,
      referenceImageName,
      poseVideoName,
    });

    const result = await generateWithModal({
      workflow,
      referenceImageB64,
      referenceImageName,
      poseVideoB64,
      poseVideoName,
      gpuTier,
      saveToVolume: isAdmin,
    });

    const executionTimeMs = Date.now() - startedAt;

    await logGenerationActivity({
      userId: user.id,
      jobType: "wan-animate-2",
      promptInput: promptText || null,
      promptOptimized: null,
      executionTimeMs,
      creditsConsumed: generationCost,
      status: "success",
      gpuTier,
      outputFileName: result.output_path,
    });

    // Free side-effect of a successful generation — keeps the shared
    // "🔥 火入れ" status hot for whoever generates next (see
    // gpuWarmAutoExtend.ts). Never blocks/fails the response.
    await autoExtendGpuWarmOnSuccess(user.id);

    return NextResponse.json({
      success: true,
      videoBase64: result.video_base64,
      remainingCredits: debitedCredits,
    });
  } catch (err) {
    console.error("[wan-animate/generate] generation failed:", err);

    const { error: refundError } = await supabaseAdmin
      .from("profiles")
      .update({ credits: currentCredits })
      .eq("id", user.id);
    if (refundError) {
      console.error("[wan-animate/generate] failed to refund credits after error:", refundError.message);
    }

    await logGenerationActivity({
      userId: user.id,
      jobType: "wan-animate-2",
      promptInput: promptText || null,
      promptOptimized: null,
      executionTimeMs: Date.now() - startedAt,
      creditsConsumed: 0,
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      gpuTier,
    });

    return NextResponse.json(
      {
        error: "動画生成に失敗しました。しばらくしてから再度お試しください。",
        remainingCredits: currentCredits,
      },
      { status: 502 },
    );
  } finally {
    await endActiveJob(activeJobId);
  }
}
