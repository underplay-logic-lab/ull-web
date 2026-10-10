import { NextResponse } from "next/server";
import { debitCredits, refundCredits } from "@/lib/credits.server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { dispatchUpscaleImage, type UpscaleImageSpec } from "@/lib/upscaleDispatch.server";
import { advanceQueue, saveDispatchSpec } from "@/lib/studioQueue.server";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { upscaleImageWarmSettle, type WarmSettle } from "@/lib/pricing/warmRefund";
import { upscaleMaxAllowedTime } from "@/lib/pricing/costGuard.server";
import { readImageDimensions } from "@/lib/imageDimensions";
import { downloadStudioUpload, createStudioUploadSignedUrl } from "@/lib/studioUploads.server";
import {
  DEFAULT_UPSCALE_MODE,
  DEFAULT_UPSCALE_MODEL,
  MAX_INPUT_BYTES_API,
  UPSCALE_MODELS,
  UPSCALE_MODES,
  getUpscaleMode,
  getUpscaleModel,
  resolveTargetShort,
  upscaleCostBreakdown,
  upscaleImageRates,
  upscaleCreditsWorstCase,
  upscalePriorityParallelSurcharge,
} from "@/lib/upscaleStudio";

// 非同期: この route は寸法から課金額を出し、クレジットを引き落とし、
// upscale_jobs 行を insert して Modal dispatch（.spawn() して即 ACK）を叩くだけ。
// 生成そのものは待たない。
export const maxDuration = 30;

