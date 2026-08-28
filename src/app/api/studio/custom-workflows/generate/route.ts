import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import {
  calculateTotalWorkflowCredits,
  isTierLocked,
  isValidWorkflowGpuTier,
  SYSTEM_FIELD_GPU_TIER,
  type WorkflowGpuTier,
  type WorkflowInputField,
  type WorkflowSection,
} from "@/lib/customWorkflows";
import { patchCustomWorkflow, type CustomWorkflowFieldValue } from "@/lib/customWorkflowExecution";
import { runCustomWorkflowOnModal } from "@/lib/modalCustomWorkflow";
import type { GpuTier } from "@/lib/gpuTier";
import { logGenerationActivity } from "@/lib/generationLogger";
import { startActiveJob, endActiveJob } from "@/lib/activeGenerationJobs";
import { autoExtendGpuWarmOnSuccess } from "@/lib/gpuWarmAutoExtend";
import { getAdminEmails } from "@/lib/adminAuth";

// Same cold-start budget as /api/wan-animate/generate — see modalCustomWorkflow.ts.
export const maxDuration = 300;

// Defensive boundary — this text flows directly into a ComfyUI node input
// (e.g. a CLIPTextEncode prompt) on an external system.
const MAX_TEXT_FIELD_LENGTH = 4000;

function inferOutputKind(filename: string): "image" | "video" {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return ext === "mp4" || ext === "webm" || ext === "mov" ? "video" : "image";
}

