import { NextResponse } from "next/server";
import { debitCredits, refundCredits } from "@/lib/credits.server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { dispatchUpscaleVideo, type UpscaleVideoSpec } from "@/lib/upscaleDispatch.server";
import { advanceQueue, saveDispatchSpec } from "@/lib/studioQueue.server";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { upscaleVideoWarmSettle, type WarmSettle } from "@/lib/pricing/warmRefund";
import { probeUpscaleVideo } from "@/lib/modalUpscale";
import { upscaleVideoMaxAllowedTime } from "@/lib/pricing/costGuard.server";
import { createStudioUploadSignedUrl } from "@/lib/studioUploads.server";
import {
  DEFAULT_UPSCALE_MODEL,
  DEFAULT_UPSCALE_VIDEO_PRESET,
  UPSCALE_VIDEO_MODELS,
  UPSCALE_VIDEO_MAX_SECONDS,
  UPSCALE_VIDEO_MAX_FRAMES,
  UPSCALE_VIDEO_PRESETS,
  getUpscaleModel,
  getUpscaleVideoPreset,
  resolveVideoTargetShort,
  upscaleVideoCostBreakdown,
  upscaleVideoCreditsWorstCase,
  validateVideoInputResolution,
  upscalePriorityParallelSurcharge,
} from "@/lib/upscaleStudio";

// 署名付き URL の有効期限。動画は画像よりジョブが長く、GPU がコールド/
// 混雑中だと worker が実際に fetch するまで時間が空きうるため、動画専用
// ハードキャップ（modal_seedvr2_worker.py の UPSCALE_VIDEO_TIMEOUT_HARD_CAP_S・
// 既定90分）より長めに取る。
const SIGNED_URL_EXPIRES_S = 2 * 60 * 60;

// 非同期: この route は申告された尺・fps から課金額を出し、クレジットを
// 引き落とし、upscale_jobs 行（media_type='video'）を insert して Modal
// dispatch（.spawn() して即 ACK）を叩くだけ。生成そのものは待たない。
//
// ⚠️ 画像と違い、動画はサーバー側で正確な尺・fps を軽量に読む標準手段が無い
// ため、クライアント申告（<video> 要素の loadedmetadata）をそのまま信用する。
// Worker（modal_seedvr2_worker.py）が ffprobe で実測し、上限超過や申告との
// 大きな乖離を検知したら failed + 返金する。
export const maxDuration = 30;

