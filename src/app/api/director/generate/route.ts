import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { downloadStudioUpload, deleteStudioUploads } from "@/lib/studioUploads.server";
import { readImageDimensions } from "@/lib/imageDimensions";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import {
  DIRECTOR_MAX_AUDIO_SECONDS,
  DIRECTOR_MAX_TOTAL_SECONDS,
  DIRECTOR_MIN_SCENE_DURATION_S,
  DIRECTOR_MUSIC_MAX_LENGTH,
  DIRECTOR_SECONDS_PER_SCENE,
  directorCostBreakdown,
  directorCostBreakdownForDuration,
  directorCreditsWorstCase,
  directorPollDeadlineS,
  photoDirectorCredits,
  clampPhotoCount,
  photoDirectorPollDeadlineS,
  PHOTO_IDEA_MAX_LENGTH,
  directorPriorityParallelSurcharge,
  directorExtraRefSurcharge,
  directorQwenScriptSurcharge,
  directorAspectDims,
  isDirectorAspectId,
  isDirectorQualityMode,
  isDirectorReferenceMode,
  isDirectorRefRole,
  isDirectorRefVideoRole,
  directorRefVideoSurcharge,
  DIRECTOR_REF_VIDEO_MAX_S,
  DIRECTOR_REF_VIDEO_MIN_S,
  validateDirectorScenes,
  type DirectorAspectId,
  type DirectorRefRole,
  type DirectorRefVideoRole,
  type DirectorQualityMode,
  type DirectorScene,
} from "@/lib/directorPricing";
import {
  buildJapaneseTranslationPrompt,
  buildSceneDirectorPrompt,
  DirectorPromptError,
  expandDirectorScenes,
  expandPhotoIdea,
  buildPhotoPrompt,
  looksJapaneseOutsideDialogue,
  withConceptNotes,
  withIdentityAnchor,
  withSoundtrackAnchor,
  translateDirectorPromptToJapanese,
  translateJapanesePromptToEnglish,
  withJapaneseTranslationRequest,
  type DirectorPromptOptions,
} from "@/lib/directorPrompt";
import { buildCinematicWorkflow, buildPhotoWorkflow, CINEMATIC_PROMPT_NODE_ID } from "@/lib/cinematicWorkflow";
import { headR2, r2UserRoot } from "@/lib/r2.server";
import { assertOwnedDirectorLoraVolumePath, isOwnedDirectorLoraR2Key } from "@/lib/directorLoraUpload.server";
import { CINEMATIC_MODE_BY_ID, cinematicMegapixelsForDuration, cinematicSafeDimensions } from "@/lib/cinematicPricing";
import { dispatchDirectorJob, type DirectorDispatchSpec } from "@/lib/directorDispatch.server";
import { advanceQueue, saveDispatchSpec } from "@/lib/studioQueue.server";
import { DIRECTOR_LORA_PRESET_IDS } from "@/lib/loraModels";
import {
  CONTENT_POLICY_BLOCK_MESSAGE,
  evaluateContentPolicyMany,
  logContentPolicyBlock,
} from "@/lib/contentPolicy";

