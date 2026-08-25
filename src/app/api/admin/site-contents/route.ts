import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { data, error } = await supabaseAdmin
    .from("site_contents")
    .select("*")
    .order("section", { ascending: true })
    .order("key", { ascending: true });

  if (error) {
    console.error("[admin/site-contents] list failed:", error.message);
    return NextResponse.json({ error: "コンテンツの取得に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ contents: data ?? [] });
}

// Bulk update used by the top page's inline Visual Editor (AdminEditBar's
// "💾 変更を本番公開"): publishes every pending draft edit in one request,
// as opposed to the single-key PATCH at /api/admin/site-contents/[key]
// used by the admin dashboard's per-row Save button.
export async function PATCH(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.updates)) {
    return NextResponse.json({ error: "updatesは配列で指定してください。" }, { status: 400 });
  }

  const updates: { key: string; value: string }[] = [];
  for (const item of body.updates) {
    if (!item || typeof item !== "object" || typeof item.key !== "string" || typeof item.value !== "string") {
      return NextResponse.json(
        { error: "updatesの各要素はkey/valueの文字列を持つ必要があります。" },
        { status: 400 },
      );
    }
    updates.push({ key: item.key, value: item.value });
  }
  if (updates.length === 0) {
    return NextResponse.json({ error: "updatesが空です。" }, { status: 400 });
  }

  const updatedAt = new Date().toISOString();
  const results = await Promise.all(
    updates.map(({ key, value }) =>
      supabaseAdmin.from("site_contents").update({ value, updated_at: updatedAt }).eq("key", key).select().single(),
    ),
  );

  const failed = results.find((r) => r.error);
  if (failed?.error) {
    console.error("[admin/site-contents] bulk update failed:", failed.error.message);
    return NextResponse.json({ error: "コンテンツの一括更新に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ contents: results.map((r) => r.data) });
}
