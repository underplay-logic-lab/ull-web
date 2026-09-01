import { NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { spawnLoraTrainingJob, buildLoraDispatchPayload } from "@/lib/modalLoraTrain";
import { DEFAULT_LORA_STEPS } from "@/lib/loraCredits";
import {
  guiLoraPricingConfig,
  loraPriceBreakdown,
  LORA_CREDIT_WORST_CASE,
} from "@/lib/loraPricing";
import { validateLoraYaml, loraYamlIdentity } from "@/lib/loraYaml";
import { getAdminEmails } from "@/lib/adminAuth";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { geminiApiKey, runGeminiText } from "@/lib/geminiText";
import {
  buildCaptionFallbackPrompt,
  buildCaptionMetaPrompt,
  captionSpecHasInput,
  normalizeCaptionSpec,
  tidyCaptionPrompt,
} from "@/lib/loraCaptionSpec";
import {
  BLOCKED_LORA_MODEL_MESSAGE,
  DEFAULT_LORA_RESOLUTION,
  LORA_BASE_ARCHITECTURES,
  LORA_PRESET_IDS,
  LORA_RESOLUTIONS,
  isBlockedLoraModel,
  loraPresetById,
  type LoraBaseArchitecture,
} from "@/lib/loraModels";

// Auto / semi modes don't expose a Rank control — the worker builds the
// ai-toolkit config with this default (see DEFAULT_TRAINING_CONFIG there).
const DEFAULT_LORA_RANK = 32;

// Only debits credits, inserts a generation_jobs row and fires the dispatch
// at Modal (train_lora_dispatch). For a single-file / Volume base model the
// spawn ack lands in seconds; for an uncached HF-repo model train_lora_dispatch
// runs the CPU snapshot_download synchronously first, which can take a few
// minutes. maxDuration matches SPAWN_TIMEOUT_MS (300_000ms) so Vercel never
// 504s that wait; modal_call_id persistence still runs in `after()`, and any
// pre-spawn Gemini caption-prompt synthesis is hard-capped (see below).
export const maxDuration = 300;

// Hard cap on the optional pre-spawn Gemini caption-prompt synthesis so it
// can never push the request toward a Vercel function timeout — on timeout
// the deterministic fallback prompt is used instead.
const CAPTION_SYNTH_TIMEOUT_MS = 5000;

// Price is multi-dimensional (model / resolution / batch / rank / steps) —
// see src/lib/loraPricing.ts. Always recomputed server-side from the real
// parameters, never trusted from the client.

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

  const bodyLoraName = typeof body.output_lora_name === "string" ? body.output_lora_name.trim() : "";

  const trainingConfig = sanitizeTrainingConfig(body.training_config);
  const hasOverride = trainingConfig.custom_yaml_override !== undefined;

  // Raw-YAML (full-custom job spec) is an admin / bespoke-contract feature —
  // the Studio UI only exposes it to admins (see YamlVipLockCard). Enforce it
  // here too so a hand-rolled request from a normal account can't smuggle a
  // custom_yaml_override in. Checked before any credit debit or Modal spawn.
  if (hasOverride) {
    const email = user.email?.toLowerCase() ?? "";
    if (!email || !getAdminEmails().includes(email)) {
      console.warn(`[studio/lora/train] non-admin ${user.id} attempted custom_yaml_override — rejected`);
      return NextResponse.json(
        {
          error:
            "生YAML（フルカスタム学習ジョブ設定）は特注受託向けの機能です。個別相談からお問い合わせください。",
        },
        { status: 403 },
      );
    }
  }

  // Second line of defence (the UI already blocks submit on syntax + schema
  // errors): reject a bad raw YAML here BEFORE debiting any credit or spinning
  // up a Modal container. Keep the parsed object — the price is computed from
  // it below.
  let parsedOverride: unknown = null;
  if (hasOverride && typeof trainingConfig.custom_yaml_override === "string") {
    const check = validateLoraYaml(trainingConfig.custom_yaml_override);
    if (!check.ok) {
      const isSchema = Array.isArray(check.errors) && check.errors.length > 0;
      const where =
        check.line != null
          ? `（行 ${check.line}${check.column != null ? `, 列 ${check.column}` : ""}）`
          : "";
      return NextResponse.json(
        {
          error: isSchema
            ? `custom_yaml の設定エラー: ${check.message}`
            : `custom_yaml の構文エラー${where}: ${check.message}`,
          yamlError: { message: check.message, line: check.line, column: check.column, errors: check.errors },
        },
        { status: 400 },
      );
    }
    parsedOverride = check.data;
  } else if (hasOverride && trainingConfig.custom_yaml_override && typeof trainingConfig.custom_yaml_override === "object") {
    parsedOverride = trainingConfig.custom_yaml_override;
  }

  // Raw-YAML mode: the YAML's own config.name / process[0].trigger_word are
  // authoritative (the UI disables the form fields, and the worker adopts the
  // same values). For a GUI-mode job the form's LoRA name / trigger stand.
  const yamlId = hasOverride && parsedOverride ? loraYamlIdentity(parsedOverride) : null;
  const outputLoraName = yamlId?.name || bodyLoraName;
  if (!LORA_NAME_RE.test(outputLoraName)) {
    return NextResponse.json(
      {
        error: hasOverride
          ? "生YAML の config.name は英数字・ハイフン・アンダースコア・ドットのみ（64文字以内）で指定してください。"
          : "LoRA名は英数字・ハイフン・アンダースコア・ドットのみ（64文字以内）で入力してください。",
      },
      { status: 400 },
    );
  }

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
  // User brought their own captions (semi-auto edits or a .txt set) — the
  // worker then skips loading the 27B caption VLM entirely.
  const customCaptions = Array.isArray(body.custom_captions)
    ? (body.custom_captions as unknown[]).map((c) => (typeof c === "string" ? c : "")).slice(0, MAX_IMAGES)
    : undefined;
  const skipCaptioning =
    body.skip_captioning === true || (customCaptions?.some((c) => c.trim().length > 0) ?? false);
  // The user's own auto-caption VLM instruction. Normally the browser has
  // already run the category-aware Gemini synthesis (see below) and sends the
  // finished English instruction here; free-text edits also land here.
  // Bounded so a huge paste can't bloat the job payload.
  let captionPrompt =
    typeof body.caption_prompt === "string" ? body.caption_prompt.trim().slice(0, 4000) : "";
  // The structured category spec (人物 / 画風 / 物質 / 風景 ＋ 固定/変化させたい
  // 特徴の日本語). Used to (re)build caption_prompt server-side when the client
  // didn't send a generated one — the authoritative fallback for the request.
  const captionSpec = normalizeCaptionSpec(body.caption_spec);
  // Raw-YAML mode: the YAML's process[0].trigger_word wins over the (disabled)
  // form field.
  const triggerWord =
    (yamlId?.triggerWord || (typeof body.trigger_word === "string" ? body.trigger_word.trim() : "")).slice(0, 60);

  // LoRA-type-aware caption prompt: if the browser sent a spec but no
  // generated instruction (Gemini was down there, or the request was
  // hand-crafted), synthesise it here — Gemini first, deterministic fallback
  // if that also fails. skip entirely when the user brought their own
  // captions (the VLM never runs) or already sent an instruction.
  let captionPromptSource: "client" | "gemini" | "fallback" | "none" =
    captionPrompt ? "client" : "none";
  if (!captionPrompt && !skipCaptioning && captionSpec && captionSpecHasInput(captionSpec)) {
    const key = geminiApiKey();
    if (key) {
      try {
        const genAI = new GoogleGenerativeAI(key);
        const raw = await Promise.race([
          runGeminiText(genAI, buildCaptionMetaPrompt(captionSpec, triggerWord), false),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("caption-prompt synth timeout")), CAPTION_SYNTH_TIMEOUT_MS),
          ),
        ]);
        captionPrompt = tidyCaptionPrompt(raw).slice(0, 4000);
        if (captionPrompt) captionPromptSource = "gemini";
      } catch (err) {
        console.warn(
          "[studio/lora/train] caption-prompt Gemini synthesis skipped:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (!captionPrompt) {
      captionPrompt = buildCaptionFallbackPrompt(captionSpec, triggerWord).slice(0, 4000);
      captionPromptSource = "fallback";
    }
  }
  const resolution = (LORA_RESOLUTIONS as readonly number[]).includes(Number(body.resolution))
    ? Number(body.resolution)
    : DEFAULT_LORA_RESOLUTION;

  // --- authoritative price -----------------------------------------------
  // Multi-dimensional: ceil(0.1 * modelMult * resMult * batchMult * rankMult
  // * steps) — computed server-side from the request's real parameters so a
  // tampered client body can't under-pay (see src/lib/loraPricing.ts).
  //  - raw-YAML expert: price the parsed ai-toolkit config directly.
  //  - GUI expert (slider) / auto / semi: synthesise the equivalent config.
  //  - a YAML that somehow reached here unparseable: the worst-case ceiling.
  const pricedPreset = targetModel === "custom" ? undefined : loraPresetById(targetModel);
  const pricedArch = targetModel === "custom" ? baseArchitecture : (pricedPreset?.arch ?? "");
  const pricedConfig: unknown = hasOverride
    ? parsedOverride
    : guiLoraPricingConfig({
        arch: pricedArch,
        resolution,
        linearRank:
          typeof trainingConfig.rank === "number" ? trainingConfig.rank : DEFAULT_LORA_RANK,
        steps: typeof trainingConfig.steps === "number" ? trainingConfig.steps : DEFAULT_LORA_STEPS,
      });
  const priceBreakdown = pricedConfig
    ? loraPriceBreakdown(pricedConfig, {
        archFallback: pricedArch,
        // Raw-YAML (hasOverride) prices purely off the YAML's own arch — a
        // preset's per-model override only applies to the GUI-synthesised path.
        modelMultOverride: hasOverride ? undefined : pricedPreset?.pricingModelMult,
      })
    : null;
  // A raw YAML that reached here unparseable (UI blocks it, so defence only),
  // or one with no positive step count -> the worst-case ceiling.
  let requiredCredits =
    priceBreakdown && priceBreakdown.credits > 0
      ? priceBreakdown.credits
      : LORA_CREDIT_WORST_CASE;
  requiredCredits = Math.max(1, Math.min(LORA_CREDIT_WORST_CASE, Math.ceil(requiredCredits)));

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

  if (currentCredits < requiredCredits) {
    return NextResponse.json(
      {
        error: isExpired
          ? "クレジットの有効期限が切れています。チャージしてから再度お試しください。"
          : "クレジットが不足しています。チャージしてから再度お試しください。",
        remainingCredits: currentCredits,
        requiredCredits,
      },
      { status: 402 },
    );
  }

  const debitedCredits = currentCredits - requiredCredits;
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
    creditsCost: requiredCredits,
    storagePaths,
    datasetId,
    captions,
    customCaptions,
    skipCaptioning,
    captionPrompt: captionPrompt || undefined,
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
    training_config: {
      ...trainingConfig,
      custom_yaml_override: hasOverride ? "(custom)" : undefined,
      // the exact parameters + multipliers the charge was computed from —
      // recorded so a disputed debit is auditable.
      priced_steps: priceBreakdown?.steps ?? null,
      price_breakdown: priceBreakdown,
    },
    // How the auto-caption instruction was produced, for support / auditing.
    caption_prompt_meta: captionSpec
      ? {
          category: captionSpec.category,
          source: captionPromptSource,
          has_fixed: captionSpec.fixed.length > 0,
          has_varying: captionSpec.varying.length > 0,
        }
      : { source: captionPromptSource },
    dispatch: dispatchPayload,
  };

  const fullRow = {
    user_id: user.id,
    status: "queued",
    workflow_type: "lora_training",
    inputs: jobInputs,
    credits_cost: requiredCredits,
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
          credits_cost: requiredCredits,
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
  // Spawn is a warm, sub-second call (train_lora_dispatch keeps a container
  // hot). We await ONLY the spawn ack, then return 200 immediately — the
  // modal_call_id persistence runs in after() so nothing blocks the response.
  let modalCallId: string | null = null;
  try {
    ({ modalCallId } = await spawnLoraTrainingJob({ ...spawnParams, jobId }));
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

  // Persist the Modal FunctionCall id (fc-...) — needed only later, by the
  // pending-timeout auto-failover, so it happens after the response. If
  // after() is cut short before this lands, the failover simply can't
  // physically cancel (it still refunds + closes a stuck job).
  after(async () => {
    if (!modalCallId) {
      console.error(`[studio/lora/train] job ${jobId}: Modal returned no modal_call_id`);
      return;
    }
    const mergedInputs = { ...jobInputs, modal_call_id: modalCallId };
    const { error: upErr } = await supabaseAdmin
      .from("generation_jobs")
      .update({ modal_call_id: modalCallId, inputs: mergedInputs })
      .eq("id", jobId);
    if (upErr) {
      await supabaseAdmin.from("generation_jobs").update({ inputs: mergedInputs }).eq("id", jobId);
    }
    console.log(`[studio/lora/train] job ${jobId} <- modal_call_id ${modalCallId}`);
  });

  return NextResponse.json({
    success: true,
    jobId,
    modalCallId: modalCallId ?? null,
    remainingCredits: debitedCredits,
  });
}