const VALID_MODEL_KEYS: Set<string> = new Set(UPSCALE_VIDEO_MODELS.map((m) => m.key));
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const storagePath = typeof body.storagePath === "string" ? body.storagePath : "";
  if (!storagePath) {
    return NextResponse.json({ error: "動画をアップロードしてください。" }, { status: 400 });
  }

  const modelKeyRaw = body.modelKey;
  const modelKey = typeof modelKeyRaw === "string" && VALID_MODEL_KEYS.has(modelKeyRaw)
    ? modelKeyRaw
    : DEFAULT_UPSCALE_MODEL;
  const model = getUpscaleModel(modelKey);

  const presetRaw = body.preset;
  const presetId = typeof presetRaw === "string" && VALID_PRESET_IDS.has(presetRaw)
    ? presetRaw
    : DEFAULT_UPSCALE_VIDEO_PRESET;
  const preset = getUpscaleVideoPreset(presetId);

  let durationSec = Number(body.durationSec);
  let fps = Number(body.fps);
  let width = Number(body.width);
  let height = Number(body.height);

  let hasValidMeta =
    Number.isFinite(durationSec) && durationSec > 0 &&
    Number.isFinite(fps) && fps > 0 &&
    Number.isFinite(width) && width > 0 &&
    Number.isFinite(height) && height > 0;

  // 課金前に ffprobe で実測する（2026-09-23）。ブラウザは fps を取れず 30 を仮定する
  // ことがあり、申告フレーム数で確定課金すると取り過ぎ／取り漏れが出る（実ジョブで
  // 151→121 フレーム、62C の取り過ぎ）。署名 URL を先に発行し、Modal の CPU 関数で
  // 実測した値で値付けする。失敗時は従来どおり申告値（無ければ worst-case）。
  // 動画本体は Vercel 関数を経由させない — worker / probe に直接 fetch させる。
  let videoUrl: string;
  try {
    videoUrl = await createStudioUploadSignedUrl(user.id, storagePath, SIGNED_URL_EXPIRES_S);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  const claimed = { durationSec, fps, width, height, valid: hasValidMeta };
  const probed = await probeUpscaleVideo(videoUrl);
  if (probed) {
    durationSec = probed.duration;
    fps = probed.fps;
    width = probed.width;
    height = probed.height;
    hasValidMeta = true;
  }
  if (hasValidMeta && durationSec > UPSCALE_VIDEO_MAX_SECONDS + 0.5) {
    return NextResponse.json(
      { error: `動画は${UPSCALE_VIDEO_MAX_SECONDS}秒以内にしてください（${durationSec.toFixed(1)}秒でした）。` },
      { status: 400 },
    );
  }
  // コマ数が主の上限（2026-10-08）。ワーカーでも同じ判定をするが、GPU を起動する前にここで止める。
  if (hasValidMeta && fps > 0 && Math.round(durationSec * fps) > UPSCALE_VIDEO_MAX_FRAMES) {
    const maxS = Math.floor(UPSCALE_VIDEO_MAX_FRAMES / fps);
    return NextResponse.json(
      { error: `この動画（${Math.round(fps)}fps）は${maxS}秒までです（${durationSec.toFixed(1)}秒でした）。上限は ${UPSCALE_VIDEO_MAX_FRAMES} コマです。` },
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
  // 温まり返金（2026-10-10）: 寸法が読めたときだけ（worst-case 課金は精算しない）。比べる額は並列の追加料金を除いた通常料金。
  let warmSettle: WarmSettle | undefined;
  if (hasValidMeta) {
    const bd = upscaleVideoCostBreakdown({ durationSec, fps, inW: width, inH: height, presetId, modelKey, knobs });
    creditsCost = bd.credits;
    frameCount = bd.frameCount;
    warmSettle = upscaleVideoWarmSettle(
      { compareCredits: bd.credits, presetId, fixedScale: Boolean(model.fixedScale), modelMult: bd.modelMult, resMult: bd.resMult },
      knobs,
    );
  } else {
    // 申告値が読めなかった（クライアントの metadata 取得失敗等）。
    // worst-case 課金で受け、worker の ffprobe 実測に委ねる。
    creditsCost = upscaleVideoCreditsWorstCase(knobs);
  }

  // 「実行中でも並列で今すぐ実行」を選んだ場合の追加コールドスタート分
  // （順番待ち=無料の既定に対するオプトインの上乗せ。CLAUDE.md §6参照）。
  // 予約（2026-10-03、lib/studioQueue.server.ts）: 課金して行を reserved で作り、順番が来たらサーバーが起動する。
  // 予約は並列の追加料金を取らない（順番待ち）。
  const queue = body.queue === true;
  const priority = !queue && (body.priority === true || body.priority === "true");
  if (priority) {
    creditsCost += upscalePriorityParallelSurcharge(knobs, creditsCost);
  }

  // 固定倍率モデル（ESRGAN/SwinIR）は HD/2K/4K プリセットを見ず「入力短辺×
  // fixedScale」が実際の出力になる。worker 側の出力MP安全上限チェック
  // （_do_upscale_video）もこの値を見るため、preset.targetShort をそのまま
  // 渡すと（固定倍率モデルなのに）チェックがズレて安全側に働かない。
  const targetShort = hasValidMeta
    ? resolveVideoTargetShort(width, height, presetId, model)
    : preset.targetShort;

  // 動画本体は Vercel 関数を経由させない — 署名付き URL を発行し、Modal
  // worker に直接 fetch させる（_load_input_bytes が URL をサポート済み・
  // supabase.co は _ALLOWED_IMAGE_HOSTS 許可済み）。
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
    console.error("[studio/upscale/video/generate] failed to debit credits:", err);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  // --- job row --------------------------------------------------------
  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("upscale_jobs")
    .insert({
      user_id: user.id,
      status: queue ? "reserved" : "pending",
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
        meta_source: probed ? "ffprobe" : claimed.valid ? "client" : "worst_case",
        client_claimed: claimed.valid
          ? { duration: claimed.durationSec, fps: claimed.fps, width: claimed.width, height: claimed.height }
          : null,
        preset: presetId,
        target_short: targetShort,
        model_label: model.label,
        media_type: "video",
        priority,
        // 比較スライダーの元動画（2026-10-05）。リロード後も result API の which=input で取り直せるように残す。
        input_storage_path: storagePath,
      },
    })
    .select("id")
    .single();

  if (jobError || !jobRow) {
    console.error("[studio/upscale/video/generate] failed to create job row:", jobError?.message);
    await refundCredits(user.id, creditsCost);
    return NextResponse.json(
      { error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits },
      { status: 500 },
    );
  }
  const jobId = jobRow.id as string;

  const spec: UpscaleVideoSpec = {
    storagePath,
    urlTtl: SIGNED_URL_EXPIRES_S,
    creditsCost,
    maxAllowedTime: upscaleVideoMaxAllowedTime({ creditsCost, knobs }),
    modelKey,
    presetId,
    params: {
      target_short: targetShort,
      max_resolution: 8192,
      batch_size: 5,
    },
    warmSettle,
  };

  // --- 予約: 起動の引数を残して、順番が来ていればその場で起動（署名 URL は起動時に作り直す）----
  if (queue) {
    try {
      await saveDispatchSpec("upscale_video", jobId, user.id, spec);
    } catch (err) {
      console.error("[studio/upscale/video/generate] save spec failed:", (err as Error).message);
      await supabaseAdmin.from("upscale_jobs").delete().eq("id", jobId);
      await refundCredits(user.id, creditsCost);
      return NextResponse.json(
        { error: "予約に失敗しました。しばらくしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 500 },
      );
    }
    const started = await advanceQueue("upscale_video", user.id);
    return NextResponse.json({
      success: true,
      jobId,
      reserved: started !== jobId,
      creditsCost,
      remainingCredits: debitedCredits,
    });
  }

  // --- dispatch to Modal ---------------------------------------------
  try {
    await dispatchUpscaleVideo(jobId, user.id, spec, videoUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[studio/upscale/video/generate] dispatch failed:", message);
    await supabaseAdmin
      .from("upscale_jobs")
      .update({ status: "failed", error_message: `ジョブの起動に失敗しました: ${message}`.slice(0, 500) })
      .eq("id", jobId);
    await refundCredits(user.id, creditsCost);
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
    reserved: false,
    creditsCost,
    remainingCredits: debitedCredits,
  });
}
