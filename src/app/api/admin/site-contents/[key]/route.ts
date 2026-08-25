import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type RouteParams = { params: Promise<{ key: string }> };

// Only `value` is editable from /admin — key/section/label are structural
// (seeded by the migration) and not exposed for rewriting here.
export async function PATCH(request: Request, { params }: RouteParams) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { key } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.value !== "string") {
    return NextResponse.json({ error: "valueは必須です。" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("site_contents")
    .update({ value: body.value, updated_at: new Date().toISOString() })
    .eq("key", key)
    .select()
    .single();

  if (error) {
    console.error("[admin/site-contents] update failed:", error.message);
    return NextResponse.json({ error: "コンテンツの更新に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ content: data });
}
