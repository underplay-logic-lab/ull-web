import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Public, read-only: powers the Studio page's "特化ワークフロー" tab. Only
// active workflows and only the fields the dynamic form renderer needs are
// exposed — workflow_json (the raw ComfyUI graph) and admin-only bookkeeping
// columns stay server-side.
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("studio_custom_workflows")
    .select("id, slug, title, description, category, input_schema, sections, credits_cost, gpu_badge_label")
    .eq("is_active", true)
    .order("priority", { ascending: false });

  if (error) {
    console.error("[studio/custom-workflows] fetch failed:", error.message);
    return NextResponse.json({ error: "ワークフローの取得に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ workflows: data ?? [] });
}
