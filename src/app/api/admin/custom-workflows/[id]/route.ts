import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  isValidInputSchema,
  isValidWorkflowJson,
  isValidWorkflowSections,
  isValidWorkflowGpuTier,
  isValidWorkflowGpuFallbackList,
} from "@/lib/customWorkflows";

type RouteParams = { params: Promise<{ id: string }> };

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function PATCH(request: Request, { params }: RouteParams) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "入力内容が不正です。" }, { status: 400 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.slug === "string") {
    const slug = body.slug.trim();
    if (!SLUG_PATTERN.test(slug)) {
      return NextResponse.json(
        { error: "slugは英小文字・数字・ハイフンのみで入力してください。" },
        { status: 400 },
      );
    }
    update.slug = slug;
  }
  if (typeof body.title === "string") {
    if (!body.title.trim()) {
      return NextResponse.json({ error: "タイトルは必須です。" }, { status: 400 });
    }
    update.title = body.title.trim();
  }
  if (typeof body.description === "string" || body.description === null) {
    update.description = typeof body.description === "string" ? body.description.trim() || null : null;
  }
  if (typeof body.category === "string" && body.category.trim()) {
    update.category = body.category.trim();
  }
  if (body.workflow_json !== undefined) {
    if (!isValidWorkflowJson(body.workflow_json)) {
      return NextResponse.json(
        { error: "workflow_json は有効なComfyUI API形式のJSONオブジェクトである必要があります。" },
        { status: 400 },
      );
    }
    update.workflow_json = body.workflow_json;
  }
  if (body.input_schema !== undefined) {
    if (!isValidInputSchema(body.input_schema)) {
      return NextResponse.json({ error: "input_schema の形式が不正です。" }, { status: 400 });
    }
    update.input_schema = body.input_schema;
  }
  if (body.sections !== undefined) {
    if (!isValidWorkflowSections(body.sections)) {
      return NextResponse.json({ error: "sections の形式が不正です。" }, { status: 400 });
    }
    update.sections = body.sections;
  }
  if (body.default_gpu_tier !== undefined) {
    if (!isValidWorkflowGpuTier(body.default_gpu_tier)) {
      return NextResponse.json({ error: "default_gpu_tier の値が不正です。" }, { status: 400 });
    }
    update.default_gpu_tier = body.default_gpu_tier;
  }
  if (typeof body.gpu_badge_label === "string") {
    update.gpu_badge_label = body.gpu_badge_label.trim().slice(0, 60);
  }
  if (body.gpu_fallback_list !== undefined) {
    if (!isValidWorkflowGpuFallbackList(body.gpu_fallback_list)) {
      return NextResponse.json({ error: "gpu_fallback_list の形式が不正です。" }, { status: 400 });
    }
    update.gpu_fallback_list = body.gpu_fallback_list;
  }
  if (typeof body.credits_cost === "number") update.credits_cost = body.credits_cost;
  if (typeof body.priority === "number") update.priority = body.priority;
  if (typeof body.is_active === "boolean") update.is_active = body.is_active;
  if (typeof body.disable_smart_memory === "boolean") update.disable_smart_memory = body.disable_smart_memory;
  if (typeof body.cpu_vae === "boolean") update.cpu_vae = body.cpu_vae;
  if (typeof body.gpu_only === "boolean") update.gpu_only = body.gpu_only;
  if (typeof body.use_pytorch_cross_attention === "boolean") {
    update.use_pytorch_cross_attention = body.use_pytorch_cross_attention;
  }
  if (typeof body.high_vram === "boolean") update.high_vram = body.high_vram;
  if (typeof body.extra_args === "string") update.extra_args = body.extra_args.trim();
  if (typeof body.output_node_id === "string") update.output_node_id = body.output_node_id.trim();

  const { data, error } = await supabaseAdmin
    .from("studio_custom_workflows")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[admin/custom-workflows] update failed:", error.message);
    if (error.code === "23505") {
      return NextResponse.json({ error: "同じslugのワークフローが既に存在します。" }, { status: 409 });
    }
    return NextResponse.json({ error: "ワークフローの更新に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ workflow: data });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { id } = await params;
  const { error } = await supabaseAdmin.from("studio_custom_workflows").delete().eq("id", id);

  if (error) {
    console.error("[admin/custom-workflows] delete failed:", error.message);
    return NextResponse.json({ error: "ワークフローの削除に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
