import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { spawnLoraTrainingJob, buildLoraDispatchPayload } from "@/lib/modalLoraTrain";
import {
  BLOCKED_LORA_MODEL_MESSAGE,
  DEFAULT_LORA_RESOLUTION,
  LORA_BASE_ARCHITECTURES,
  LORA_PRESET_IDS,
  LORA_RESOLUTIONS,
  isBlockedLoraModel,
  type LoraBaseArchitecture,
} from "@/lib/loraModels";

// Only debits credits, inserts a generation_jobs row and fires a fast
// dispatch at Modal (train_lora_dispatch) — the multi-minute training runs
// entirely inside a spawned Modal container. maxDuration covers the DB
// writes + the dispatch (up to a ~55s cold start on the Modal side).
export const maxDuration = 60;

// Flat price for one LoRA training run.
const LORA_TRAINING_COST = 150;

const LORA_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
// HF repo id ("owner/name") or an absolute/volume-relative path.
const CUSTOM_MODEL_ID_RE = /^[A-Za-z0-9._\-/]{2,200}$/;
const MAX_IMAGES = 200;
const MIN_IMAGES = 1;

function sanitizeTrainingConfig(raw: unknown): Record<string, unknown> {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  const rank = num(src.rank);
  const alpha = num(src.alpha);
  const lr = num(src.learning_rate);
  const steps = num(src.steps);
  if (rank !== undefined) out.rank = Math.min(256, Math.max(1, Math.round(rank)));
  if (alpha !== undefined) out.alpha = Math.min(256, Math.max(1, Math.round(alpha)));
  if (lr !== undefined) out.learning_rate = Math.min(1e-2, Math.max(1e-6, lr));
  if (steps !== undefined) out.steps = Math.min(6000, Math.max(200, Math.round(steps)));
  if (typeof src.optimizer === "string" && src.optimizer.trim()) {
    out.optimizer = src.optimizer.trim().slice(0, 40);
  }
  // Fully-manual mode: pass the raw YAML / dict straight through.
  if (typeof src.custom_yaml_override === "string" && src.custom_yaml_override.trim()) {
    out.custom_yaml_override = src.custom_yaml_override;
  } else if (src.custom_yaml_override && typeof src.custom_yaml_override === "object") {
    out.custom_yaml_override = src.custom_yaml_override;
  }
  return out;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    return await handlePost(request);
  } catch (err) {
    // Never let an unexpected exception surface as an opaque framework 500 —
    // echo the message + stack so the client (and the console) can see what
    // actually broke.
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[studio/lora/train] unhandled error:", message, stack);
    return NextResponse.json(
      {
        error: "ジョブの作成に失敗しました。",
        reason: message,
        details: String(err),
        stack,
      },
      { status: 500 },
    );
  }
}

