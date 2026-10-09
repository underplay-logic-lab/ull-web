import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { isFeatureKey } from "@/lib/features";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// admin「機能の許可」（2026-10-09）。user_feature_grants の一覧・付与・取り消し。
// 付与はメールアドレスで指定する（profiles.email で利用者を引く。未登録のアドレスは付与できない）。

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { data, error } = await supabaseAdmin
    .from("user_feature_grants")
    .select("user_id, feature, note, granted_by, expires_at, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = [...new Set((data ?? []).map((r) => r.user_id as string))];
  const emails = new Map<string, string | null>();
  if (ids.length > 0) {
    const { data: profiles } = await supabaseAdmin.from("profiles").select("id, email").in("id", ids);
    for (const p of profiles ?? []) emails.set(p.id as string, (p.email as string | null) ?? null);
  }
  return NextResponse.json({
    grants: (data ?? []).map((r) => ({ ...r, email: emails.get(r.user_id as string) ?? null })),
  });
}

export async function POST(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = (await request.json().catch(() => null)) as
    | { email?: string; feature?: string; note?: string; expires_at?: string | null }
    | null;
  const email = body?.email?.trim().toLowerCase();
  if (!email || !isFeatureKey(body?.feature)) {
    return NextResponse.json({ error: "メールアドレスと機能が必要です。" }, { status: 400 });
  }
  let expiresAt: string | null = null;
  if (body?.expires_at) {
    const t = new Date(body.expires_at);
    if (Number.isNaN(t.getTime())) return NextResponse.json({ error: "期限の日付が読めません。" }, { status: 400 });
    expiresAt = t.toISOString();
  }

  const { data: profiles, error: pErr } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .ilike("email", email.replace(/[\\%_]/g, (c) => `\\${c}`)) // 大文字小文字だけ無視して完全一致（_ や % をワイルドカードにしない）
    .limit(2);
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
  if (!profiles || profiles.length === 0) {
    return NextResponse.json({ error: "このメールアドレスの会員が見つかりません。" }, { status: 404 });
  }
  if (profiles.length > 1) return NextResponse.json({ error: "同じメールアドレスの会員が複数います。" }, { status: 409 });
  const profile = profiles[0];

  const { error } = await supabaseAdmin.from("user_feature_grants").upsert({
    user_id: profile.id,
    feature: body!.feature,
    note: body?.note?.trim() || null,
    granted_by: user.email ?? null,
    expires_at: expiresAt,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = (await request.json().catch(() => null)) as { user_id?: string; feature?: string } | null;
  if (!body?.user_id || !isFeatureKey(body.feature)) {
    return NextResponse.json({ error: "user_id と機能が必要です。" }, { status: 400 });
  }
  const { error } = await supabaseAdmin
    .from("user_feature_grants")
    .delete()
    .eq("user_id", body.user_id)
    .eq("feature", body.feature);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
