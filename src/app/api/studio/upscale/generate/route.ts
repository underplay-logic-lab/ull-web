import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { spawnUpscaleJob } from "@/lib/modalUpscale";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { upscaleMaxAllowedTime } from "@/lib/pricing/costGuard.server";
import { autoExtendGpuWarmOnSuccess } from "@/lib/gpuWarmAutoExtend";
import { readImageDimensions } from "@/lib/imageDimensions";
import {
  DEFAULT_RESOLUTION_PRESET,
  DEFAULT_UPSCALE_MODEL,
  MAX_INPUT_BYTES_API,
  RESOLUTION_PRESETS,
  UPSCALE_MODELS,
  getResolutionPreset,
  getUpscaleModel,
  upscaleCostBreakdown,
  upscaleCreditsWorstCase,
} from "@/lib/upscaleStudio";

// 非同期: この route は寸法から課金額を出し、クレジットを引き落とし、
// upscale_jobs 行を insert して Modal dispatch（.spawn() して即 ACK）を叩くだけ。
// 生成そのものは待たない。
export const maxDuration = 30;

const VALID_PRESET_IDS: Set<string> = new Set(RESOLUTION_PRESETS.map((p) => p.id));
const VALID_MODEL_KEYS: Set<string> = new Set(UPSCALE_MODELS.map((m) => m.key));

function decodeBase64Image(raw: unknown): Buffer {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return Buffer.alloc(0);
  const b64 = s.startsWith("data:") ? s.slice(s.indexOf(",") + 1) : s;
  try {
    return Buffer.from(b64, "base64");
  } catch {
    return Buffer.alloc(0);
  }
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

  // ── リクエストボディ（multipart / JSON+base64 の両方受ける）─────────
  const contentType = request.headers.get("content-type") ?? "";
  let imageBuffer: Buffer = Buffer.alloc(0);
  let modelKeyRaw: unknown = DEFAULT_UPSCALE_MODEL;
  let presetRaw: unknown = DEFAULT_RESOLUTION_PRESET;

  if (contentType.includes("application/json")) {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
    }
    imageBuffer = decodeBase64Image(body.image ?? body.image_b64);
    modelKeyRaw = body.modelKey ?? body.model_key ?? DEFAULT_UPSCALE_MODEL;
    presetRaw = body.preset ?? DEFAULT_RESOLUTION_PRESET;
  } else {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        {
          error:
            "画像の受信に失敗しました。ファイルサイズが大きすぎる可能性があります。別の画像でお試しください。",
        },
        { status: 400 },
      );
    }
    const imageFile = formData.get("image");
    if (!(imageFile instanceof File) || imageFile.size === 0) {
      return NextResponse.json({ error: "画像をアップロードしてください。" }, { status: 400 });
    }
    imageBuffer = Buffer.from(await imageFile.arrayBuffer());
    modelKeyRaw = formData.get("modelKey") ?? DEFAULT_UPSCALE_MODEL;
    presetRaw = formData.get("preset") ?? DEFAULT_RESOLUTION_PRESET;
  }

  if (imageBuffer.length === 0) {
    return NextResponse.json({ error: "画像をアップロードしてください。" }, { status: 400 });
  }
  if (imageBuffer.length > MAX_INPUT_BYTES_API) {
    return NextResponse.json(
      { error: "画像サイズが大きすぎます。20MB 以下にしてください。" },
      { status: 400 },
    );
  }

  const modelKey = typeof modelKeyRaw === "string" && VALID_MODEL_KEYS.has(modelKeyRaw)
    ? modelKeyRaw
    : DEFAULT_UPSCALE_MODEL;
  const presetId = typeof presetRaw === "string" && VALID_PRESET_IDS.has(presetRaw)
    ? presetRaw
    : DEFAULT_RESOLUTION_PRESET;

  const model = getUpscaleModel(modelKey);
  const preset = getResolutionPreset(presetId);

  // 入力寸法をサーバー側で読む（クライアント申告は信用しない）。
  const dims = readImageDimensions(imageBuffer);
  const knobs = await getPricingKnobs();

  let creditsCost: number;
  let outWidth = 0;
  let outHeight = 0;
  if (dims && dims.width > 0 && dims.height > 0) {
    const bd = upscaleCostBreakdown({
      inW: dims.width,
      inH: dims.height,
      presetId,
      modelKey,
      knobs,
    });
    creditsCost = bd.credits;
    outWidth = bd.outputWidth;
    outHeight = bd.outputHeight;
  } else {
    // 寸法が読めない形式（HEIC 等）。worst-case 課金で受け、worker が実寸法を
    // metadata に書く。
    creditsCost = upscaleCreditsWorstCase(knobs);
  }

  // --- credits ---------------------------------------------------------
  const { data: profile, error: profileError } = await getOrCreateProfile(
    user.id,
    "credits, credits_expire_at",
  );
  if (profileError) {
    console.error("[studio/upscale/generate] failed to load profile:", profileError.message);
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
    console.error("[studio/upscale/generate] failed to debit credits:", debitError.message);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  // --- job row --------------------------------------------------------
  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("upscale_jobs")
    .insert({
      user_id: user.id,
      status: "pending",
      model_key: modelKey,
      preset: presetId,
      credits_cost: creditsCost,
      metadata: {
        in_width: dims?.width ?? null,
        in_height: dims?.height ?? null,
        est_out_width: outWidth || null,
        est_out_height: outHeight || null,
        model_label: model.label,
      },
    })
    .select("id")
    .single();

  if (jobError || !jobRow) {
    console.error("[studio/upscale/generate] failed to create job row:", jobError?.message);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      { error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits },
      { status: 500 },
    );
  }
  const jobId = jobRow.id as string;

  // --- dispatch to Modal ---------------------------------------------
  try {
    await spawnUpscaleJob({
      jobId,
      userId: user.id,
      creditsCost,
      maxAllowedTime: upscaleMaxAllowedTime({ creditsCost, knobs }),
      imageBase64: imageBuffer.toString("base64"),
      modelKey,
      presetId,
      params: {
        target_short: preset.targetShort,
        max_resolution: preset.maxEdge,
        batch_size: 1,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[studio/upscale/generate] dispatch failed:", message);
    await supabaseAdmin
      .from("upscale_jobs")
      .update({ status: "failed", error_message: `ジョブの起動に失敗しました: ${message}`.slice(0, 500) })
      .eq("id", jobId);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      {
        error: "アップスケールジョブの起動に失敗しました。しばらくしてから再度お試しください。",
        remainingCredits: currentCredits,
      },
      { status: 502 },
    );
  }

  await autoExtendGpuWarmOnSuccess(user.id);

  return NextResponse.json({
    success: true,
    jobId,
    creditsCost,
    remainingCredits: debitedCredits,
  });
}
