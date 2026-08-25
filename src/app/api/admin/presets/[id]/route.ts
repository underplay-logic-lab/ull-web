import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "入力内容が不正です。" }, { status: 400 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.title === "string") update.title = body.title.trim();
  if (typeof body.category === "string") update.category = body.category.trim();
  if (typeof body.video_url === "string") update.video_url = body.video_url.trim();
  if (typeof body.thumbnail_url === "string" || body.thumbnail_url === null) {
    update.thumbnail_url = typeof body.thumbnail_url === "string" ? body.thumbnail_url.trim() || null : null;
  }
  if (typeof body.priority === "number") update.priority = body.priority;
  if (typeof body.is_active === "boolean") update.is_active = body.is_active;

  const { data, error } = await supabaseAdmin
    .from("studio_presets")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[admin/presets] update failed:", error.message);
    return NextResponse.json({ error: "プリセットの更新に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ preset: data });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { id } = await params;
  const { error } = await supabaseAdmin.from("studio_presets").delete().eq("id", id);

  if (error) {
    console.error("[admin/presets] delete failed:", error.message);
    return NextResponse.json({ error: "プリセットの削除に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
