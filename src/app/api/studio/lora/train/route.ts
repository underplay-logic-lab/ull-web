import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { spawnLoraTrainingJob } from "@/lib/modalLoraTrain";
import {
  BLOCKED_LORA_MODEL_MESSAGE,
  LORA_BASE_ARCHITECTURES,
  LORA_PRESET_IDS,
  isBlockedLoraModel,
  type LoraBaseArchitecture,
} from "@/lib/loraModels";

// Only debits credits, inserts a generation_jobs row and fires a fast
// dispatch at Modal (train_lora_dispatch) — the multi-minute training runs
// entirely inside a spawned Modal container. maxDuration only needs to
// cover that dispatch + a couple of quick DB writes.
export const maxDuration = 30;

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

  const captions = Array.isArray(body.captions)
    ? (body.captions as unknown[]).map((c) => (typeof c === "string" ? c : "")).slice(0, MAX_IMAGES)
    : [];
  const triggerWord = typeof body.trigger_word === "string" ? body.trigger_word.trim().slice(0, 60) : "";

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
  const { data: jobRow, error: jobInsertError } = await supabaseAdmin
    .from("generation_jobs")
    .insert({
      user_id: user.id,
      status: "queued",
      workflow_type: "lora_training",
      inputs: {
        target_model: targetModel,
        custom_model_id: targetModel === "custom" ? customModelId : undefined,
        base_architecture: targetModel === "custom" ? baseArchitecture : undefined,
        output_lora_name: outputLoraName,
        num_images: storagePaths.length,
        trigger_word: triggerWord || null,
        training_config: { ...trainingConfig, custom_yaml_override: hasOverride ? "(custom)" : undefined },
      },
      credits_cost: LORA_TRAINING_COST,
      progress_percent: 0,
      progress_message: "queued",
    })
    .select("id")
    .single();

  if (jobInsertError || !jobRow) {
    console.error("[studio/lora/train] failed to create job row:", jobInsertError?.message);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      { error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits },
      { status: 500 },
    );
  }
  const jobId = jobRow.id as string;

  // --- dispatch to Modal ------------------------------------------------
  try {
    await spawnLoraTrainingJob({
      jobId,
      userId: user.id,
      creditsCost: LORA_TRAINING_COST,
      storagePaths,
      captions,
      targetModel,
      customModelId: targetModel === "custom" ? customModelId : undefined,
      baseArchitecture: targetModel === "custom" ? (baseArchitecture as LoraBaseArchitecture) : undefined,
      trainingConfig,
      outputLoraName,
      triggerWord: triggerWord || undefined,
    });

    return NextResponse.json({
      success: true,
      jobId,
      remainingCredits: debitedCredits,
    });
  } catch (err) {
    console.error("[studio/lora/train] failed to dispatch job:", err);
    await supabaseAdmin
      .from("generation_jobs")
      .update({
        status: "failed",
        error_message: "学習ジョブの起動に失敗しました。",
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);

    return NextResponse.json(
      {
        error: "LoRA学習の開始に失敗しました。しばらくしてから再度お試しください。",
        remainingCredits: currentCredits,
      },
      { status: 502 },
    );
  }
}
