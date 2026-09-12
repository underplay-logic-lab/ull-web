import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { spawnUpscaleVideoJob } from "@/lib/modalUpscale";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { upscaleVideoMaxAllowedTime } from "@/lib/pricing/costGuard.server";
import {
  DEFAULT_UPSCALE_MODEL,
  DEFAULT_UPSCALE_VIDEO_PRESET,
  UPSCALE_MODELS,
  UPSCALE_VIDEO_MAX_BYTES,
  UPSCALE_VIDEO_MAX_SECONDS,
  UPSCALE_VIDEO_PRESETS,
  getUpscaleModel,
  getUpscaleVideoPreset,
  upscaleVideoCostBreakdown,
  upscaleVideoCreditsWorstCase,
  validateVideoInputResolution,
} from "@/lib/upscaleStudio";

// 非同期: この route は申告された尺・fps から課金額を出し、クレジットを
// 引き落とし、upscale_jobs 行（media_type='video'）を insert して Modal
// dispatch（.spawn() して即 ACK）を叩くだけ。生成そのものは待たない。
//
// ⚠️ 画像と違い、動画はサーバー側で正確な尺・fps を軽量に読む標準手段が無い
// ため、クライアント申告（<video> 要素の loadedmetadata）をそのまま信用する。
// Worker（modal_seedvr2_worker.py）が ffprobe で実測し、上限超過や申告との
// 大きな乖離を検知したら failed + 返金する。
export const maxDuration = 30;

const VALID_MODEL_KEYS: Set<string> = new Set(UPSCALE_MODELS.map((m) => m.key));
const VALID_PRESET_IDS: Set<string> = new Set(UPSCALE_VIDEO_PRESETS.map((p) => p.id));

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
    return NextResponse.json(
      {
        error:
          "動画の受信に失敗しました。ファイルサイズが大きすぎる可能性があります。別の動画でお試しください。",
      },
      { status: 400 },
    );
  }

  const videoFile = formData.get("video");
  if (!(videoFile instanceof File) || videoFile.size === 0) {
    return NextResponse.json({ error: "動画をアップロードしてください。" }, { status: 400 });
  }
  if (videoFile.size > UPSCALE_VIDEO_MAX_BYTES) {
    return NextResponse.json(
      { error: `動画ファイルが大きすぎます。${Math.floor(UPSCALE_VIDEO_MAX_BYTES / 1024 / 1024)}MB 以下にしてください。` },
      { status: 400 },
    );
  }

  const modelKeyRaw = formData.get("modelKey");
  const modelKey = typeof modelKeyRaw === "string" && VALID_MODEL_KEYS.has(modelKeyRaw)
    ? modelKeyRaw
    : DEFAULT_UPSCALE_MODEL;
  const model = getUpscaleModel(modelKey);

  const presetRaw = formData.get("preset");
  const presetId = typeof presetRaw === "string" && VALID_PRESET_IDS.has(presetRaw)
    ? presetRaw
    : DEFAULT_UPSCALE_VIDEO_PRESET;
  const preset = getUpscaleVideoPreset(presetId);

  const durationSec = Number(formData.get("durationSec"));
  const fps = Number(formData.get("fps"));
  const width = Number(formData.get("width"));
  const height = Number(formData.get("height"));

  const hasValidMeta =
    Number.isFinite(durationSec) && durationSec > 0 &&
    Number.isFinite(fps) && fps > 0 &&
    Number.isFinite(width) && width > 0 &&
    Number.isFinite(height) && height > 0;

  if (hasValidMeta && durationSec > UPSCALE_VIDEO_MAX_SECONDS + 0.5) {
    return NextResponse.json(
      { error: `動画は${UPSCALE_VIDEO_MAX_SECONDS}秒以内にしてください（${durationSec.toFixed(1)}秒でした）。` },
      { status: 400 },
    );
  }

  if (hasValidMeta) {
    const resError = validateVideoInputResolution(width, height);
    if (resError) {
      return NextResponse.json({ error: resError }, { status: 400 });
    }
  }

  const knobs = await getPricingKnobs();

  let creditsCost: number;
  let frameCount = 0;
  if (hasValidMeta) {
    const bd = upscaleVideoCostBreakdown({ durationSec, fps, inW: width, inH: height, presetId, modelKey, knobs });
    creditsCost = bd.credits;
    frameCount = bd.frameCount;
  } else {
    // 申告値が読めなかった（クライアントの metadata 取得失敗等）。
    // worst-case 課金で受け、worker の ffprobe 実測に委ねる。
    creditsCost = upscaleVideoCreditsWorstCase(knobs);
  }

  const imageBuffer = Buffer.from(await videoFile.arrayBuffer());

  // --- credits ---------------------------------------------------------
  const { data: profile, error: profileError } = await getOrCreateProfile(
    user.id,
    "credits, credits_expire_at",
  );
  if (profileError) {
    console.error("[studio/upscale/video/generate] failed to load profile:", profileError.message);
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

  const debitedCredits = currentCredits - creditsCost;
  const { error: debitError } = await supabaseAdmin
    .from("profiles")
    .update({ credits: debitedCredits })
    .eq("id", user.id);
  if (debitError) {
    console.error("[studio/upscale/video/generate] failed to debit credits:", debitError.message);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  // --- job row --------------------------------------------------------
  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("upscale_jobs")
    .insert({
      user_id: user.id,
      status: "pending",
      media_type: "video",
      model_key: modelKey,
      preset: presetId,
      credits_cost: creditsCost,
      metadata: {
        in_width: hasValidMeta ? width : null,
        in_height: hasValidMeta ? height : null,
        in_duration_claimed: hasValidMeta ? durationSec : null,
        in_fps_claimed: hasValidMeta ? fps : null,
        frame_count_claimed: frameCount || null,
        preset: presetId,
        target_short: preset.targetShort,
        model_label: model.label,
        media_type: "video",
      },
    })
    .select("id")
    .single();

  if (jobError || !jobRow) {
    console.error("[studio/upscale/video/generate] failed to create job row:", jobError?.message);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      { error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits },
      { status: 500 },
    );
  }
  const jobId = jobRow.id as string;

  // --- dispatch to Modal ---------------------------------------------
  try {
    await spawnUpscaleVideoJob({
      jobId,
      userId: user.id,
      creditsCost,
      maxAllowedTime: upscaleVideoMaxAllowedTime({ creditsCost, knobs }),
      videoBase64: imageBuffer.toString("base64"),
      modelKey,
      presetId,
      params: {
        target_short: preset.targetShort,
        max_resolution: 8192,
        batch_size: 5,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[studio/upscale/video/generate] dispatch failed:", message);
    await supabaseAdmin
      .from("upscale_jobs")
      .update({ status: "failed", error_message: `ジョブの起動に失敗しました: ${message}`.slice(0, 500) })
      .eq("id", jobId);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      {
        error: "動画アップスケールジョブの起動に失敗しました。しばらくしてから再度お試しください。",
        remainingCredits: currentCredits,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    jobId,
    creditsCost,
    remainingCredits: debitedCredits,
  });
}