// Phase 1（Gemini によるシーン合成）+ Phase 2（MiniMax H3 ディスパッチ）を
// 1つの route でまとめて行う非同期ジョブ起点。生成そのものは待たない
// （spawnDirectorJob が .spawn() して即 ACK、実処理は generation_jobs の行を
// 直接 PATCH — /api/jobs/[id] でポーリング）。
export const maxDuration = 60;

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

  // 作り直し（2026-10-01、ホスト要望）: 完了した動画を元に、同じ台本（AI が書いた最終の指示文＝combined_prompt）で作り直す。
  // 参照画像・尺・LoRA は元のジョブから引き継ぐので、再読み込み後でも画像を入れ直さずに押せる。
  //   variation "new_seed"  … 別パターン（台本はそのまま、揺れだけ変える）
  //   variation "same_seed" … この動画をもとに調整（同じシードで、編集した rawPrompt や画質を変えて作り直す）
  // 台本は AI が毎回書き直すので、シードだけ固定しても再現しない。台本ごと引き継ぐのはそのため。
  const baseJobId = typeof body.baseJobId === "string" ? body.baseJobId : "";
  // 予約（2026-10-03、lib/studioQueue.server.ts）: 課金して行を reserved で作り、順番が来たらサーバーが起動する。
  const queue = body.queue === true;
  // Photo Director（2026-10-06）: 同じ GPU・同じ土台（10Eros）で、参照モードを 5 フレームだけ回して静止画にする。
  // ジョブは Director と同じ workflow_type "director"（予約の順番・返金・ログ・GPU を共用）で、inputs.output = "photo"。
  // 使わない欄（シーン・音声・手本・LoRA・作り直し）はここで落とす。
  const isPhoto = body.output === "photo";
  const photoIdea = isPhoto && typeof body.photoIdea === "string" ? body.photoIdea.trim().slice(0, PHOTO_IDEA_MAX_LENGTH) : "";
  const photoCount = isPhoto
    ? clampPhotoCount(body.photoCount)
    : 0;
  if (isPhoto) {
    if (baseJobId) return NextResponse.json({ error: "写真は作り直しに対応していません。" }, { status: 400 });
    if (!photoIdea) return NextResponse.json({ error: "どんな写真にしたいかを書いてください。" }, { status: 400 });
    body = {
      storagePath: body.storagePath,
      referenceMode: "reference",
      aspect: body.aspect,
      extraRefPaths: body.extraRefPaths,
      extraRefRoles: body.extraRefRoles,
      priority: body.priority,
      queue: body.queue,
      seed: body.seed,
    };
  }
  let reusingScript = false;
  if (baseJobId) {
    const { data: baseJob } = await supabaseAdmin
      .from("generation_jobs")
      .select("status, inputs")
      .eq("id", baseJobId)
      .eq("user_id", user.id)
      .eq("workflow_type", "director")
      .maybeSingle();
    const bi = (baseJob?.inputs ?? null) as Record<string, unknown> | null;
    const refPath = typeof bi?.reference_storage_path === "string" ? bi.reference_storage_path : "";
    const basePrompt = typeof bi?.combined_prompt === "string" ? bi.combined_prompt : "";
    if (!bi || baseJob?.status !== "completed" || !refPath || !basePrompt) {
      return NextResponse.json({ error: "この動画からは作り直せません。新しく生成してください。" }, { status: 400 });
    }
    const edited = typeof body.rawPrompt === "string" ? body.rawPrompt.trim() : "";
    reusingScript = !edited;
    body = {
      storagePath: refPath,
      rawPrompt: edited || basePrompt,
      rawDurationS: typeof body.rawDurationS === "number" ? body.rawDurationS : bi.total_duration_s,
      quality: isDirectorQualityMode(body.quality) ? body.quality : bi.quality_mode,
      priority: body.priority,
      ...(typeof bi.lora_id === "string" && bi.lora_id ? { loraId: bi.lora_id } : {}),
      ...(typeof bi.lora_upload_volume_path === "string" && bi.lora_upload_volume_path
        ? { loraUploadVolumePath: bi.lora_upload_volume_path }
        : {}),
      ...(typeof bi.lora_upload_r2_key === "string" && bi.lora_upload_r2_key
        ? { loraUploadR2Key: bi.lora_upload_r2_key }
        : {}),
      ...(typeof bi.lora_trigger_word === "string" && bi.lora_trigger_word
        ? { loraTriggerWord: bi.lora_trigger_word }
        : {}),
      ...(body.variation === "same_seed" && typeof bi.seed === "number" ? { seed: bi.seed } : {}),
      // 持ち込み音声・参照のしかた（2026-10-05〜）も引き継ぐ。音声があれば尺は音声で決まる。
      ...(typeof bi.audio_storage_path === "string" && bi.audio_storage_path
        ? { audioStoragePath: bi.audio_storage_path, audioDurationS: bi.audio_duration_s }
        : {}),
      ...(isDirectorReferenceMode(bi.reference_mode) ? { referenceMode: bi.reference_mode } : {}),
      ...(isDirectorAspectId(bi.aspect) ? { aspect: bi.aspect } : {}),
      ...(Array.isArray(bi.extra_ref_paths) ? { extraRefPaths: bi.extra_ref_paths } : {}),
      // 参照の使い方・手本の動画と声（2026-10-06〜）。
      ...(Array.isArray(bi.extra_ref_roles) ? { extraRefRoles: bi.extra_ref_roles } : {}),
      ...(typeof bi.ref_video_path === "string" && bi.ref_video_path
        ? { refVideoPath: bi.ref_video_path, refVideoRole: bi.ref_video_role, refVideoDurationS: bi.ref_video_duration_s }
        : {}),
      ...(typeof bi.ref_voice_path === "string" && bi.ref_voice_path ? { refVoicePath: bi.ref_voice_path } : {}),
    };
  }
  const seed =
    typeof body.seed === "number" && Number.isInteger(body.seed) && body.seed > 0 && body.seed < 2 ** 32
      ? body.seed
      : 1 + Math.floor(Math.random() * (2 ** 32 - 1));

  const storagePath = typeof body.storagePath === "string" ? body.storagePath : "";
  if (!storagePath) {
    return NextResponse.json({ error: "参照画像をアップロードしてください。" }, { status: 400 });
  }

  // 画質モード（2026-09-14、VDN-H3導入に伴い旧speed固定を廃止）。
  // fast=8step蒸留(無音・低コスト)、quality=50step非蒸留(音声あり)。
  const qualityMode: DirectorQualityMode = isDirectorQualityMode(body.quality) ? body.quality : "fast";

  // 参照のしかた（2026-10-05）: reference = 画像を顔写真として参照する（最初のフレームにしない）。縦横は選んだもの。
  const referenceMode = isDirectorReferenceMode(body.referenceMode) ? body.referenceMode : "first_frame";
  const aspect: DirectorAspectId = isDirectorAspectId(body.aspect) ? body.aspect : "image";

  // 持ち込み音声（歌・セリフ、2026-10-05）: そのまま使い、口を合わせる。尺は音声の長さ（画面が測った秒数・最長 68 秒）。
  // 申告より長い音声でも、映像の長さに切り詰められるだけ（ComfyUI の LTXVConcatAVLatent）なので課金は崩れない。
  const audioStoragePath = typeof body.audioStoragePath === "string" ? body.audioStoragePath.trim() : "";
  const audioDurationS =
    audioStoragePath && typeof body.audioDurationS === "number" && Number.isFinite(body.audioDurationS)
      ? Math.min(DIRECTOR_MAX_AUDIO_SECONDS, Math.max(DIRECTOR_MIN_SCENE_DURATION_S, Math.ceil(body.audioDurationS)))
      : 0;
  if (audioStoragePath && !audioDurationS) {
    return NextResponse.json({ error: "音声の長さを読み取れませんでした。別のファイルでお試しください。" }, { status: 400 });
  }
  const audioName = audioStoragePath
    ? (audioStoragePath.split("/").pop() || "audio.wav").replace(/[^A-Za-z0-9._-]/g, "_")
    : "";
  // 「顔写真として使う」で足す写真（2 枚目以降・最大 8 枚、2026-10-05）。置き場所は送信時に画面が上げた studio_uploads。
  // 中身は起動の直前に読む（directorDispatch）。参照モード以外では使わない。
  const extraRefPaths =
    referenceMode === "reference" && Array.isArray(body.extraRefPaths)
      ? (body.extraRefPaths as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 8)
      : [];
  if (extraRefPaths.some((x) => !x.startsWith(`${user.id}/`))) {
    return NextResponse.json({ error: "参照写真の指定が不正です。" }, { status: 400 });
  }
  const extraRefNames = extraRefPaths.map(
    (x, i) => `ref${i + 2}_${(x.split("/").pop() || "ref.png").replace(/[^A-Za-z0-9._-]/g, "_")}`,
  );
  // 足した写真それぞれの使い方（2026-10-06、extraRefPaths と同じ順）。無い・不明は「同じ人物」（従来の動き）。
  const extraRefRoles: DirectorRefRole[] = extraRefPaths.map((_, i) => {
    const r = Array.isArray(body.extraRefRoles) ? (body.extraRefRoles as unknown[])[i] : undefined;
    return isDirectorRefRole(r) ? r : "person";
  });
  // 手本の動画（動き／カメラ、2〜15 秒）と声の手本（2026-10-06）。参照モードだけ。長さは画面が測った秒数。
  // 申告より長い動画でもノードが出力の長さで切り詰めるだけで、上乗せは 15 秒で頭打ちなので課金は崩れない。
  const refVideoPath =
    referenceMode === "reference" && typeof body.refVideoPath === "string" ? body.refVideoPath.trim() : "";
  const refVideoRole: DirectorRefVideoRole = isDirectorRefVideoRole(body.refVideoRole) ? body.refVideoRole : "motion";
  const refVideoDurationS = refVideoPath
    ? Math.min(
        DIRECTOR_REF_VIDEO_MAX_S,
        Math.max(DIRECTOR_REF_VIDEO_MIN_S, typeof body.refVideoDurationS === "number" && Number.isFinite(body.refVideoDurationS) ? body.refVideoDurationS : DIRECTOR_REF_VIDEO_MAX_S),
      )
    : 0;
  // 歌・セリフを持ち込んだときは声がもう決まっているので、声の手本は使わない。
  const refVoicePath =
    referenceMode === "reference" && !audioStoragePath && typeof body.refVoicePath === "string" ? body.refVoicePath.trim() : "";
  if ([refVideoPath, refVoicePath].some((x) => x && !x.startsWith(`${user.id}/`))) {
    return NextResponse.json({ error: "参照ファイルの指定が不正です。" }, { status: 400 });
  }
  const refVideoName = refVideoPath ? `refvid_${(refVideoPath.split("/").pop() || "ref.mp4").replace(/[^A-Za-z0-9._-]/g, "_")}` : "";
  const refVoiceName = refVoicePath ? `refvoice_${(refVoicePath.split("/").pop() || "voice.wav").replace(/[^A-Za-z0-9._-]/g, "_")}` : "";
  const promptOpts: DirectorPromptOptions = {
    soundtrack: audioDurationS ? { durationS: audioDurationS } : undefined,
    referenceMode: referenceMode === "reference",
    references: {
      roles: extraRefRoles,
      videoRole: refVideoPath ? refVideoRole : undefined,
      voice: Boolean(refVoicePath),
    },
  };

  // Advanced モード（2026-09-18追加。TODO(advanced-gate): 月額プラン限定に
  // する場合はここで契約状態をチェックする — 今回は未実装、機能本体のみ）:
  // conceptText が非空文字列なら、シーンビルダー/プロンプトモードいずれも
  // 迂回し、Qwen（自己ホストVLM）が参照画像を見て台本を書き起こす。
  const conceptTextInput = typeof body.conceptText === "string" ? body.conceptText.trim() : "";
  const isAdvancedMode = conceptTextInput.length > 0;

  // プロンプトモード（結果画面に表示された合成済みプロンプトをコピペ・微修正
  // して直接投げる経路、2026-09-14）: rawPrompt が非空文字列ならシーン
  // ビルダーを完全に迂回し、Gemini合成もスキップしてそのまま使う。
  const rawPromptInput = typeof body.rawPrompt === "string" ? body.rawPrompt.trim() : "";
  const isPromptMode = !isAdvancedMode && rawPromptInput.length > 0;

  // 音楽・環境音の指示（任意、2026-09-15追加。シーンビルダー限定 — プロンプト
  // モード/Advancedモードは専用欄を設けない）。
  const musicDirectionInput =
    !isPromptMode && !isAdvancedMode && typeof body.musicDirection === "string"
      ? body.musicDirection.trim().slice(0, DIRECTOR_MUSIC_MAX_LENGTH)
      : "";

  let scenes: DirectorScene[] = [];
  if (isPhoto) {
    const policyResult = evaluateContentPolicyMany([photoIdea]);
    if (policyResult.blocked) {
      logContentPolicyBlock("director/generate:photo", policyResult, user.id);
      return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
    }
  } else if (isAdvancedMode) {
    const policyResult = evaluateContentPolicyMany([conceptTextInput]);
    if (policyResult.blocked) {
      logContentPolicyBlock("director/generate:advanced", policyResult, user.id);
      return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
    }
  } else if (!isPromptMode) {
    const validated = validateDirectorScenes(body.scenes);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }
    // 音声を持ち込んだときはセリフ欄を使わない（音声がそのまま声になる）。
    scenes = audioDurationS ? validated.scenes.map((s) => ({ ...s, dialogue: undefined })) : validated.scenes;

    // レッドライン・フィルター（他の生成系エンドポイントと同一の入口対策）。
    // 台詞・音楽指示もユーザー入力テキストなので同じチェックに含める。
    const policyResult = evaluateContentPolicyMany([
      ...scenes.map((s) => s.text),
      ...scenes.map((s) => s.dialogue).filter((d): d is string => Boolean(d)),
      ...(musicDirectionInput ? [musicDirectionInput] : []),
    ]);
    if (policyResult.blocked) {
      logContentPolicyBlock("director/generate", policyResult, user.id);
      return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
    }
  } else {
    const policyResult = evaluateContentPolicyMany([rawPromptInput]);
    if (policyResult.blocked) {
      logContentPolicyBlock("director/generate:raw_prompt", policyResult, user.id);
      return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
    }
  }

  // LoRA（2026-09-18追加）: 全モード共通のオプション。2系統のどちらか一方:
  //   ①loraId: LoRA Studio で本人が学習済みの MiniMax H3 LoRA
  //     （Volume常駐・14日パージ対象。DBで所有権を確認してから使う）
  //   ②loraUploadVolumePath: 外部で用意した .safetensors を
  //     modal_lora_worker.py::upload_user_lora へブラウザから直接
  //     アップロード済みのもの（"director_user_loras/<user_id>/<file>"。
  //     Supabase Storageは一切経由しない——Freeプランのグローバル
  //     アップロード上限(50MB)が実運用サイズのLoRA(~1.18GB)を弾くため、
  //     2026-09-18に撤回した。生成物ではなく入力データ扱いなので期限も
  //     設けない——CLAUDE.md §3の対象外という整理）
  const loraIdRaw = typeof body.loraId === "string" ? body.loraId.trim() : "";
  const loraUploadVolumePathRaw =
    typeof body.loraUploadVolumePath === "string" ? body.loraUploadVolumePath.trim() : "";
  // 2026-10-03〜 の持ち込みは R2（/api/director/loras/r2-upload）。Volume のパスは旧ジョブの作り直し用に残す。
  const loraUploadR2KeyRaw = typeof body.loraUploadR2Key === "string" ? body.loraUploadR2Key.trim() : "";
  // トリガーワード（カンマ区切りで複数可）。改行は潰し、長さを切る。LoRA が無ければ使わない。
  const loraTriggerWord =
    (loraIdRaw || loraUploadVolumePathRaw || loraUploadR2KeyRaw) && typeof body.loraTriggerWord === "string"
      ? body.loraTriggerWord.replace(/\s+/g, " ").trim().slice(0, 120)
      : "";
  if ([loraIdRaw, loraUploadVolumePathRaw, loraUploadR2KeyRaw].filter(Boolean).length > 1) {
    return NextResponse.json({ error: "LoRAの指定が重複しています。" }, { status: 400 });
  }

  let loraName: string | undefined;
  let loraVolumePath: string | undefined;
  // 学習済み LoRA の R2 キー（起動時に署名して渡す。予約から起動するときも期限切れにならないように）。
  let loraR2Key: string | undefined;
  if (loraIdRaw) {
    if (!/^[A-Za-z0-9_-]+$/.test(loraIdRaw)) {
      return NextResponse.json({ error: "LoRAの指定が不正です。" }, { status: 400 });
    }
    // CLAUDE.md §3 の14日自動パージ（modal_retention_purge.py、created_at
    // 起点）— DB行がパージより先に消えるとは限らないため、実体ファイルが
    // 既に消えていそうな古い行は明示的に弾く（created_at が 14 日前ちょうどの行で
    // 実体が既に消えていたのを実機で確認済み）。
    const retentionCutoffIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    // loraId は LoRA Studio の学習ジョブの id（2026-10-03〜、完了画面の「動画を作る」から渡す）。
    // それ以前の作り直しは LoRA 名（output_lora_name）で来るので、その場合は名前で一番新しいものを引く。
    const isJobId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(loraIdRaw);
    let loraQuery = supabaseAdmin
      .from("generation_jobs")
      .select("id, metadata")
      .eq("user_id", user.id)
      .eq("workflow_type", "lora_training")
      .eq("status", "completed")
      .in("inputs->>target_model", [...DIRECTOR_LORA_PRESET_IDS])
      .gte("created_at", retentionCutoffIso);
    loraQuery = isJobId ? loraQuery.eq("id", loraIdRaw) : loraQuery.eq("inputs->>output_lora_name", loraIdRaw);
    const { data: loraJob } = await loraQuery
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!loraJob) {
      return NextResponse.json({ error: "指定されたLoRAが見つかりません。" }, { status: 400 });
    }
    // 完成版の置き場所（2026-10-03）。学習の完成品は R2 へ移って Volume から消えるので、記録（metadata.checkpoints）
    // から最終版を探し、R2 にあれば署名 URL、まだ Volume にあればその場所を渡す。名前は `<lora名>.safetensors` では
    // なく `_final` 付き（以前はここが食い違い、Volume も見ていたので学習済み LoRA は一度も使えなかった）。
    const ckpts = ((loraJob.metadata as { checkpoints?: unknown } | null)?.checkpoints ?? []) as {
      filename?: string;
      path?: string;
      r2_key?: string;
      is_final?: boolean;
    }[];
    const finalCkpt = ckpts.find((c) => c?.is_final && typeof c.filename === "string" && c.filename.endsWith(".safetensors"));
    if (!finalCkpt?.filename) {
      return NextResponse.json({ error: "この LoRA の完成版が見つかりません。" }, { status: 400 });
    }
    // ComfyUI の loras/ に置く名前。別のジョブの同名 LoRA と取り違えないようジョブ id を前に付ける。
    loraName = `${String(loraJob.id).slice(0, 8)}_${finalCkpt.filename}`.replace(/[^A-Za-z0-9._-]/g, "_");
    if (finalCkpt.r2_key) loraR2Key = finalCkpt.r2_key;
    else if (finalCkpt.path) loraVolumePath = finalCkpt.path;
    else return NextResponse.json({ error: "この LoRA の完成版が見つかりません。" }, { status: 400 });
  } else if (loraUploadVolumePathRaw) {
    try {
      assertOwnedDirectorLoraVolumePath(user.id, loraUploadVolumePathRaw);
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
    // アップロード先パスは "director_user_loras/<user_id>/<uuid>-<safeName>
    // .safetensors" なので、basename をそのまま ComfyUI 向けの一意な
    // ファイル名として使い回せる。
    const uploadedFilename = loraUploadVolumePathRaw.split("/").pop() || "";
    if (!/^[A-Za-z0-9_-]+\.safetensors$/.test(uploadedFilename)) {
      return NextResponse.json({ error: "LoRAファイルの指定が不正です。" }, { status: 400 });
    }
    loraVolumePath = loraUploadVolumePathRaw;
    loraName = uploadedFilename;
  } else if (loraUploadR2KeyRaw) {
    if (!isOwnedDirectorLoraR2Key(await r2UserRoot(user.id), loraUploadR2KeyRaw)) {
      return NextResponse.json({ error: "LoRAファイルの指定が不正です。" }, { status: 400 });
    }
    if ((await headR2(loraUploadR2KeyRaw)) == null) {
      return NextResponse.json(
        { error: "アップロードした LoRA が見つかりません。もう一度アップロードしてください。" },
        { status: 400 },
      );
    }
    loraR2Key = loraUploadR2KeyRaw;
    loraName = loraUploadR2KeyRaw.split("/").pop();
  }

  let imageBuffer: Buffer;
  try {
    imageBuffer = await downloadStudioUpload(user.id, storagePath);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  if (imageBuffer.length === 0) {
    return NextResponse.json({ error: "参照画像の取得に失敗しました。" }, { status: 400 });
  }

  const knobs = await getPricingKnobs();
  const rawDurationS = typeof body.rawDurationS === "number" ? body.rawDurationS : DIRECTOR_SECONDS_PER_SCENE;
  const breakdown = audioDurationS
    ? directorCostBreakdownForDuration({
        totalDurationS: audioDurationS,
        mode: qualityMode,
        knobs,
      })
    : isPromptMode || isAdvancedMode
    ? directorCostBreakdownForDuration({
        totalDurationS: Math.min(DIRECTOR_MAX_TOTAL_SECONDS, Math.max(1, rawDurationS)),
        mode: qualityMode,
        knobs,
      })
    : directorCostBreakdown({ scenes, mode: qualityMode, knobs });
  // Advanced（Qwen台本生成）は動画本体とは別のGPUコンテナを1回起動するので
  // その分を上乗せする（directorPricing.ts参照）。
  const videoCredits = breakdown.credits || directorCreditsWorstCase(knobs);
  const baseCreditsCost = isPhoto
    ? photoDirectorCredits(photoCount, extraRefPaths.length, knobs)
    : videoCredits +
    directorExtraRefSurcharge(videoCredits, extraRefPaths.length, knobs) +
    directorRefVideoSurcharge(videoCredits, refVideoDurationS, breakdown.totalDurationS, knobs) +
    (isAdvancedMode ? directorQwenScriptSurcharge(knobs) : 0);
  // 「実行中でも並列で今すぐ実行」を選んだ場合の追加コールドスタート分
  // （順番待ち=無料の既定に対するオプトインの上乗せ。CLAUDE.md §6参照）。
  // 予約は並列の追加料金を取らない（順番待ち）。
  const priority = !queue && (body.priority === true || body.priority === "true");
  const creditsCost = priority
    ? baseCreditsCost + directorPriorityParallelSurcharge(knobs, baseCreditsCost)
    : baseCreditsCost;

  // --- credits ---------------------------------------------------------
  const { data: profile, error: profileError } = await getOrCreateProfile(
    user.id,
    "credits, credits_expire_at",
  );
  if (profileError) {
    console.error("[director/generate] failed to load profile:", profileError.message);
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

  // --- Phase 1: Gemini でシーン合成（1本の連続した英語プロンプトへ） -------
  // プロンプトモードでは既に完成した英語プロンプトが渡される想定だが、
  // 日本語表示をそのままコピペして手直しするユーザーもいるため、日本語が
  // 検知された場合は送信前に自動で英訳する（2026-09-14、ホスト報告により
  // 追加 — MiniMax H3は英語プロンプト前提のため無音で日本語のまま送ると
  // 意図通りに生成されない）。
  // Advanced モード（2026-09-18追加）: ここではQwenを呼ばない。台本生成は
  // 動画生成と同じB300ワーカーコンテナ内（modal_wan_animate_blackwell.py
  // ::WanAnimateBlackwell._generate_director_script）で行う——別GPU
  // （H100/A100）を新たに起動すると二重コールドスタートになるため、既に
  // 起動済みのB300上で参照画像＋思いつきから台本を書き起こしてから
  // ComfyUIワークフローを実行する設計にした。ここでの combinedPrompt は
  // ワーカー側で必ず上書きされるプレースホルダー（qwenConceptText が
  // 渡っている限りモデルには一切渡らない）。
  // Gemini に断られたとき（2026-10-01）: 同じ指示文を動画と同じ B300 コンテナ内の Qwen（abliterated）に渡して
  // 合成させる（qwenTextInstruction）。NSFW を制限しない方針なのに、Gemini の拒否文がそのまま動画の指示になり、
  // 入力と無関係な動画で課金された実例があった（ジョブ 05627a3b）。普段は Gemini のまま（速い・GPU の追加時間なし）で、
  // 断られたときだけ Qwen を読み込む（その分の時間・原価はこちら持ち。追加料金は取らない）。
  // combinedPrompt はワーカー側で必ず上書きされるプレースホルダー（Advanced と同じ扱い）。
  let combinedPrompt: string;
  let qwenTextInstruction: string | undefined;
  const statusFor = (e: DirectorPromptError) =>
    e.reason === "quota" ? 429 : e.reason === "busy" ? 503 : e.reason === "not_configured" ? 501 : 502;
  if (isPhoto) {
    try {
      combinedPrompt = await expandPhotoIdea(photoIdea, promptOpts.references);
    } catch (err) {
      const e = err as DirectorPromptError;
      if (e.reason !== "refusal") return NextResponse.json({ error: e.message }, { status: statusFor(e) });
      console.warn("[director/generate] Gemini refused the photo prompt; falling back to the worker-side Qwen");
      qwenTextInstruction = withJapaneseTranslationRequest(buildPhotoPrompt(photoIdea, promptOpts.references));
      combinedPrompt = photoIdea;
    }
  } else if (isAdvancedMode) {
    combinedPrompt = conceptTextInput;
  } else if (isPromptMode) {
    // 作り直しで台本をそのまま使うときは訳し直さない（セリフが日本語でも、訳し直すと台本が変わる）。
    if (!reusingScript && looksJapaneseOutsideDialogue(rawPromptInput)) {
      try {
        combinedPrompt = await translateJapanesePromptToEnglish(rawPromptInput);
      } catch (err) {
        const e = err as DirectorPromptError;
        if (e.reason !== "refusal") return NextResponse.json({ error: e.message }, { status: statusFor(e) });
        console.warn("[director/generate] Gemini refused the translation; falling back to the worker-side Qwen");
        qwenTextInstruction = withJapaneseTranslationRequest(buildJapaneseTranslationPrompt(rawPromptInput));
        combinedPrompt = rawPromptInput;
      }
    } else {
      combinedPrompt = rawPromptInput;
    }
    // 「参照画像の人物のまま」の指示が無ければ先頭に足す（Qwen に回すときはワーカーが書き直すので不要）。
    if (!qwenTextInstruction) combinedPrompt = withIdentityAnchor(combinedPrompt);
    // 音声を持ち込んだときは長回しの宣言と「口を音声に合わせる」を先頭に（無ければ）。
    if (!qwenTextInstruction && promptOpts.soundtrack) combinedPrompt = withSoundtrackAnchor(combinedPrompt, promptOpts.soundtrack);
  } else {
    try {
      combinedPrompt = await expandDirectorScenes(scenes, musicDirectionInput || undefined, promptOpts);
    } catch (err) {
      const e = err as DirectorPromptError;
      if (e.reason !== "refusal") return NextResponse.json({ error: e.message }, { status: statusFor(e) });
      console.warn("[director/generate] Gemini refused the scene synthesis; falling back to the worker-side Qwen");
      qwenTextInstruction = withJapaneseTranslationRequest(
        buildSceneDirectorPrompt(scenes, musicDirectionInput || undefined, promptOpts),
      );
      combinedPrompt = scenes.map((s) => s.text).join("\n");
    }
  }

  // LoRA のトリガーワード（2026-10-04）: 最終の指示文に無ければ先頭に足す。Gemini の合成・英訳で名前が落ちることがある
  // （LoRA Studio の「うまく出ないときは」1 番。ホストが実際に踏んだ）。Qwen が書くとき（Advanced・断られたとき）は
  // ワーカーが書いた後に同じことをする（lora_trigger_word）。
  if (loraTriggerWord && !isAdvancedMode && !qwenTextInstruction) {
    combinedPrompt = withLoraTriggerWords(combinedPrompt, loraTriggerWord);
  }
  // 課金前の最終防波堤としてもう一度（Gemini が合成した英語文・ユーザーが
  // 直接編集した英語文のいずれにも念のため）。Advancedモードは combinedPrompt
  // がプレースホルダー（conceptTextInput）で、その内容自体は既に前段の
  // isAdvancedMode 分岐で評価済みなのでここでは重複チェックのみ行う
  // （実害はないが二重にはなる）。
  const combinedPolicy = evaluateContentPolicyMany([combinedPrompt]);
  if (combinedPolicy.blocked) {
    logContentPolicyBlock("director/generate:combined", combinedPolicy, user.id);
    return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
  }

  // 結果画面でのコピペ用日本語表示（ベストエフォート、失敗しても生成は続行）。
  // Advancedモードはまだ本物の英語プロンプトが存在しない（ワーカー側で
  // これから生成される）ため翻訳をスキップし、完了後の画面は英語のみ表示する。
  // Qwen に回したときも同じ（日本語訳はワーカーの Qwen が "===JA===" の後ろに一緒に書く）。
  const combinedPromptJa =
    isAdvancedMode || qwenTextInstruction ? null : await translateDirectorPromptToJapanese(combinedPrompt);

  const debitedCredits = currentCredits - creditsCost;
  const { error: debitError } = await supabaseAdmin
    .from("profiles")
    .update({ credits: debitedCredits })
    .eq("id", user.id);
  if (debitError) {
    console.error("[director/generate] failed to debit credits:", debitError.message);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  // --- job row -----------------------------------------------------------
  // directorInputsSnapshot をそのまま Modal ワーカーへも渡す（Advancedモード
  // でワーカー側が combined_prompt を書き戻す際、inputs の他フィールドを
  // 消さずマージするために必要 — PATCHはJSONBカラム丸ごと置き換えのため。
  // modal_wan_animate_blackwell.py の該当コメント参照）。
  const directorInputsSnapshot = {
    scenes: scenes.length ? scenes : null,
    combined_prompt: combinedPrompt,
    combined_prompt_ja: combinedPromptJa,
    total_duration_s: breakdown.totalDurationS,
    prompt_mode: isPromptMode,
    advanced_mode: isAdvancedMode,
    concept_text: isAdvancedMode ? conceptTextInput : null,
    quality_mode: qualityMode,
    music_direction: musicDirectionInput || null,
    lora_name: loraName || null,
    lora_source: loraIdRaw ? "trained" : loraUploadVolumePathRaw || loraUploadR2KeyRaw ? "upload" : null,
    // 作り直し用（2026-10-01〜）。これが無い古いジョブからは作り直せない。
    seed,
    reference_storage_path: storagePath,
    lora_id: loraIdRaw || null,
    lora_upload_volume_path: loraUploadVolumePathRaw || null,
    lora_upload_r2_key: loraUploadR2KeyRaw || null,
    lora_trigger_word: loraTriggerWord || null,
    base_job_id: baseJobId || null,
    audio_storage_path: audioStoragePath || null,
    audio_duration_s: audioDurationS || null,
    reference_mode: referenceMode,
    aspect,
    extra_ref_paths: extraRefPaths.length ? extraRefPaths : null,
    extra_ref_roles: extraRefPaths.length ? extraRefRoles : null,
    ref_video_path: refVideoPath || null,
    ref_video_role: refVideoPath ? refVideoRole : null,
    ref_video_duration_s: refVideoDurationS || null,
    ref_voice_path: refVoicePath || null,
    ...(isPhoto ? { output: "photo", photo_idea: photoIdea, photo_count: photoCount } : {}),
  };
  // 出力解像度（2026-09-24、ホスト「生成後の解像度がわからないので記載して」）。
  // buildCinematicWorkflow と同じ式で先に決め、metadata に残して完了画面が読む。
  const rawDimsForMeta = readImageDimensions(imageBuffer);
  const modeForMeta = CINEMATIC_MODE_BY_ID[qualityMode === "quality" ? "vdnQuality" : "vdnFast"];
  const aspectDims = directorAspectDims(referenceMode, aspect, rawDimsForMeta);
  const outDims = cinematicSafeDimensions(
    aspectDims.width,
    aspectDims.height,
    cinematicMegapixelsForDuration(modeForMeta, breakdown.totalDurationS),
  );

  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("generation_jobs")
    .insert({
      user_id: user.id,
      status: queue ? "reserved" : "queued",
      workflow_type: "director",
      inputs: directorInputsSnapshot,
      credits_cost: creditsCost,
      metadata: {
        scene_count: scenes.length,
        out_width: outDims.width,
        out_height: outDims.height,
        total_duration_s: breakdown.totalDurationS,
        prompt_mode: isPromptMode,
        advanced_mode: isAdvancedMode,
        // Gemini に断られて GPU 上の Qwen で合成した印（集計・調査用）。
        ...(qwenTextInstruction ? { prompt_fallback: "qwen" } : {}),
        quality_mode: qualityMode,
        priority,
        lora_name: loraName || null,
        ...(audioDurationS ? { with_audio: true } : {}),
        ...(referenceMode === "reference" ? { reference_mode: "reference" } : {}),
        ...(extraRefPaths.length ? { reference_images: extraRefPaths.length + 1 } : {}),
        ...(extraRefRoles.some((r) => r !== "person") ? { reference_roles: extraRefRoles } : {}),
        ...(refVideoPath ? { reference_video: refVideoRole, reference_video_s: refVideoDurationS } : {}),
        ...(refVoicePath ? { reference_voice: true } : {}),
        ...(isPhoto ? { output: "photo", photo_count: photoCount } : {}),
      },
    })
    .select("id")
    .single();

  if (jobError || !jobRow) {
    console.error("[director/generate] failed to create job row:", jobError?.message);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      { error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits },
      { status: 500 },
    );
  }
  const jobId = jobRow.id as string;

  // --- Phase 2: MiniMax H3 へディスパッチ ---------------------------------
  // 2026-09-14: 旧 speed 固定(4step蒸留LoRA)を廃止。VDN-H3導入により
  // fast(vdnFast)/quality(vdnQuality)をユーザーが選べるようにした
  // （[[vdn-h3-speedup-integration]] 参照 — 4step蒸留LoRAは複数シーンの
  // 複雑なプロンプトで指示追従性が崩壊する実障害があった）。
  const mode = CINEMATIC_MODE_BY_ID[qualityMode === "quality" ? "vdnQuality" : "vdnFast"];
  const referenceImageName = storagePath.split("/").pop() || "reference.png";
  // 実画像の生の寸法を渡す（cinematicWorkflow.ts の cinematicSafeDimensions
  // が「ピクセル ≡ 16 (mod 32)」を満たす安全な width/height を計算する —
  // 2026-09-13 実障害の修正。渡さないと正方形前提にフォールバックし、
  // 任意アスペクト比の入力で patchify がクラッシュしうる）。
  const rawDims = readImageDimensions(imageBuffer);
  const workflow = isPhoto
    ? buildPhotoWorkflow(
        {
          mode: CINEMATIC_MODE_BY_ID.vdnFast,
          prompt: combinedPrompt,
          referenceImageName,
          promptIsComplete: true,
          rawImageWidth: rawDims?.width,
          rawImageHeight: rawDims?.height,
          jobId,
          seed,
          extraReferenceImageNames: extraRefNames,
          extraReferenceRoles: extraRefRoles,
          aspectWidth: aspectDims.width,
          aspectHeight: aspectDims.height,
        },
        photoCount,
      )
    : buildCinematicWorkflow({
    mode,
    prompt: combinedPrompt,
    referenceImageName,
    durationS: breakdown.totalDurationS,
    promptIsComplete: true,
    rawImageWidth: rawDims?.width,
    rawImageHeight: rawDims?.height,
    jobId,
    loraName,
    seed,
    audioName: audioName || undefined,
    referenceMode: referenceMode === "reference",
    extraReferenceImageNames: extraRefNames,
    extraReferenceRoles: extraRefRoles,
    refVideoName: refVideoName || undefined,
    refVideoRole: refVideoPath ? refVideoRole : undefined,
    refVoiceName: refVoiceName || undefined,
    aspectWidth: aspectDims.width,
    aspectHeight: aspectDims.height,
  });

  const spec: DirectorDispatchSpec = {
    storagePath,
    creditsCost,
    workflow,
    referenceImageName,
    pollDeadlineS: isPhoto
      ? photoDirectorPollDeadlineS(photoCount)
      : directorPollDeadlineS(breakdown.totalDurationS, qualityMode, refVideoDurationS),
    ...(isPhoto ? { imageOutputs: true } : {}),
    qwenConceptText: isAdvancedMode ? withConceptNotes(conceptTextInput, promptOpts) : undefined,
    qwenTextInstruction,
    qwenPromptNodeId: isAdvancedMode || qwenTextInstruction ? CINEMATIC_PROMPT_NODE_ID : undefined,
    qwenDurationS: isAdvancedMode ? breakdown.totalDurationS : undefined,
    directorInputsSnapshot: isAdvancedMode || qwenTextInstruction ? directorInputsSnapshot : undefined,
    loraVolumePath,
    loraR2Key,
    loraTriggerWord: loraName ? loraTriggerWord : undefined,
    loraFilename: loraVolumePath || loraR2Key ? loraName : undefined,
    ...(audioStoragePath ? { audioStoragePath, audioName } : {}),
    // 手本の動画・声も同じ「置き場所と input 名」の並びで渡す（起動の直前に読む）。
    ...(extraRefPaths.length || refVideoPath || refVoicePath
      ? {
          extraRefStoragePaths: [...extraRefPaths, ...(refVideoPath ? [refVideoPath] : []), ...(refVoicePath ? [refVoicePath] : [])],
          extraRefNames: [...extraRefNames, ...(refVideoName ? [refVideoName] : []), ...(refVoiceName ? [refVoiceName] : [])],
        }
      : {}),
  };

  // --- 予約: 起動の引数を残して、順番が来ていればその場で起動 ----------------
  // 参照画像は作り直し用に 14 日残す設計なので、予約の間も消えない。
  if (queue) {
    try {
      await saveDispatchSpec("director", jobId, user.id, JSON.parse(JSON.stringify(spec)));
    } catch (err) {
      console.error("[director/generate] save spec failed:", (err as Error).message);
      await supabaseAdmin.from("generation_jobs").delete().eq("id", jobId);
      await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
      return NextResponse.json(
        { error: "予約に失敗しました。しばらくしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 500 },
      );
    }
    const started = await advanceQueue("director", user.id);
    return NextResponse.json({
      jobId,
      reserved: started !== jobId,
      creditsCost,
      remainingCredits: debitedCredits,
      totalDurationS: breakdown.totalDurationS,
    });
  }

  try {
    await dispatchDirectorJob(jobId, user.id, spec, imageBuffer.toString("base64"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[director/generate] dispatch failed:", message);
    await supabaseAdmin
      .from("generation_jobs")
      .update({ status: "failed", error_message: message.slice(0, 2000) })
      .eq("id", jobId);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    // 作り直しのときは元のジョブの参照画像なので消さない（元から作り直せなくなる）。
    if (!baseJobId) deleteStudioUploads([storagePath]);
    return NextResponse.json(
      { error: "生成の開始に失敗しました。", remainingCredits: currentCredits },
      { status: 502 },
    );
  }
  // 参照画像は成功しても消さない（2026-10-01〜）: 「作り直す」で同じ画像を使うため。
  // 置き場（R2 の持ち込み・Volume の studio_uploads）はどちらも 14 日で自動削除される。

  return NextResponse.json({
    jobId,
    reserved: false,
    creditsCost,
    remainingCredits: debitedCredits,
    totalDurationS: breakdown.totalDurationS,
  });
}

/** トリガーワード（カンマ・読点区切り）のうち、指示文に入っていないものを先頭に足す。大文字小文字は区別しない。 */
function withLoraTriggerWords(prompt: string, triggerWord: string): string {
  const lower = prompt.toLowerCase();
  const missing = triggerWord
    .split(/[,、]/)
    .map((t) => t.trim())
    .filter((t) => t && !lower.includes(t.toLowerCase()));
  return missing.length ? `${missing.join(", ")}, ${prompt}` : prompt;
}
