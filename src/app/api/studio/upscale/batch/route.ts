import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { spawnUpscaleBatchJob, type SpawnUpscaleBatchItem } from "@/lib/modalUpscale";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { readImageDimensions } from "@/lib/imageDimensions";
import {
  DEFAULT_UPSCALE_MODE,
  DEFAULT_UPSCALE_MODEL,
  MAX_INPUT_BYTES_API,
  UPSCALE_BATCH_MAX_ITEMS,
  UPSCALE_BATCH_MAX_TOTAL_BYTES,
  UPSCALE_MODELS,
  UPSCALE_MODES,
  getUpscaleMode,
  getUpscaleModel,
  resolveTargetShort,
  upscaleBatchEstimatedSeconds,
  upscaleCostBreakdown,
  upscaleCreditsWorstCase,
} from "@/lib/upscaleStudio";

// 非同期バッチ: N枚まとめて寸法から課金額を出し、合計クレジットを一括で
// 引き落とし、upscale_jobs をN行 insert して Modal へ1回だけ dispatch（実処理
// は同じ温まったコンテナ内でN回ループ）。generate/route.ts の複数枚版。
export const maxDuration = 30;

const VALID_MODE_IDS: Set<string> = new Set(UPSCALE_MODES.map((m) => m.id));
const VALID_MODEL_KEYS: Set<string> = new Set(UPSCALE_MODELS.map((m) => m.key));

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

  // ── リクエストボディ（multipart のみ。複数 File を images で受ける）────
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      {
        error:
          "画像の受信に失敗しました。合計サイズが大きすぎる可能性があります。枚数を減らしてお試しください。",
      },
      { status: 400 },
    );
  }

  const files = formData
    .getAll("images")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return NextResponse.json({ error: "画像をアップロードしてください。" }, { status: 400 });
  }
  if (files.length > UPSCALE_BATCH_MAX_ITEMS) {
    return NextResponse.json(
      { error: `一度に処理できるのは最大 ${UPSCALE_BATCH_MAX_ITEMS} 枚です。枚数を減らしてお試しください。` },
      { status: 400 },
    );
  }

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > UPSCALE_BATCH_MAX_TOTAL_BYTES) {
    return NextResponse.json(
      {
        error: `合計アップロードサイズが大きすぎます（上限 ${Math.floor(
          UPSCALE_BATCH_MAX_TOTAL_BYTES / (1024 * 1024),
        )}MB）。枚数を減らすか、画像を圧縮してお試しください。`,
      },
      { status: 400 },
    );
  }
  for (const f of files) {
    if (f.size > MAX_INPUT_BYTES_API) {
      return NextResponse.json(
        { error: `「${f.name}」が大きすぎます。1枚 20MB 以下にしてください。` },
        { status: 400 },
      );
    }
  }

  const modelKeyRaw = formData.get("modelKey") ?? DEFAULT_UPSCALE_MODEL;
  const modeRaw = formData.get("mode") ?? formData.get("preset") ?? DEFAULT_UPSCALE_MODE;
  const modelKey = typeof modelKeyRaw === "string" && VALID_MODEL_KEYS.has(modelKeyRaw)
    ? modelKeyRaw
    : DEFAULT_UPSCALE_MODEL;
  const modeId = typeof modeRaw === "string" && VALID_MODE_IDS.has(modeRaw)
    ? modeRaw
    : DEFAULT_UPSCALE_MODE;

  const model = getUpscaleModel(modelKey);
  const mode = getUpscaleMode(modeId);
  const knobs = await getPricingKnobs();

  // ── 画像ごとの寸法・課金・target_short を先に全部計算 ───────────────
  type PreparedItem = {
    buffer: Buffer;
    filename: string;
    creditsCost: number;
    inWidth: number | null;
    inHeight: number | null;
    outWidth: number;
    outHeight: number;
    targetShort: number;
  };
  const prepared: PreparedItem[] = [];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const dims = readImageDimensions(buffer);
    if (dims && dims.width > 0 && dims.height > 0) {
      const bd = upscaleCostBreakdown({ inW: dims.width, inH: dims.height, modeId, modelKey, knobs });
      prepared.push({
        buffer,
        filename: file.name,
        creditsCost: bd.credits,
        inWidth: dims.width,
        inHeight: dims.height,
        outWidth: bd.outputWidth,
        outHeight: bd.outputHeight,
        targetShort: resolveTargetShort(dims.width, dims.height, mode),
      });
    } else {
      // 寸法が読めない形式（HEIC 等）。worst-case 課金で受け、worker が実寸法を
      // metadata に書く。
      prepared.push({
        buffer,
        filename: file.name,
        creditsCost: upscaleCreditsWorstCase(knobs),
        inWidth: null,
        inHeight: null,
        outWidth: 0,
        outHeight: 0,
        targetShort: 1920,
      });
    }
  }

  const totalCredits = prepared.reduce((sum, p) => sum + p.creditsCost, 0);
  const estimatedSeconds = upscaleBatchEstimatedSeconds(totalCredits, knobs);
  if (estimatedSeconds > knobs.upscale_batch_max_seconds) {
    return NextResponse.json(
      {
        error:
          "このバッチは推定処理時間が長すぎます。枚数を減らすか、倍率を下げてお試しください。",
      },
      { status: 400 },
    );
  }

  // --- credits ---------------------------------------------------------
  const { data: profile, error: profileError } = await getOrCreateProfile(
    user.id,
    "credits, credits_expire_at",
  );
  if (profileError) {
    console.error("[studio/upscale/batch] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }

  const creditsExpireAt = profile?.credits_expire_at as string | null | undefined;
  const rawCredits = profile?.credits as number | null | undefined;
  const isExpired = creditsExpireAt ? new Date(creditsExpireAt).getTime() < Date.now() : false;
  const currentCredits = isExpired ? 0 : rawCredits ?? 0;

  if (isExpired && (rawCredits ?? 0) > 0) {
    await supabaseAdmin.from("profiles").update({ credits: 0 }).eq("id", user.id);
  }

  if (currentCredits < totalCredits) {
    return NextResponse.json(
      {
        error: isExpired
          ? "クレジットの有効期限が切れています。チャージしてから再度お試しください。"
          : `クレジットが不足しています（必要: ${totalCredits}）。チャージしてから再度お試しください。`,
        remainingCredits: currentCredits,
      },
      { status: 402 },
    );
  }

  const debitedCredits = currentCredits - totalCredits;
  const { error: debitError } = await supabaseAdmin
    .from("profiles")
    .update({ credits: debitedCredits })
    .eq("id", user.id);
  if (debitError) {
    console.error("[studio/upscale/batch] failed to debit credits:", debitError.message);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  // --- job rows ---------------------------------------------------------
  const batchId = randomUUID();
  const rows = prepared.map((p, i) => ({
    user_id: user.id,
    status: "pending",
    model_key: modelKey,
    preset: modeId,
    credits_cost: p.creditsCost,
    batch_id: batchId,
    batch_index: i,
    batch_total: prepared.length,
    metadata: {
      in_width: p.inWidth,
      in_height: p.inHeight,
      est_out_width: p.outWidth || null,
      est_out_height: p.outHeight || null,
      target_short: p.targetShort,
      cascade_stages: mode.cascadeStages,
      model_label: model.label,
      filename: p.filename,
    },
  }));

  const { data: jobRows, error: jobError } = await supabaseAdmin
    .from("upscale_jobs")
    .insert(rows)
    .select("id");

  if (jobError || !jobRows || jobRows.length !== prepared.length) {
    console.error("[studio/upscale/batch] failed to create job rows:", jobError?.message);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      { error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits },
      { status: 500 },
    );
  }
  const jobIds = jobRows.map((r) => r.id as string);

  // --- dispatch to Modal（1回でN枚まとめて）----------------------------
  const items: SpawnUpscaleBatchItem[] = prepared.map((p, i) => ({
    jobId: jobIds[i],
    creditsCost: p.creditsCost,
    imageBase64: p.buffer.toString("base64"),
    modelKey,
    presetId: modeId,
    params: {
      target_short: p.targetShort,
      max_resolution: mode.maxEdge,
      batch_size: 1,
    },
  }));

  try {
    await spawnUpscaleBatchJob({
      batchId,
      userId: user.id,
      maxAllowedTime: estimatedSeconds,
      items,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[studio/upscale/batch] dispatch failed:", message);
    await supabaseAdmin
      .from("upscale_jobs")
      .update({ status: "failed", error_message: `ジョブの起動に失敗しました: ${message}`.slice(0, 500) })
      .in("id", jobIds);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      {
        error: "バッチジョブの起動に失敗しました。しばらくしてから再度お試しください。",
        remainingCredits: currentCredits,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    batchId,
    jobIds,
    creditsCost: totalCredits,
    remainingCredits: debitedCredits,
  });
}
