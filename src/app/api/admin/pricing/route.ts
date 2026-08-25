import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { data, error } = await supabaseAdmin
    .from("studio_pricing")
    .select("*")
    .order("label", { ascending: true });

  if (error) {
    console.error("[admin/pricing] list failed:", error.message);
    return NextResponse.json({ error: "価格設定の取得に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ pricing: data ?? [] });
}
