import { NextResponse } from "next/server";
import { debitCredits, refundCredits } from "@/lib/credits.server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { directorWarmSettle } from "@/lib/pricing/warmRefund";
import {
  directorPollDeadlineS,
  directorPriorityParallelSurcharge,
  isDirectorRefRole,
  type DirectorRefRole,
} from "@/lib/directorPricing";
import {
  DirectorPromptError,
  looksJapaneseOutsideDialogue,
  normalizeReferenceTags,
  translateDirectorPromptToJapanese,
  translateJapanesePromptToEnglish,
} from "@/lib/directorPrompt";
import { CINEMATIC_MODE_BY_ID } from "@/lib/cinematicPricing";
import { buildVideoFixWorkflow } from "@/lib/videoFixWorkflow";
import {
  isVideoFixSeam,
  VIDEO_FIX_MAX_PIXELS,
  VIDEO_FIX_MAX_SOURCE_S,
  VIDEO_FIX_MIN_REGEN_S,
  VIDEO_FIX_PROMPT_MAX_LENGTH,
  videoFixGpu,
  videoFixQuote,
  type VideoFixQuote,
} from "@/lib/videoFixPlan";
import { publishedR2Key } from "@/lib/r2.server";
import { locateStudioUpload } from "@/lib/studioUploads.server";
import { dispatchDirectorJob, type DirectorDispatchSpec } from "@/lib/directorDispatch.server";
import { advanceQueue, saveDispatchSpec } from "@/lib/studioQueue.server";
import { CONTENT_POLICY_BLOCK_MESSAGE, evaluateContentPolicyMany, logContentPolicyBlock } from "@/lib/contentPolicy";

// 動画の部分修正（2026-10-07〜）: 動画の一部の区間だけを作り直し、元の動画に貼り戻す。
// ジョブは Director と同じ workflow_type "director"（予約の順番・返金・ログ・結果の配信を共用）で inputs.output = "video_fix"。
// 元の動画は ①Director の結果（自分のジョブ）か ②持ち込み（studio_uploads・R2）。ワーカーが窓だけを切り出して処理する
// （modal_wan_animate_blackwell.py::_video_fix_prepare、窓の計算は src/lib/videoFixPlan.ts と ull_video_fix.py で同じ）。
export const maxDuration = 60;

type Source =
  | { kind: "director"; jobId: string; durationS: number; width: number; height: number; r2Key?: string; volumePath?: string }
  | { kind: "upload"; storagePath: string; durationS: number; width: number; height: number; r2Key: string };

