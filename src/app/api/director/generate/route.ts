import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { downloadStudioUpload, deleteStudioUploads } from "@/lib/studioUploads.server";
import { readImageDimensions } from "@/lib/imageDimensions";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import {
  DIRECTOR_MAX_TOTAL_SECONDS,
  DIRECTOR_MUSIC_MAX_LENGTH,
  DIRECTOR_SECONDS_PER_SCENE,
  directorCostBreakdown,
  directorCostBreakdownForDuration,
  directorCreditsWorstCase,
  directorPollDeadlineS,
  directorPriorityParallelSurcharge,
  directorQwenScriptSurcharge,
  isDirectorQualityMode,
  validateDirectorScenes,
  type DirectorQualityMode,
  type DirectorScene,
} from "@/lib/directorPricing";
import {
  DirectorPromptError,
  expandDirectorScenes,
  looksJapanese,
  translateDirectorPromptToJapanese,
  translateJapanesePromptToEnglish,
} from "@/lib/directorPrompt";
import { buildCinematicWorkflow, CINEMATIC_PROMPT_NODE_ID } from "@/lib/cinematicWorkflow";
import { assertOwnedDirectorLoraVolumePath } from "@/lib/directorLoraUpload.server";
import { CINEMATIC_MODE_BY_ID } from "@/lib/cinematicPricing";
import { spawnDirectorJob } from "@/lib/modalDirector";
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

  const storagePath = typeof body.storagePath === "string" ? body.storagePath : "";
  if (!storagePath) {
    return NextResponse.json({ error: "参照画像をアップロードしてください。" }, { status: 400 });
  }

  // 画質モード（2026-09-14、VDN-H3導入に伴い旧speed固定を廃止）。
  // fast=8step蒸留(無音・低コスト)、quality=50step非蒸留(音声あり)。
  const qualityMode: DirectorQualityMode = isDirectorQualityMode(body.quality) ? body.quality : "fast";

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
  if (isAdvancedMode) {
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
    scenes = validated.scenes;

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
  if (loraIdRaw && loraUploadVolumePathRaw) {
    return NextResponse.json({ error: "LoRAの指定が重複しています。" }, { status: 400 });
  }

  let loraName: string | undefined;
  let loraVolumePath: string | undefined;
  if (loraIdRaw) {
    if (!/^[A-Za-z0-9_-]+$/.test(loraIdRaw)) {
      return NextResponse.json({ error: "LoRAの指定が不正です。" }, { status: 400 });
    }
    // CLAUDE.md §3 の14日自動パージ（modal_retention_purge.py、created_at
    // 起点）— DB行がパージより先に消えるとは限らないため、実体ファイルが
    // 既に消えていそうな古い行は明示的に弾く（/api/director/loras と同じ
    // cutoff、実機確認済み — 詳細はそちらのコメント参照）。
    const retentionCutoffIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: loraJob } = await supabaseAdmin
      .from("generation_jobs")
      .select("id")
      .eq("user_id", user.id)
      .eq("workflow_type", "lora_training")
      .eq("status", "completed")
      .eq("inputs->>target_model", "minimax_h3")
      .eq("inputs->>output_lora_name", loraIdRaw)
      .gte("created_at", retentionCutoffIso)
      .limit(1)
      .maybeSingle();
    if (!loraJob) {
      return NextResponse.json({ error: "指定されたLoRAが見つかりません。" }, { status: 400 });
    }
    loraName = `${loraIdRaw}.safetensors`;
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
  const breakdown = isPromptMode || isAdvancedMode
    ? directorCostBreakdownForDuration({
        totalDurationS: Math.min(DIRECTOR_MAX_TOTAL_SECONDS, Math.max(1, rawDurationS)),
        mode: qualityMode,
        knobs,
      })
    : directorCostBreakdown({ scenes, mode: qualityMode, knobs });
  // Advanced（Qwen台本生成）は動画本体とは別のGPUコンテナを1回起動するので
  // その分を上乗せする（directorPricing.ts参照）。
  const baseCreditsCost =
    (breakdown.credits || directorCreditsWorstCase(knobs)) + (isAdvancedMode ? directorQwenScriptSurcharge(knobs) : 0);
  // 「実行中でも並列で今すぐ実行」を選んだ場合の追加コールドスタート分
  // （順番待ち=無料の既定に対するオプトインの上乗せ。CLAUDE.md §6参照）。
  const priority = body.priority === true || body.priority === "true";
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
  let combinedPrompt: string;
  if (isAdvancedMode) {
    combinedPrompt = conceptTextInput;
  } else if (isPromptMode) {
    if (looksJapanese(rawPromptInput)) {
      try {
        combinedPrompt = await translateJapanesePromptToEnglish(rawPromptInput);
      } catch (err) {
        const e = err as DirectorPromptError;
        const status = e.reason === "quota" ? 429 : e.reason === "busy" ? 503 : e.reason === "not_configured" ? 501 : 502;
        return NextResponse.json({ error: e.message }, { status });
      }
    } else {
      combinedPrompt = rawPromptInput;
    }
  } else {
    try {
      combinedPrompt = await expandDirectorScenes(scenes, musicDirectionInput || undefined);
    } catch (err) {
      const e = err as DirectorPromptError;
      const status = e.reason === "quota" ? 429 : e.reason === "busy" ? 503 : e.reason === "not_configured" ? 501 : 502;
      return NextResponse.json({ error: e.message }, { status });
    }
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
  const combinedPromptJa = isAdvancedMode ? null : await translateDirectorPromptToJapanese(combinedPrompt);

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
    lora_source: loraIdRaw ? "trained" : loraUploadVolumePathRaw ? "upload" : null,
  };
  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("generation_jobs")
    .insert({
      user_id: user.id,
      status: "queued",
      workflow_type: "director",
      inputs: directorInputsSnapshot,
      credits_cost: creditsCost,
      metadata: {
        scene_count: scenes.length,
        total_duration_s: breakdown.totalDurationS,
        prompt_mode: isPromptMode,
        advanced_mode: isAdvancedMode,
        quality_mode: qualityMode,
        priority,
        lora_name: loraName || null,
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
  const workflow = buildCinematicWorkflow({
    mode,
    prompt: combinedPrompt,
    referenceImageName,
    durationS: breakdown.totalDurationS,
    promptIsComplete: true,
    rawImageWidth: rawDims?.width,
    rawImageHeight: rawDims?.height,
    jobId,
    loraName,
  });

  try {
    await spawnDirectorJob({
      jobId,
      userId: user.id,
      creditsCost,
      workflow,
      referenceImageName,
      referenceImageB64: imageBuffer.toString("base64"),
      pollDeadlineS: directorPollDeadlineS(breakdown.totalDurationS, qualityMode),
      qwenConceptText: isAdvancedMode ? conceptTextInput : undefined,
      qwenPromptNodeId: isAdvancedMode ? CINEMATIC_PROMPT_NODE_ID : undefined,
      qwenDurationS: isAdvancedMode ? breakdown.totalDurationS : undefined,
      directorInputsSnapshot: isAdvancedMode ? directorInputsSnapshot : undefined,
      loraVolumePath,
      loraFilename: loraVolumePath ? loraName : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[director/generate] dispatch failed:", message);
    await supabaseAdmin
      .from("generation_jobs")
      .update({ status: "failed", error_message: message.slice(0, 2000) })
      .eq("id", jobId);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      { error: "生成の開始に失敗しました。", remainingCredits: currentCredits },
      { status: 502 },
    );
  } finally {
    deleteStudioUploads([storagePath]);
  }

  return NextResponse.json({
    jobId,
    creditsCost,
    remainingCredits: debitedCredits,
    totalDurationS: breakdown.totalDurationS,
  });
}
