import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Public, read-only: powers useSiteContents() across the top page (Hero,
// Studio section header/description, Pricing section header, footer
// address). Every row is public — there is no admin-only bookkeeping field
// to exclude here (unlike studio_presets/studio_custom_workflows).
export async function GET() {
  const { data, error } = await supabaseAdmin.from("site_contents").select("key, value");

  if (error) {
    console.error("[site-contents] fetch failed:", error.message);
    return NextResponse.json({ error: "コンテンツの取得に失敗しました。" }, { status: 500 });
  }

  const contents = Object.fromEntries((data ?? []).map((row) => [row.key as string, row.value as string]));
  return NextResponse.json({ contents });
}