function fieldFormKey(fieldId: string): string {
  return `field:${fieldId}`;
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
  // Admin-triggered generations are also persisted into the Modal Volume
  // (outputs/admin/) so staff can review/download them later from the
  // Storage tab.
  const isAdmin = getAdminEmails().includes((user.email ?? "").toLowerCase());

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const slug = formData.get("slug");
  if (typeof slug !== "string" || !slug.trim()) {
    return NextResponse.json({ error: "ワークフローが指定されていません。" }, { status: 400 });
  }

  // workflow_json/input_schema/credits_cost always come from the DB by
  // slug — never trusted from the client, same posture as the preset video
  // path in /api/wan-animate/generate.
  const { data: workflowRow, error: workflowError } = await supabaseAdmin
    .from("studio_custom_workflows")
    .select(
      "id, slug, workflow_json, input_schema, sections, credits_cost, disable_smart_memory, cpu_vae, gpu_only, use_pytorch_cross_attention, high_vram, extra_args, output_node_id, default_gpu_tier",
    )
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  if (workflowError) {
    console.error("[studio/custom-workflows/generate] failed to load workflow:", workflowError.message);
    return NextResponse.json({ error: "ワークフローの取得に失敗しました。" }, { status: 500 });
  }
  if (!workflowRow) {
    return NextResponse.json({ error: "ワークフローが見つかりません。" }, { status: 404 });
  }

  const inputSchema = workflowRow.input_schema as WorkflowInputField[];
  const workflowSections = (workflowRow.sections as WorkflowSection[] | null) ?? [];

  const { data: profile, error: profileError } = await getOrCreateProfile(
    user.id,
    "credits, credits_expire_at, subscription_tier",
  );
  if (profileError) {
    console.error("[studio/custom-workflows/generate] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }
  const userTier = (profile?.subscription_tier as string | null) ?? "free";

  // A field is locked if its own minTier — or its section's — outranks the
  // viewer. Locked fields never take the submitted value: they fall back to
  // their default, so an unauthorised client can't drive a gated option.
  const sectionMinTier = new Map(workflowSections.map((s) => [s.id, s.minTier]));
  const isFieldLocked = (field: WorkflowInputField): boolean =>
    isTierLocked(field.minTier, userTier) ||
    isTierLocked(field.sectionId ? sectionMinTier.get(field.sectionId) : undefined, userTier);

  const values: Record<string, CustomWorkflowFieldValue> = {};

  for (const field of inputSchema) {
    const locked = isFieldLocked(field);
    const raw = locked ? null : formData.get(fieldFormKey(field.id));

    if (field.type === "image" || field.type === "video") {
      if (locked) continue; // gated upload — run without it rather than 400
      if (!(raw instanceof File) || raw.size === 0) {
        const noun = field.type === "video" ? "動画" : "画像";
        return NextResponse.json({ error: `「${field.label}」の${noun}をアップロードしてください。` }, { status: 400 });
      }
      const buf = Buffer.from(await raw.arrayBuffer());
      const fallbackName = field.type === "video" ? "upload.mp4" : "upload.png";
      values[field.id] = { fileBuffer: buf, fileName: raw.name || fallbackName };
      continue;
    }

    if (field.type === "slider") {
      const num = Number(raw ?? field.default ?? field.min ?? 0);
      if (!Number.isFinite(num)) {
        return NextResponse.json({ error: `「${field.label}」の値が不正です。` }, { status: 400 });
      }
      const min = typeof field.min === "number" ? field.min : undefined;
      const max = typeof field.max === "number" ? field.max : undefined;
      const clamped = Math.min(max ?? num, Math.max(min ?? num, num));
      values[field.id] = clamped;
      continue;
    }

    if (field.type === "toggle") {
      values[field.id] = raw === "true" || raw === "on" || (raw === null && field.default === true);
      continue;
    }

    // text
    const text = typeof raw === "string" ? raw : typeof field.default === "string" ? field.default : "";
    values[field.id] = text.slice(0, MAX_TEXT_FIELD_LENGTH);
  }

  // Custom workflows have no single canonical "prompt" field (unlike Wan
  // Animate 2's fixed prompt textarea) — logged for troubleshooting as every
  // submitted text-type field, labeled, so an admin can see what was typed.
  const promptSummary = inputSchema
    .filter((f) => f.type === "text" && typeof values[f.id] === "string" && (values[f.id] as string).trim())
    .map((f) => `${f.label}: ${values[f.id] as string}`)
    .join("\n");

  // GPU: the virtual __gpu_tier__ select (or a legacy gpuTier/gpu_tier form
  // field) wins if the workflow exposes one and its value is valid;
  // otherwise the workflow's saved default_gpu_tier is used. Forwarded to
  // Modal as `gpu_tier`.
  const formGpu =
    formData.get(fieldFormKey(SYSTEM_FIELD_GPU_TIER)) ??
    formData.get("field:gpuTier") ??
    formData.get("field:gpu_tier");
  const effectiveGpuTier: WorkflowGpuTier = isValidWorkflowGpuTier(formGpu)
    ? formGpu
    : ((workflowRow.default_gpu_tier as WorkflowGpuTier | null) ?? "l4");
  // Compat value for the standard/ultra-only job tracker.
  const legacyTier: GpuTier =
    effectiveGpuTier === "h100" || effectiveGpuTier === "b300" ? "ultra" : "standard";

  // Server-side re-derivation of the price via the shared engine — the
  // client's displayed total is never trusted.
  const generationCost = calculateTotalWorkflowCredits({
    creditsCost: workflowRow.credits_cost as number,
    inputSchema,
    values,
  });

  const creditsExpireAt = profile?.credits_expire_at as string | null | undefined;
  const rawCredits = profile?.credits as number | null | undefined;
  const isExpired = creditsExpireAt ? new Date(creditsExpireAt).getTime() < Date.now() : false;
  const currentCredits = isExpired ? 0 : (rawCredits ?? 0);

  if (isExpired && (rawCredits ?? 0) > 0) {
    const { error: expireError } = await supabaseAdmin
      .from("profiles")
      .update({ credits: 0 })
      .eq("id", user.id);
    if (expireError) {
      console.error("[studio/custom-workflows/generate] failed to apply credit expiry reset:", expireError.message);
    }
  }

  if (currentCredits < generationCost) {
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

  const debitedCredits = currentCredits - generationCost;
  const { error: debitError } = await supabaseAdmin
    .from("profiles")
    .update({ credits: debitedCredits })
    .eq("id", user.id);

  if (debitError) {
    console.error("[studio/custom-workflows/generate] failed to debit credits:", debitError.message);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  const startedAt = Date.now();
  const jobType = `custom-workflow:${slug}`;
  const activeJobId = await startActiveJob(user.id, jobType, legacyTier);

  try {
    const { workflow, files } = patchCustomWorkflow(
      workflowRow.workflow_json as Record<string, unknown>,
      inputSchema,
      values,
    );

    const result = await runCustomWorkflowOnModal({
      workflow,
      files,
      gpuTier: effectiveGpuTier,
      execConfig: {
        disable_smart_memory: workflowRow.disable_smart_memory as boolean,
        cpu_vae: workflowRow.cpu_vae as boolean,
        gpu_only: workflowRow.gpu_only as boolean,
        use_pytorch_cross_attention: workflowRow.use_pytorch_cross_attention as boolean,
        high_vram: workflowRow.high_vram as boolean,
        extra_args: workflowRow.extra_args as string,
      },
      saveToVolume: isAdmin,
      outputNodeId: (workflowRow.output_node_id as string | null) ?? "",
    });
    const executionTimeMs = Date.now() - startedAt;

    await logGenerationActivity({
      userId: user.id,
      jobType,
      promptInput: promptSummary || null,
      executionTimeMs,
      creditsConsumed: generationCost,
      status: "success",
      gpuTier: effectiveGpuTier,
      outputFileName: result.output_path,
    });

    // Free side-effect of a successful generation — see gpuWarmAutoExtend.ts.
    await autoExtendGpuWarmOnSuccess(user.id);

    return NextResponse.json({
      success: true,
      resultBase64: result.result_base64,
      outputKind: inferOutputKind(result.filename),
      filename: result.filename,
      remainingCredits: debitedCredits,
    });
  } catch (err) {
    console.error("[studio/custom-workflows/generate] generation failed:", err);

    const { error: refundError } = await supabaseAdmin
      .from("profiles")
      .update({ credits: currentCredits })
      .eq("id", user.id);
    if (refundError) {
      console.error("[studio/custom-workflows/generate] failed to refund credits after error:", refundError.message);
    }

    await logGenerationActivity({
      userId: user.id,
      jobType,
      promptInput: promptSummary || null,
      executionTimeMs: Date.now() - startedAt,
      creditsConsumed: 0,
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      gpuTier: effectiveGpuTier,
    });

    return NextResponse.json(
      {
        error: "生成に失敗しました。しばらくしてから再度お試しください。",
        remainingCredits: currentCredits,
      },
      { status: 502 },
    );
  } finally {
    await endActiveJob(activeJobId);
  }
}