async function handlePost(request: Request): Promise<NextResponse> {
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

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const outputLoraName = typeof body.output_lora_name === "string" ? body.output_lora_name.trim() : "";
  if (!LORA_NAME_RE.test(outputLoraName)) {
    return NextResponse.json(
      { error: "LoRA名は英数字・ハイフン・アンダースコア・ドットのみ（64文字以内）で入力してください。" },
      { status: 400 },
    );
  }

  const trainingConfig = sanitizeTrainingConfig(body.training_config);
  const hasOverride = trainingConfig.custom_yaml_override !== undefined;

  const targetModel = typeof body.target_model === "string" ? body.target_model.trim() : "minimax_h3";
  const customModelId =
    typeof body.custom_model_id === "string" ? body.custom_model_id.trim() : "";
  const baseArchitecture =
    typeof body.base_architecture === "string" ? body.base_architecture.trim() : "";

  // FLUX.1 [dev] is blocked outright (non-commercial licence) — check both
  // the preset id and any custom model id / path.
  if (isBlockedLoraModel(targetModel) || isBlockedLoraModel(customModelId)) {
    return NextResponse.json({ error: BLOCKED_LORA_MODEL_MESSAGE }, { status: 400 });
  }

  if (targetModel === "custom") {
    if (!CUSTOM_MODEL_ID_RE.test(customModelId)) {
      return NextResponse.json(
        { error: "カスタムモデルID（HuggingFace Repo ID または Volume パス）が不正です。" },
        { status: 400 },
      );
    }
    if (!LORA_BASE_ARCHITECTURES.includes(baseArchitecture as LoraBaseArchitecture)) {
      return NextResponse.json(
        { error: `base_architecture は ${LORA_BASE_ARCHITECTURES.join(" / ")} のいずれかを指定してください。` },
        { status: 400 },
      );
    }
  } else if (!hasOverride && !LORA_PRESET_IDS.has(targetModel)) {
    return NextResponse.json(
      { error: "指定されたベースモデルは利用できません。プリセットまたはカスタム指定をご利用ください。" },
      { status: 400 },
    );
  }

  // The browser uploads the images straight to the lora_datasets bucket and
  // sends only their object paths here — the request body stays a few KB.
  const rawPaths = Array.isArray(body.storage_paths) ? (body.storage_paths as unknown[]) : [];
  if (rawPaths.length < MIN_IMAGES) {
    return NextResponse.json({ error: "学習用画像を1枚以上アップロードしてください。" }, { status: 400 });
  }
  if (rawPaths.length > MAX_IMAGES) {
    return NextResponse.json({ error: `学習用画像は最大${MAX_IMAGES}枚です。` }, { status: 400 });
  }

  // Every path must be an image the requester owns: "<user.id>/<dataset>/<file>".
  const storagePaths: string[] = [];
  for (const p of rawPaths) {
    if (typeof p !== "string" || !p.startsWith(`${user.id}/`) || p.includes("..") || !/\.(png|jpe?g|webp)$/i.test(p)) {
      return NextResponse.json({ error: "アップロード済み画像パスが不正です。" }, { status: 400 });
    }
    storagePaths.push(p);
  }
  // "<user.id>/<datasetId>/<file>" — the 2nd segment keys the worker's
  // persisted-caption cache on the Volume.
  const datasetId = storagePaths[0].split("/")[1] ?? "";

  const captions = Array.isArray(body.captions)
    ? (body.captions as unknown[]).map((c) => (typeof c === "string" ? c : "")).slice(0, MAX_IMAGES)
    : [];
  const triggerWord = typeof body.trigger_word === "string" ? body.trigger_word.trim().slice(0, 60) : "";
  const resolution = (LORA_RESOLUTIONS as readonly number[]).includes(Number(body.resolution))
    ? Number(body.resolution)
    : DEFAULT_LORA_RESOLUTION;

  // --- credits ------------------------------------------------------------
  const { data: profile, error: profileError } = await getOrCreateProfile(
    user.id,
    "credits, credits_expire_at",
  );
  if (profileError) {
    console.error("[studio/lora/train] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }

  const creditsExpireAt = profile?.credits_expire_at as string | null | undefined;
  const rawCredits = profile?.credits as number | null | undefined;
  const isExpired = creditsExpireAt ? new Date(creditsExpireAt).getTime() < Date.now() : false;
  const currentCredits = isExpired ? 0 : (rawCredits ?? 0);

  if (currentCredits < LORA_TRAINING_COST) {
    return NextResponse.json(
      {
        error: isExpired
          ? "クレジットの有効期限が切れています。チャージしてから再度お試しください。"
          : "クレジットが不足しています。チャージしてから再度お試しください。",
        remainingCredits: currentCredits,
        requiredCredits: LORA_TRAINING_COST,
      },
      { status: 402 },
    );
  }

  const debitedCredits = currentCredits - LORA_TRAINING_COST;
  const { error: debitError } = await supabaseAdmin
    .from("profiles")
    .update({ credits: debitedCredits })
    .eq("id", user.id);
  if (debitError) {
    console.error("[studio/lora/train] failed to debit credits:", debitError.message);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  // --- job row -----------------------------------------------------------
  const spawnParams = {
    jobId: "", // filled after insert
    userId: user.id,
    creditsCost: LORA_TRAINING_COST,
    storagePaths,
    datasetId,
    captions,
    targetModel,
    customModelId: targetModel === "custom" ? customModelId : undefined,
    baseArchitecture: targetModel === "custom" ? (baseArchitecture as LoraBaseArchitecture) : undefined,
    trainingConfig,
    resolution,
    outputLoraName,
    triggerWord: triggerWord || undefined,
  };
  // The full Modal payload is stashed on the job so a pending-timeout retry
  // can re-dispatch it verbatim (no re-debit).
  const dispatchPayload = buildLoraDispatchPayload(spawnParams);

  const jobInputs = {
    target_model: targetModel,
    custom_model_id: targetModel === "custom" ? customModelId : undefined,
    base_architecture: targetModel === "custom" ? baseArchitecture : undefined,
    output_lora_name: outputLoraName,
    dataset_id: datasetId,
    num_images: storagePaths.length,
    resolution,
    trigger_word: triggerWord || null,
    training_config: { ...trainingConfig, custom_yaml_override: hasOverride ? "(custom)" : undefined },
    dispatch: dispatchPayload,
  };

  const fullRow = {
    user_id: user.id,
    status: "queued",
    workflow_type: "lora_training",
    inputs: jobInputs,
    credits_cost: LORA_TRAINING_COST,
    progress_percent: 0,
    progress_message: "queued",
    retry_count: 0,
  };

  let jobRow: { id: string } | null = null;
  let jobInsertError: { message?: string; code?: string; details?: string; hint?: string } | null = null;

  {
    const res = await supabaseAdmin.from("generation_jobs").insert(fullRow).select("id").single();
    jobRow = res.data as { id: string } | null;
    jobInsertError = res.error;
    // The progress_percent / progress_message columns arrive with migration
    // 20260846000000 — if this deploy is ahead of the DB, retry without them
    // so a training run still starts (progress just won't update until the
    // migration lands).
    if (jobInsertError && /progress_percent|progress_message|retry_count|column .* does not exist|schema cache/i.test(
      `${jobInsertError.message ?? ""} ${jobInsertError.details ?? ""}`,
    )) {
      console.error("[studio/lora/train] job insert retry without progress_*/retry_count columns:", jobInsertError);
      const retry = await supabaseAdmin
        .from("generation_jobs")
        .insert({
          user_id: user.id,
          status: "queued",
          workflow_type: "lora_training",
          inputs: jobInputs,
          credits_cost: LORA_TRAINING_COST,
        })
        .select("id")
        .single();
      jobRow = retry.data as { id: string } | null;
      jobInsertError = retry.error;
    }
  }

  if (jobInsertError || !jobRow) {
    const reason = jobInsertError?.message ?? "unknown insert error";
    console.error("[studio/lora/train] failed to create job row:", {
      message: jobInsertError?.message,
      code: jobInsertError?.code,
      details: jobInsertError?.details,
      hint: jobInsertError?.hint,
    });
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      {
        error: "ジョブの作成に失敗しました。",
        reason,
        details: JSON.stringify(jobInsertError),
        remainingCredits: currentCredits,
      },
      { status: 500 },
    );
  }
  const jobId = jobRow.id;

  // --- dispatch to Modal ------------------------------------------------
  try {
    const { modalCallId } = await spawnLoraTrainingJob({ ...spawnParams, jobId });

    // The Modal FunctionCall id (fc-...) is what the pending-timeout path
    // must physically .cancel(). Persist it immediately, in BOTH the column
    // and inside inputs jsonb, and verify the write landed.
    if (!modalCallId) {
      console.error(`[studio/lora/train] job ${jobId}: Modal returned no modal_call_id — auto-failover cancel will not work`);
    } else {
      const mergedInputs = { ...jobInputs, modal_call_id: modalCallId };
      const { error: upErr } = await supabaseAdmin
        .from("generation_jobs")
        .update({ modal_call_id: modalCallId, inputs: mergedInputs })
        .eq("id", jobId);
      if (upErr) {
        console.warn(
          `[studio/lora/train] job ${jobId}: modal_call_id column update failed (${upErr.message}); falling back to inputs jsonb`,
        );
        const { error: inputsErr } = await supabaseAdmin
          .from("generation_jobs")
          .update({ inputs: mergedInputs })
          .eq("id", jobId);
        if (inputsErr) {
          console.error(`[studio/lora/train] job ${jobId}: failed to persist modal_call_id anywhere: ${inputsErr.message}`);
        }
      }
      console.log(`[studio/lora/train] job ${jobId} <- modal_call_id ${modalCallId}`);
    }

    return NextResponse.json({
      success: true,
      jobId,
      modalCallId: modalCallId ?? null,
      remainingCredits: debitedCredits,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[studio/lora/train] failed to dispatch job:", message, stack);
    await supabaseAdmin
      .from("generation_jobs")
      .update({
        status: "failed",
        error_message: `学習ジョブの起動に失敗しました: ${message}`.slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);

    return NextResponse.json(
      {
        error: "ジョブの作成に失敗しました。",
        reason: message,
        details: String(err),
        stack,
        remainingCredits: currentCredits,
      },
      { status: 502 },
    );
  }
}
