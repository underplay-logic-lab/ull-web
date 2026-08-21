import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { generateWithModal } from "@/lib/modalWanAnimate";
import { buildWanAnimateWorkflow } from "@/lib/wanAnimateWorkflow";
import { logGenerationActivity } from "@/lib/generationLogger";
import { WAN_ANIMATE_GENERATION_COST, wanAnimateMotionPresets } from "@/lib/data";

// Cold-started GPU inference on Modal (container spin-up + model load +
// sampling) runs ~2-3 minutes end to end — see modalWanAnimate.ts.
export const maxDuration = 300;

const PRESET_BY_ID = new Map(wanAnimateMotionPresets.map((p) => [p.id, p]));

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

  if (!(characterImage instanceof File) || characterImage.size === 0) {
    return NextResponse.json({ error: "キャラクター画像をアップロードしてください。" }, { status: 400 });
  }

  if (motionMode !== "preset" && motionMode !== "custom") {
    return NextResponse.json({ error: "動作の指定方法が不正です。" }, { status: 400 });
  }

  const preset = typeof presetId === "string" ? PRESET_BY_ID.get(presetId) : undefined;
  if (motionMode === "preset" && !preset) {
    return NextResponse.json({ error: "プリセットを選択してください。" }, { status: 400 });
  }
  if (motionMode === "custom" && !(customMotionVideo instanceof File)) {
    return NextResponse.json({ error: "カスタム動画をアップロードしてください。" }, { status: 400 });
  }

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

  if (currentCredits < WAN_ANIMATE_GENERATION_COST) {
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
  const debitedCredits = currentCredits - WAN_ANIMATE_GENERATION_COST;
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

  try {
    const referenceImageName = `character${extensionFromMime(characterImage.type)}`;
    const referenceImageB64 = await fileToBase64(characterImage);

    let poseVideoName: string;
    let poseVideoB64: string;
    if (motionMode === "preset" && preset) {
      poseVideoName = path.basename(preset.videoUrl);
      const posePath = path.join(process.cwd(), "public", preset.videoUrl);
      const poseBuf = await readFile(posePath);
      poseVideoB64 = poseBuf.toString("base64");
    } else {
      const video = customMotionVideo as File;
      poseVideoName = video.name?.trim() || "pose.mp4";
      poseVideoB64 = await fileToBase64(video);
    }

    const workflow = buildWanAnimateWorkflow({
      prompt: promptText,
      presetId: motionMode === "preset" ? preset?.id : null,
      referenceImageName,
      poseVideoName,
    });

    const result = await generateWithModal({
      workflow,
      referenceImageB64,
      referenceImageName,
      poseVideoB64,
      poseVideoName,
    });

    const executionTimeMs = Date.now() - startedAt;

    await logGenerationActivity({
      userId: user.id,
      jobType: "wan-animate-2",
      promptInput: promptText || null,
      promptOptimized: null,
      executionTimeMs,
      creditsConsumed: WAN_ANIMATE_GENERATION_COST,
      status: "success",
    });

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
    });

    return NextResponse.json(
      {
        error: "動画生成に失敗しました。しばらくしてから再度お試しください。",
        remainingCredits: currentCredits,
      },
      { status: 502 },
    );
  }
}