export async function POST(request: Request) {
  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!accessToken) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
  const { data: userData, error: userError } = await createClient(supabaseUrl, anonKey).auth.getUser(accessToken);
  if (userError || !userData?.user) return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  const user = userData.user;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  // --- 元の動画 -----------------------------------------------------------
  let source: Source;
  if (typeof body.sourceJobId === "string" && body.sourceJobId) {
    const { data: srcJob } = await supabaseAdmin
      .from("generation_jobs")
      .select("id, status, inputs, metadata, video_url")
      .eq("id", body.sourceJobId)
      .eq("user_id", user.id)
      .eq("workflow_type", "director")
      .maybeSingle();
    const si = (srcJob?.inputs ?? {}) as Record<string, unknown>;
    const sm = (srcJob?.metadata ?? {}) as Record<string, unknown>;
    const durationS = num(si.total_duration_s) ?? num(sm.total_duration_s);
    const width = num(sm.out_width) ?? num(si.out_width);
    const height = num(sm.out_height) ?? num(si.out_height);
    const relPath = `director_results/${user.id}/${body.sourceJobId}.mp4`;
    if (!srcJob || srcJob.status !== "completed" || si.output === "photo" || !durationS || !width || !height) {
      return NextResponse.json({ error: "この動画は部分修正に使えません。動画を持ち込んでお試しください。" }, { status: 400 });
    }
    // R2 へ移っていればそこから、まだなら（完了直後）Volume から読む。
    const r2Key = publishedR2Key(sm, relPath);
    if (!r2Key && srcJob.video_url !== relPath) {
      return NextResponse.json({ error: "元の動画が見つかりませんでした。動画を持ち込んでお試しください。" }, { status: 400 });
    }
    source = {
      kind: "director",
      jobId: srcJob.id as string,
      durationS,
      width,
      height,
      ...(r2Key ? { r2Key } : { volumePath: relPath }),
    };
  } else {
    const storagePath = typeof body.storagePath === "string" ? body.storagePath : "";
    const durationS = num(body.durationS);
    const width = num(body.width);
    const height = num(body.height);
    if (!storagePath || !storagePath.startsWith(`${user.id}/`)) {
      return NextResponse.json({ error: "動画をアップロードしてください。" }, { status: 400 });
    }
    if (!durationS || !width || !height) {
      return NextResponse.json({ error: "動画の長さ・大きさを読み取れませんでした。別のファイルでお試しください。" }, { status: 400 });
    }
    if (durationS > VIDEO_FIX_MAX_SOURCE_S) {
      return NextResponse.json({ error: `動画は ${VIDEO_FIX_MAX_SOURCE_S / 60} 分までにしてください。` }, { status: 400 });
    }
    const located = await locateStudioUpload(user.id, storagePath);
    if (located.store !== "r2") {
      return NextResponse.json({ error: "動画の読み込みに失敗しました。もう一度アップロードしてください。" }, { status: 400 });
    }
    source = { kind: "upload", storagePath, durationS, width, height, r2Key: located.key };
  }

  // --- 区間・境目・音声 ----------------------------------------------------
  const startS = num(body.startS);
  const endS = body.endS == null ? null : num(body.endS);
  if (startS == null || startS < 0) return NextResponse.json({ error: "開始秒を入れてください。" }, { status: 400 });
  if (endS != null && endS - startS < VIDEO_FIX_MIN_REGEN_S) {
    return NextResponse.json({ error: `作り直す区間は ${VIDEO_FIX_MIN_REGEN_S} 秒以上にしてください。` }, { status: 400 });
  }
  const seamStart = isVideoFixSeam(body.seamStart) ? body.seamStart : "blend";
  // 最後まで作り直すときは終わり側の境目が無い。
  const seamEnd = endS != null && isVideoFixSeam(body.seamEnd) ? body.seamEnd : "blend";
  const keepAudio = body.keepAudio !== false;

  // 足す参照写真（最大 8 枚・1 枚目は作り直しの直前のコマをワーカーが切り出す）。中身は起動の直前に読む。
  const extraRefPaths = Array.isArray(body.extraRefPaths)
    ? (body.extraRefPaths as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 8)
    : [];
  if (extraRefPaths.some((x) => !x.startsWith(`${user.id}/`))) {
    return NextResponse.json({ error: "参照写真の指定が不正です。" }, { status: 400 });
  }
  const extraRefNames = extraRefPaths.map(
    (x, i) => `vfref${i + 2}_${(x.split("/").pop() || "ref.png").replace(/[^A-Za-z0-9._-]/g, "_")}`,
  );
  const extraRefRoles: DirectorRefRole[] = extraRefPaths.map((_, i) => {
    const r = Array.isArray(body.extraRefRoles) ? (body.extraRefRoles as unknown[])[i] : undefined;
    return isDirectorRefRole(r) ? r : "person";
  });

  const knobs = await getPricingKnobs();
  let quote: VideoFixQuote;
  try {
    quote = videoFixQuote({
      durationS: source.durationS,
      width: source.width,
      height: source.height,
      startS,
      endS,
      seamStart,
      seamEnd,
      extraRefCount: extraRefPaths.length,
      knobs,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "区間の指定が正しくありません。" }, { status: 400 });
  }

  // --- 指示文 -----------------------------------------------------------
  const promptInput =
    typeof body.prompt === "string"
      ? normalizeReferenceTags(body.prompt.trim().slice(0, VIDEO_FIX_PROMPT_MAX_LENGTH), 1 + extraRefPaths.length)
      : "";
  if (!promptInput) return NextResponse.json({ error: "作り直す区間で何が起きるかを書いてください。" }, { status: 400 });
  const inputPolicy = evaluateContentPolicyMany([promptInput]);
  if (inputPolicy.blocked) {
    logContentPolicyBlock("director/video-fix", inputPolicy, user.id);
    return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
  }

  const queue = body.queue === true;
  const priority = !queue && (body.priority === true || body.priority === "true");
  const creditsCost = priority ? quote.credits + directorPriorityParallelSurcharge(knobs, quote.credits) : quote.credits;

  const { data: profile, error: profileError } = await getOrCreateProfile(user.id, "credits, credits_expire_at");
  if (profileError) {
    console.error("[director/video-fix] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }
  const expireAt = profile?.credits_expire_at as string | null | undefined;
  const rawCredits = (profile?.credits as number | null | undefined) ?? 0;
  const isExpired = expireAt ? new Date(expireAt).getTime() < Date.now() : false;
  const currentCredits = isExpired ? 0 : rawCredits;
  if (isExpired && rawCredits > 0) await supabaseAdmin.from("profiles").update({ credits: 0 }).eq("id", user.id);
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

  // 日本語なら英訳する（MiniMax H3 は英語の指示文前提）。課金の前に済ませる。
  let prompt = promptInput;
  if (looksJapaneseOutsideDialogue(promptInput)) {
    try {
      prompt = await translateJapanesePromptToEnglish(promptInput);
    } catch (err) {
      const e = err as DirectorPromptError;
      const status = e.reason === "quota" ? 429 : e.reason === "busy" ? 503 : e.reason === "refusal" ? 400 : 502;
      return NextResponse.json(
        { error: e.reason === "refusal" ? "指示文を読み取れませんでした。英語で書くか、言い回しを変えてお試しください。" : e.message },
        { status },
      );
    }
  }
  const combinedPolicy = evaluateContentPolicyMany([prompt]);
  if (combinedPolicy.blocked) {
    logContentPolicyBlock("director/video-fix:combined", combinedPolicy, user.id);
    return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
  }
  // 結果画面の日本語表示（書いたのが日本語ならそのまま・英語なら訳す。失敗しても続ける）。
  const promptJa = looksJapaneseOutsideDialogue(promptInput) ? promptInput : await translateDirectorPromptToJapanese(prompt);

  // クレジットはその場で引く（確かめるのと引くのを 1 回の操作に。同時に送られても 1 本分の料金で何本も作れない・2026-10-09）。
  try {
    const after = await debitCredits(user.id, creditsCost);
    if (after === null) {
      return NextResponse.json(
        { error: "クレジットが不足しています。チャージしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 402 },
      );
    }
  } catch (err) {
    console.error("[director/video-fix] failed to debit credits:", err);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  const seed =
    typeof body.seed === "number" && Number.isInteger(body.seed) && body.seed > 0 && body.seed < 2 ** 32
      ? body.seed
      : 1 + Math.floor(Math.random() * (2 ** 32 - 1));
  const gpu = videoFixGpu(quote.megapixelSeconds, knobs);
  const regenStartS = quote.regenStart / 24;
  const regenEndS = quote.toEnd ? null : quote.regenEnd / 24;
  const inputs = {
    output: "video_fix",
    combined_prompt: prompt,
    combined_prompt_ja: promptJa,
    prompt_input: promptInput,
    source_kind: source.kind,
    source_job_id: source.kind === "director" ? source.jobId : null,
    source_storage_path: source.kind === "upload" ? source.storagePath : null,
    // 部分修正の結果も元と同じ長さ・寸法の動画なので、さらに部分修正へ回せる（同じ欄を読む）。
    total_duration_s: source.durationS,
    out_width: quote.width,
    out_height: quote.height,
    start_s: startS,
    end_s: endS,
    regen_start_s: regenStartS,
    regen_end_s: regenEndS,
    seam_start: seamStart,
    seam_end: seamEnd,
    keep_audio: keepAudio,
    window_s: quote.winSeconds,
    quality_mode: "fast",
    seed,
    extra_ref_paths: extraRefPaths.length ? extraRefPaths : null,
    extra_ref_roles: extraRefPaths.length ? extraRefRoles : null,
  };
  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("generation_jobs")
    .insert({
      user_id: user.id,
      status: queue ? "reserved" : "queued",
      workflow_type: "director",
      inputs,
      credits_cost: creditsCost,
      metadata: {
        output: "video_fix",
        out_width: quote.width,
        out_height: quote.height,
        total_duration_s: source.durationS,
        window_s: quote.winSeconds,
        megapixel_seconds: Math.round(quote.megapixelSeconds * 100) / 100,
        gpu_choice: gpu,
        quality_mode: "fast",
        priority,
        ...(extraRefPaths.length ? { reference_images: extraRefPaths.length + 1 } : {}),
      },
    })
    .select("id")
    .single();
  if (jobError || !jobRow) {
    console.error("[director/video-fix] failed to create job row:", jobError?.message);
    await refundCredits(user.id, creditsCost);
    return NextResponse.json({ error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits }, { status: 500 });
  }
  const jobId = jobRow.id as string;

  const tag = jobId.slice(0, 8);
  const names = { video: `vfix_${tag}_src.mp4`, audio: `vfix_${tag}_src.wav`, ref: `vfix_${tag}_ref.png` };
  const workflow = buildVideoFixWorkflow({
    mode: CINEMATIC_MODE_BY_ID.vdnFast,
    prompt,
    videoName: names.video,
    audioName: names.audio,
    refFrameName: names.ref,
    extraReferenceImageNames: extraRefNames,
    extraReferenceRoles: extraRefRoles,
    keepAudio,
    jobId,
    seed,
  });
  // SageAttention は H200（Hopper）向けにはビルドしていない（image は Blackwell 向けだけ）。
  if (gpu === "H200") workflow["105:124"].inputs.sage_attention = "disabled";

  const spec: DirectorDispatchSpec = {
    storagePath: "",
    referenceImageName: "",
    creditsCost,
    // 温まり返金（2026-10-10）: 比べる額は並列の追加料金を除いた通常料金。単価・上限は Director と同じ（同じワーカー・同じ GPU 単価）。
    warmSettle: directorWarmSettle(quote.credits, gpu, knobs),
    workflow,
    pollDeadlineS: Math.min(3600, directorPollDeadlineS(quote.winSeconds, "fast") + 300),
    ...(gpu !== "B300" ? { gpu } : {}),
    videoFix: {
      start_s: regenStartS,
      end_s: regenEndS ?? -1,
      seam_start: seamStart,
      seam_end: seamEnd,
      // 料金を決めた窓の秒数を上限に（申告の長さが違ってもこれを超えて処理しない）。
      max_window_s: quote.winSeconds,
      max_pixels: VIDEO_FIX_MAX_PIXELS,
      max_source_s: VIDEO_FIX_MAX_SOURCE_S,
      keep_audio: keepAudio,
      video_name: names.video,
      audio_name: names.audio,
      ref_name: names.ref,
    },
    videoFixSource: source.r2Key ? { r2Key: source.r2Key } : { volumePath: source.kind === "director" ? source.volumePath : undefined },
    ...(extraRefPaths.length ? { extraRefStoragePaths: extraRefPaths, extraRefNames } : {}),
  };

  const result = { jobId, creditsCost, remainingCredits: currentCredits - creditsCost, windowS: quote.winSeconds };
  if (queue) {
    try {
      await saveDispatchSpec("director", jobId, user.id, JSON.parse(JSON.stringify(spec)));
    } catch (err) {
      console.error("[director/video-fix] save spec failed:", (err as Error).message);
      await supabaseAdmin.from("generation_jobs").delete().eq("id", jobId);
      await refundCredits(user.id, creditsCost);
      return NextResponse.json(
        { error: "予約に失敗しました。しばらくしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 500 },
      );
    }
    const started = await advanceQueue("director", user.id);
    return NextResponse.json({ ...result, reserved: started !== jobId });
  }

  try {
    await dispatchDirectorJob(jobId, user.id, spec);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[director/video-fix] dispatch failed:", message);
    await supabaseAdmin.from("generation_jobs").update({ status: "failed", error_message: message.slice(0, 2000) }).eq("id", jobId);
    await refundCredits(user.id, creditsCost);
    return NextResponse.json({ error: "生成の開始に失敗しました。", remainingCredits: currentCredits }, { status: 502 });
  }
  return NextResponse.json({ ...result, reserved: false });
}
