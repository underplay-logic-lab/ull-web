import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// admin「問い合わせ」（2026-09-28、会員特典: リクエスト・技術的なご相談は上位プランから優先して検討）。
// 未対応 → 対応済みの順、その中はプランの高い順 → 新しい順。member_tier は送信時点のプラン（/api/contact が記録）。

const TIER_RANK: Record<string, number> = { studio: 5, master: 4, pro: 3, standard: 2, entry: 1 };
const LIMIT = 200;

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { data, error } = await supabaseAdmin
    .from("contact_inquiries")
    .select("id, name, email, company, service, message, member_tier, handled_at, email_sent, created_at")
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []).sort((a, b) => {
    const open = Number(Boolean(a.handled_at)) - Number(Boolean(b.handled_at));
    if (open !== 0) return open;
    const rank = (TIER_RANK[b.member_tier ?? ""] ?? 0) - (TIER_RANK[a.member_tier ?? ""] ?? 0);
    if (rank !== 0) return rank;
    return b.created_at.localeCompare(a.created_at);
  });
  return NextResponse.json({ inquiries: rows });
}

export async function PATCH(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = (await request.json().catch(() => null)) as { id?: string; handled?: boolean } | null;
  if (!body?.id || typeof body.handled !== "boolean") {
    return NextResponse.json({ error: "id と handled が必要です。" }, { status: 400 });
  }
  const { error } = await supabaseAdmin
    .from("contact_inquiries")
    .update({ handled_at: body.handled ? new Date().toISOString() : null })
    .eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
