import { randomUUID } from "crypto";
import { debitCredits, refundCredits } from "@/lib/credits.server";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { dispatchUpscaleBatch, type UpscaleBatchSpec } from "@/lib/upscaleDispatch.server";
import { advanceQueue, saveDispatchSpec } from "@/lib/studioQueue.server";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { upscaleImageWarmSettle } from "@/lib/pricing/warmRefund";
import { readImageDimensions } from "@/lib/imageDimensions";
import { downloadStudioUpload, readStudioUploadHead } from "@/lib/studioUploads.server";
import {
  DEFAULT_UPSCALE_MODE,
  DEFAULT_UPSCALE_MODEL,
  MAX_INPUT_BYTES_API,
  UPSCALE_BATCH_MAX_ITEMS,
  UPSCALE_MODELS,
  UPSCALE_MODES,
  getUpscaleMode,
  getUpscaleModel,
  resolveTargetShort,
  upscaleBatchEstimatedSeconds,
  upscaleBatchCredits,
  upscaleCostBreakdown,
  upscaleImageRates,
  upscaleCreditsWorstCase,
  type UpscaleCostBreakdown,
} from "@/lib/upscaleStudio";

// 非同期バッチ: N枚まとめて寸法から課金額を出し、合計クレジットを一括で
// 引き落とし、upscale_jobs をN行 insert して Modal へ1回だけ dispatch（実処理
// は同じ温まったコンテナ内でN回ループ）。generate/route.ts の複数枚版。
// 2026-09-24: 30 → 60。枚数上限を 300 に上げたため（寸法は並列・先頭だけ読むので通常は数秒）。
export const maxDuration = 60;

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
  // 予約（2026-10-03、lib/studioQueue.server.ts）: 課金して行を reserved で作り、順番が来たらサーバーが起動する。
  const queue = body.queue === true;
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
  // 2026-09-24: 画像を丸ごと 1 枚ずつ順に落とすのをやめ、先頭だけを並列に読む。
  // 寸法（PNG IHDR / JPEG SOF / WebP VP8*）はほぼ先頭数 KB にある。EXIF の埋め込み
  // サムネイルで SOF が後ろへずれる JPEG もあるので 256KB 取り、それでも読めなければ
  // その 1 枚だけ全体を落とす。
  const HEAD_BYTES = 256 * 1024;
  const CONCURRENCY = 16;
  const heads: { dims: ReturnType<typeof readImageDimensions>; totalBytes: number | null }[] =
    new Array(storagePaths.length);
  let failure: string | null = null;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, storagePaths.length) }, async () => {
      while (failure === null && cursor < storagePaths.length) {
        const i = cursor++;
        const storagePath = storagePaths[i];
        try {
          const { head, totalBytes } = await readStudioUploadHead(user.id, storagePath, HEAD_BYTES);
          let dims = readImageDimensions(head);
          if (!dims && totalBytes !== null && totalBytes > head.length) {
            dims = readImageDimensions(await downloadStudioUpload(user.id, storagePath));
          }
          heads[i] = { dims, totalBytes };
        } catch (err) {
          failure = `「${storagePath.split("/").pop()}」: ${(err as Error).message}`;
        }
      }
    }),
  );
  if (failure !== null) {
    return NextResponse.json({ error: failure }, { status: 400 });
  }

  const prepared: PreparedItem[] = [];
  // 基本料はまとめた分全体で 1 回だけ（2026-10-10・upscaleBatchCredits が先頭の 1 枚に乗せる）。
  const breakdowns: (UpscaleCostBreakdown | null)[] = [];
  for (let i = 0; i < storagePaths.length; i++) {
    const storagePath = storagePaths[i];
    const { dims, totalBytes } = heads[i];
    if (totalBytes !== null && totalBytes > MAX_INPUT_BYTES_API) {
      return NextResponse.json(
        { error: `「${storagePath.split("/").pop()}」が大きすぎます。` },
        { status: 400 },
      );
    }
    const filename = storagePath.split("/").pop() || storagePath;
    if (dims && dims.width > 0 && dims.height > 0) {
      const bd = upscaleCostBreakdown({ inW: dims.width, inH: dims.height, modeId, modelKey, knobs });
      breakdowns.push(bd);
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
      breakdowns.push(null);
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

  const batchCredits = upscaleBatchCredits(breakdowns, knobs);
  prepared.forEach((p, i) => {
    p.creditsCost = batchCredits.perItem[i];
  });
  // 温まり返金（2026-10-10）: 基本料を乗せた先頭の 1 枚だけ精算する（2 枚目以降は基本料を取っていない）。
  const baseIdx = breakdowns.findIndex((b) => b && b.credits > 0);
  const baseBd = baseIdx >= 0 ? breakdowns[baseIdx] : null;
  const firstWarmSettle = baseBd
    ? upscaleImageWarmSettle(prepared[baseIdx].creditsCost, baseBd.gpu, upscaleImageRates(model, baseBd.gpu, knobs).warmCap, knobs)
    : undefined;
  const totalCredits = batchCredits.total;
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

  // クレジットはその場で引く（確かめるのと引くのを 1 回の操作に。同時に送られても 1 本分の料金で何本も作れない・2026-10-09）。
  let debitedCredits: number;
  try {
    const after = await debitCredits(user.id, totalCredits);
    if (after === null) {
      return NextResponse.json(
        { error: "クレジットが不足しています。チャージしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 402 },
      );
    }
    debitedCredits = after;
  } catch (err) {
    console.error("[studio/upscale/batch] failed to debit credits:", err);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  // --- job rows ---------------------------------------------------------
  const batchId = randomUUID();
  const rows = prepared.map((p, i) => ({
    user_id: user.id,
    status: queue ? "reserved" : "pending",
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
    await refundCredits(user.id, totalCredits);
    return NextResponse.json(
      { error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits },
      { status: 500 },
    );
  }
  const jobIds = jobRows.map((r) => r.id as string);

  // --- dispatch to Modal（1回でN枚まとめて）----------------------------
  // 各アイテムは Vercel 関数を経由させず、署名付き URL を worker に直接
  // fetch させる（CLAUDE.md §6）。
  // worker は items を先頭から 1 枚ずつ処理し、その都度この URL を fetch する。長い
  // バッチの後ろの画像が期限切れにならないよう、推定合計秒数 + 1h を有効期限にする
  // （2026-09-24。旧 1h 固定は 30 枚上限の頃なら足りていた）。署名は起動時に並列で作る。
  const urlTtl = Math.max(60 * 60, Math.ceil(estimatedSeconds) + 60 * 60);
  const spec: UpscaleBatchSpec = {
    type: "batch",
    batchId,
    maxAllowedTime: estimatedSeconds,
    urlTtl,
    items: prepared.map((p, i) => ({
      jobId: jobIds[i],
      storagePath: p.storagePath,
      creditsCost: p.creditsCost,
      modelKey,
      presetId: modeId,
      params: {
        target_short: p.targetShort,
        max_resolution: mode.maxEdge,
        batch_size: 1,
        // 動く GPU の判定（worker はまとめの中の最大で決める・料金の upscaleImageGpu と同じ規則）。
        out_mp: Math.round(((p.outWidth * p.outHeight) / 1_000_000) * 100) / 100,
      },
      ...(i === baseIdx && firstWarmSettle ? { warmSettle: firstWarmSettle } : {}),
    })),
  };

  // --- 予約: 起動の引数を先頭の行に残して、順番が来ていればその場で起動 ----------
  if (queue) {
    try {
      await saveDispatchSpec("upscale_image", jobIds[0], user.id, spec);
    } catch (err) {
      console.error("[studio/upscale/batch] save spec failed:", (err as Error).message);
      await supabaseAdmin.from("upscale_jobs").delete().in("id", jobIds);
      await refundCredits(user.id, totalCredits);
      return NextResponse.json(
        { error: "予約に失敗しました。しばらくしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 500 },
      );
    }
    const started = await advanceQueue("upscale_image", user.id);
    return NextResponse.json({
      success: true,
      batchId,
      jobIds,
      reserved: !started || !jobIds.includes(started),
      creditsCost: totalCredits,
      remainingCredits: debitedCredits,
    });
  }

  try {
    await dispatchUpscaleBatch(user.id, spec);
    // 2026-09-13 実障害で判明: 即座に削除すると Modal worker が署名付きURLを
    // fetch する前にオブジェクトが消えるレース条件になる（upscale/generate
    // route.ts の同種修正コメント参照）。削除はせず studio_uploads/（Modal
    // Volume）自体の14日自動パージ（modal_retention_purge.py）に委ねる。
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[studio/upscale/batch] dispatch failed:", message);
    await supabaseAdmin
      .from("upscale_jobs")
      .update({ status: "failed", error_message: `ジョブの起動に失敗しました: ${message}`.slice(0, 500) })
      .in("id", jobIds);
    await refundCredits(user.id, totalCredits);
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
    reserved: false,
    creditsCost: totalCredits,
    remainingCredits: debitedCredits,
  });
}