const VALID_MODE_IDS: Set<string> = new Set(UPSCALE_MODES.map((m) => m.id));
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

  // ── リクエストボディ（JSON+storagePath / JSON+base64 / multipart の
  // いずれか）── storagePath は Vercel の約4.5MBリクエストボディ上限を回避
  // する本線経路（CLAUDE.md §6）。base64/multipart は互換のため残す。
  const contentType = request.headers.get("content-type") ?? "";
  let imageBuffer: Buffer = Buffer.alloc(0);
  let modelKeyRaw: unknown = DEFAULT_UPSCALE_MODEL;
  let modeRaw: unknown = DEFAULT_UPSCALE_MODE;
  let storagePath: string | null = null;
  let priorityRaw: unknown = false;
  // 予約（2026-10-03、lib/studioQueue.server.ts）: 課金して行を reserved で作り、順番が来たらサーバーが起動する。
  let queue = false;

  if (contentType.includes("application/json")) {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
    }
    if (typeof body.storagePath === "string" && body.storagePath) {
      storagePath = body.storagePath;
    } else {
      imageBuffer = decodeBase64Image(body.image ?? body.image_b64);
    }
    queue = body.queue === true;
    if (queue && !storagePath) {
      return NextResponse.json({ error: "予約には画像のアップロードが必要です。" }, { status: 400 });
    }
    modelKeyRaw = body.modelKey ?? body.model_key ?? DEFAULT_UPSCALE_MODEL;
    modeRaw = body.mode ?? body.preset ?? DEFAULT_UPSCALE_MODE;
    priorityRaw = body.priority;
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
    modeRaw = formData.get("mode") ?? formData.get("preset") ?? DEFAULT_UPSCALE_MODE;
    priorityRaw = formData.get("priority");
  }
  // 予約は並列の追加料金を取らない（順番待ち）。
  const priority = !queue && (priorityRaw === true || priorityRaw === "true");

  if (storagePath) {
    // 実寸法をサーバー側で読む（正確な課金のため）。Modal へは base64
    // 再送せず、下で発行する署名付き URL を渡す（Vercel 関数を経由させない）。
    try {
      imageBuffer = await downloadStudioUpload(user.id, storagePath);
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
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
  const modeId = typeof modeRaw === "string" && VALID_MODE_IDS.has(modeRaw)
    ? modeRaw
    : DEFAULT_UPSCALE_MODE;

  const model = getUpscaleModel(modelKey);
  const mode = getUpscaleMode(modeId);

  // 入力寸法をサーバー側で読む（クライアント申告は信用しない）。
  const dims = readImageDimensions(imageBuffer);
  const knobs = await getPricingKnobs();

  let creditsCost: number;
  let outWidth = 0;
  let outHeight = 0;
  let targetShort = 1920;
  // 温まり返金（2026-10-10）: 寸法が読めたときだけ。比べる額は並列の追加料金を除いた通常料金（基本料＋この 1 枚）。
  let warmSettle: WarmSettle | undefined;
  if (dims && dims.width > 0 && dims.height > 0) {
    const bd = upscaleCostBreakdown({
      inW: dims.width,
      inH: dims.height,
      modeId,
      modelKey,
      knobs,
    });
    creditsCost = bd.credits;
    outWidth = bd.outputWidth;
    outHeight = bd.outputHeight;
    targetShort = resolveTargetShort(dims.width, dims.height, mode, model);
    warmSettle = upscaleImageWarmSettle(bd.credits, bd.gpu, upscaleImageRates(model, bd.gpu, knobs).warmCap, knobs);
  } else {
    // 寸法が読めない形式（HEIC 等）。worst-case 課金で受け、worker が実寸法を
    // metadata に書く。
    creditsCost = upscaleCreditsWorstCase(knobs);
  }

  // 「実行中でも並列で今すぐ実行」を選んだ場合の追加コールドスタート分
  // （順番待ち=無料の既定に対するオプトインの上乗せ。CLAUDE.md §6参照）。
  if (priority) {
    creditsCost += upscalePriorityParallelSurcharge(knobs, creditsCost);
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

  // クレジットはその場で引く（確かめるのと引くのを 1 回の操作に。同時に送られても 1 本分の料金で何本も作れない・2026-10-09）。
  let debitedCredits: number;
  try {
    const after = await debitCredits(user.id, creditsCost);
    if (after === null) {
      return NextResponse.json(
        { error: "クレジットが不足しています。チャージしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 402 },
      );
    }
    debitedCredits = after;
  } catch (err) {
    console.error("[studio/upscale/generate] failed to debit credits:", err);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  // --- job row --------------------------------------------------------
  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("upscale_jobs")
    .insert({
      user_id: user.id,
      status: queue ? "reserved" : "pending",
      model_key: modelKey,
      preset: modeId,
      credits_cost: creditsCost,
      metadata: {
        in_width: dims?.width ?? null,
        in_height: dims?.height ?? null,
        est_out_width: outWidth || null,
        est_out_height: outHeight || null,
        target_short: targetShort,
        cascade_stages: mode.cascadeStages,
        model_label: model.label,
        priority,
      },
    })
    .select("id")
    .single();

  if (jobError || !jobRow) {
    console.error("[studio/upscale/generate] failed to create job row:", jobError?.message);
    await refundCredits(user.id, creditsCost);
    return NextResponse.json(
      { error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits },
      { status: 500 },
    );
  }
  const jobId = jobRow.id as string;

  const spec: UpscaleImageSpec = {
    type: "single",
    storagePath: storagePath ?? "",
    creditsCost,
    maxAllowedTime: upscaleMaxAllowedTime({ creditsCost, knobs }),
    modelKey,
    presetId: modeId,
    params: {
      target_short: targetShort,
      max_resolution: mode.maxEdge,
      batch_size: 1,
      // 動く GPU の判定（worker の _resolve_image_gpu_tier・料金の upscaleImageGpu と同じ規則）。寸法が読めないときは 0（短辺の規則）。
      out_mp: Math.round(((outWidth * outHeight) / 1_000_000) * 100) / 100,
    },
    warmSettle,
  };

  // --- 予約: 起動の引数を残して、順番が来ていればその場で起動 ----------------
  if (queue) {
    try {
      await saveDispatchSpec("upscale_image", jobId, user.id, spec);
    } catch (err) {
      console.error("[studio/upscale/generate] save spec failed:", (err as Error).message);
      await supabaseAdmin.from("upscale_jobs").delete().eq("id", jobId);
      await refundCredits(user.id, creditsCost);
      return NextResponse.json(
        { error: "予約に失敗しました。しばらくしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 500 },
      );
    }
    const started = await advanceQueue("upscale_image", user.id);
    return NextResponse.json({
      success: true,
      jobId,
      reserved: started !== jobId,
      creditsCost,
      remainingCredits: debitedCredits,
    });
  }

  // Modal へは storagePath 由来なら署名付き URL（Vercel 関数を経由させない）、
  // それ以外（旧 base64/multipart 経路）は互換のためそのまま base64 で渡す。
  let imageSpec = imageBuffer.toString("base64");
  if (storagePath) {
    try {
      imageSpec = await createStudioUploadSignedUrl(user.id, storagePath);
    } catch (err) {
      await refundCredits(user.id, creditsCost);
      return NextResponse.json(
        { error: (err as Error).message, remainingCredits: currentCredits },
        { status: 500 },
      );
    }
  }

  // --- dispatch to Modal ---------------------------------------------
  try {
    await dispatchUpscaleImage(jobId, user.id, spec, imageSpec);
    // 2026-09-13 実障害で判明: ここで即座に削除すると、Modal worker が
    // コールドスタート等でまだ署名付きURLを fetch していないタイミングで
    // オブジェクトが消え、「HTTPError: 400 Client Error」でジョブが失敗する
    // レース条件になる（.spawn() は非同期起動の ACK が返るだけで、worker が
    // 実際に画像を取得するのはそれよりずっと後）。削除は行わず、
    // studio_uploads/（Modal Volume）は modal_retention_purge.py の
    // 14日自動パージに委ねる（2026-09-19、Supabaseバケットから移行）。
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[studio/upscale/generate] dispatch failed:", message);
    await supabaseAdmin
      .from("upscale_jobs")
      .update({ status: "failed", error_message: `ジョブの起動に失敗しました: ${message}`.slice(0, 500) })
      .eq("id", jobId);
    await refundCredits(user.id, creditsCost);
    return NextResponse.json(
      {
        error: "アップスケールジョブの起動に失敗しました。しばらくしてから再度お試しください。",
        remainingCredits: currentCredits,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    jobId,
    reserved: false,
    creditsCost,
    remainingCredits: debitedCredits,
  });
}
