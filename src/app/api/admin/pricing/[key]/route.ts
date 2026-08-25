import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type RouteParams = { params: Promise<{ key: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { key } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "入力内容が不正です。" }, { status: 400 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.label === "string") update.label = body.label.trim();
  if (typeof body.credits === "number" && Number.isFinite(body.credits)) {
    update.credits = body.credits;
  }
  if (typeof body.unit_cost_usd === "number" && Number.isFinite(body.unit_cost_usd)) {
    update.unit_cost_usd = body.unit_cost_usd;
  }

  const { data, error } = await supabaseAdmin
    .from("studio_pricing")
    .update(update)
    .eq("key", key)
    .select()
    .single();

  if (error) {
    console.error("[admin/pricing] update failed:", error.message);
    return NextResponse.json({ error: "価格設定の更新に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ pricing: data });
}
