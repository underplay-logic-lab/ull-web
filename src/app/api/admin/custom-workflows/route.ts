import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isValidInputSchema, isValidWorkflowJson } from "@/lib/customWorkflows";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { data, error } = await supabaseAdmin
    .from("studio_custom_workflows")
    .select("*")
    .order("priority", { ascending: false });

  if (error) {
    console.error("[admin/custom-workflows] list failed:", error.message);
    return NextResponse.json({ error: "ワークフローの取得に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ workflows: data ?? [] });
}

export async function POST(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "入力内容が不正です。" }, { status: 400 });
  }

  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";

  if (!slug || !SLUG_PATTERN.test(slug)) {
    return NextResponse.json(
      { error: "slugは英小文字・数字・ハイフンのみで入力してください（例: manga-face-inpaint）。" },
      { status: 400 },
    );
  }
  if (!title) {
    return NextResponse.json({ error: "タイトルは必須です。" }, { status: 400 });
  }
  if (!isValidWorkflowJson(body.workflow_json)) {
    return NextResponse.json(
      { error: "workflow_json は有効なComfyUI API形式のJSONオブジェクトである必要があります。" },
      { status: 400 },
    );
  }
  const inputSchema = body.input_schema ?? [];
  if (!isValidInputSchema(inputSchema)) {
    return NextResponse.json({ error: "input_schema の形式が不正です。" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("studio_custom_workflows")
    .insert({
      slug,
      title,
      description:
        typeof body.description === "string" && body.description.trim() ? body.description.trim() : null,
      category: typeof body.category === "string" && body.category.trim() ? body.category.trim() : "image",
      workflow_json: body.workflow_json,
      input_schema: inputSchema,
      credits_cost: typeof body.credits_cost === "number" ? body.credits_cost : 15,
      priority: typeof body.priority === "number" ? body.priority : 0,
      is_active: typeof body.is_active === "boolean" ? body.is_active : true,
      disable_smart_memory: typeof body.disable_smart_memory === "boolean" ? body.disable_smart_memory : false,
      cpu_vae: typeof body.cpu_vae === "boolean" ? body.cpu_vae : false,
      gpu_only: typeof body.gpu_only === "boolean" ? body.gpu_only : false,
      use_pytorch_cross_attention:
        typeof body.use_pytorch_cross_attention === "boolean" ? body.use_pytorch_cross_attention : false,
      high_vram: typeof body.high_vram === "boolean" ? body.high_vram : false,
      extra_args: typeof body.extra_args === "string" ? body.extra_args.trim() : "",
      output_node_id: typeof body.output_node_id === "string" ? body.output_node_id.trim() : "",
    })
    .select()
    .single();

  if (error) {
    console.error("[admin/custom-workflows] create failed:", error.message);
    if (error.code === "23505") {
      return NextResponse.json({ error: "同じslugのワークフローが既に存在します。" }, { status: 409 });
    }
    return NextResponse.json({ error: "ワークフローの作成に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ workflow: data }, { status: 201 });
}
