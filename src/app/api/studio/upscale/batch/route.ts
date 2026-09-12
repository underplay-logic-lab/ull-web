import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { spawnUpscaleBatchJob, type SpawnUpscaleBatchItem } from "@/lib/modalUpscale";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { readImageDimensions } from "@/lib/imageDimensions";
import { downloadStudioUpload, createStudioUploadSignedUrl, deleteStudioUploads } from "@/lib/studioUploads.server";
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

  // ── リクエストボディ（JSON。storagePaths は Vercel の約4.5MBリクエスト
  // ボディ上限を回避する本線経路 — CLAUDE.md §6）────────────────────────
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const storagePaths = Array.isArray(body.storagePaths)
    ? body.storagePaths.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  if (storagePaths.length === 0) {
    return NextResponse.json({ error: "画像をアップロードしてください。" }, { status: 400 });
  }
  if (storagePaths.length > UPSCALE_BATCH_MAX_ITEMS) {
    return NextResponse.json(
      { error: `一度に処理できるのは最大 ${UPSCALE_BATCH_MAX_ITEMS} 枚です。枚数を減らしてお試しください。` },
      { status: 400 },
    );
  }
  const modelKeyRaw = body.modelKey ?? DEFAULT_UPSCALE_MODEL;
  const modeRaw = body.mode ?? body.preset ?? DEFAULT_UPSCALE_MODE;
  const modelKey = typeof modelKeyRaw === "string" && VALID_MODEL_KEYS.has(modelKeyRaw)
    ? modelKeyRaw
    : DEFAULT_UPSCALE_MODEL;
  const modeId = typeof modeRaw === "string" && VALID_MODE_IDS.has(modeRaw)
    ? modeRaw
    : DEFAULT_UPSCALE_MODE;

  const model = getUpscaleModel(modelKey);
  const mode = getUpscaleMode(modeId);
  const knobs = await getPricingKnobs();

  // ── 画像ごとにストレージから取得し、寸法・課金・target_short を計算 ───
  type PreparedItem = {
    storagePath: string;
    filename: string;
    creditsCost: number;
    inWidth: number | null;
    inHeight: number | null;
    outWidth: number;
    outHeight: number;
    targetShort: number;
  };
  const prepared: PreparedItem[] = [];
  let totalBytes = 0;
  for (const storagePath of storagePaths) {
    let buffer: Buffer;
    try {
      buffer = await downloadStudioUpload(user.id, storagePath);
    } catch (err) {
      return NextResponse.json(
        { error: `「${storagePath.split("/").pop()}」: ${(err as Error).message}` },
        { status: 400 },
      );
    }
    totalBytes += buffer.length;
    if (buffer.length > MAX_INPUT_BYTES_API) {
      return NextResponse.json(
        { error: `「${storagePath.split("/").pop()}」が大きすぎます。` },
        { status: 400 },
      );
    }
    if (totalBytes > UPSCALE_BATCH_MAX_TOTAL_BYTES) {
      return NextResponse.json(
        {
          error: `合計サイズが大きすぎます（上限 ${Math.floor(
            UPSCALE_BATCH_MAX_TOTAL_BYTES / (1024 * 1024),
          )}MB）。枚数を減らすか、画像を圧縮してお試しください。`,
        },
        { status: 400 },
      );
    }
    const filename = storagePath.split("/").pop() || storagePath;
    const dims = readImageDimensions(buffer);
    if (dims && dims.width > 0 && dims.height > 0) {
      const bd = upscaleCostBreakdown({ inW: dims.width, inH: dims.height, modeId, modelKey, knobs });
      prepared.push({
        storagePath,
        filename,
        creditsCost: bd.credits,
        inWidth: dims.width,
        inHeight: dims.height,
        outWidth: bd.outputWidth,
        outHeight: bd.outputHeight,
        targetShort: resolveTargetShort(dims.width, dims.height, mode, model),
      });
    } else {
      // 寸法が読めない形式（HEIC 等）。worst-case 課金で受け、worker が実寸法を
      // metadata に書く。
      prepared.push({
        storagePath,
        filename,
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
  // 各アイテムは Vercel 関数を経由させず、署名付き URL を worker に直接
  // fetch させる（CLAUDE.md §6）。
  const items: SpawnUpscaleBatchItem[] = [];
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    let signedUrl: string;
    try {
      signedUrl = await createStudioUploadSignedUrl(user.id, p.storagePath);
    } catch (err) {
      await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
      return NextResponse.json(
        { error: (err as Error).message, remainingCredits: currentCredits },
        { status: 500 },
      );
    }
    items.push({
      jobId: jobIds[i],
      creditsCost: p.creditsCost,
      image: signedUrl,
      modelKey,
      presetId: modeId,
      params: {
        target_short: p.targetShort,
        max_resolution: mode.maxEdge,
        batch_size: 1,
      },
    });
  }

  try {
    await spawnUpscaleBatchJob({
      batchId,
      userId: user.id,
      maxAllowedTime: estimatedSeconds,
      items,
    });
    // dispatch 成功後は一時アップロードは不要（ベストエフォート削除）。
    deleteStudioUploads(storagePaths);
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
