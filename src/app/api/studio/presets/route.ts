import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Public, read-only: powers the Studio page's live preset grid. Only active
// presets and only the fields the UI/generation flow needs are exposed —
// admin-only bookkeeping columns (created_at, updated_at, is_active itself)
// stay server-side.
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("studio_presets")
    .select("id, title, category, video_url, thumbnail_url, priority")
    .eq("is_active", true)
    .order("priority", { ascending: false });

  if (error) {
    console.error("[studio/presets] fetch failed:", error.message);
    return NextResponse.json({ error: "プリセットの取得に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ presets: data ?? [] });
}
