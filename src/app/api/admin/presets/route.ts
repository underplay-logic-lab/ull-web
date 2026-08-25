import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { data, error } = await supabaseAdmin
    .from("studio_presets")
    .select("*")
    .order("priority", { ascending: false });

  if (error) {
    console.error("[admin/presets] list failed:", error.message);
    return NextResponse.json({ error: "プリセットの取得に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ presets: data ?? [] });
}

export async function POST(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = await request.json().catch(() => null);
  if (
    !body ||
    typeof body.title !== "string" ||
    !body.title.trim() ||
    typeof body.category !== "string" ||
    !body.category.trim() ||
    typeof body.video_url !== "string" ||
    !body.video_url.trim()
  ) {
    return NextResponse.json({ error: "タイトル・カテゴリ・動画URLは必須です。" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("studio_presets")
    .insert({
      title: body.title.trim(),
      category: body.category.trim(),
      video_url: body.video_url.trim(),
      thumbnail_url: typeof body.thumbnail_url === "string" && body.thumbnail_url.trim() ? body.thumbnail_url.trim() : null,
      priority: typeof body.priority === "number" ? body.priority : 0,
      is_active: typeof body.is_active === "boolean" ? body.is_active : true,
    })
    .select()
    .single();

  if (error) {
    console.error("[admin/presets] create failed:", error.message);
    return NextResponse.json({ error: "プリセットの作成に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ preset: data }, { status: 201 });
}
