import "server-only";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { getAdminEmails } from "@/lib/adminAuth";
import { FEATURE_KEYS, type FeatureKey } from "@/lib/features";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 人ごとの機能の許可の判定（2026-10-09）。API は必ずここで確かめる（タブを隠すだけでは API を叩かれる）。
// admin（ADMIN_EMAILS）は全部許可。期限切れの行は無効。DB の読み取りに失敗したら許可しない（fail-closed）。

function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && getAdminEmails().includes(email.toLowerCase());
}

export async function getUserFeatures(user: Pick<User, "id" | "email">): Promise<FeatureKey[]> {
  if (isAdminEmail(user.email)) return [...FEATURE_KEYS];
  const { data, error } = await supabaseAdmin
    .from("user_feature_grants")
    .select("feature, expires_at")
    .eq("user_id", user.id);
  if (error || !data) return [];
  const now = Date.now();
  return data
    .filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > now)
    .map((r) => r.feature)
    .filter((f): f is FeatureKey => (FEATURE_KEYS as string[]).includes(f));
}

export async function hasFeature(user: Pick<User, "id" | "email">, feature: FeatureKey): Promise<boolean> {
  return (await getUserFeatures(user)).includes(feature);
}

/** Authorization: Bearer <アクセストークン> の利用者（無効なら null）。id と email を返す。 */
export async function userFromBearer(request: Request): Promise<Pick<User, "id" | "email"> | null> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  return error || !data?.user ? null : { id: data.user.id, email: data.user.email };
}

// API の入口用: 許可が無ければ 403 の response を返す（requireAdmin と同じ形）。
export async function requireFeature(
  user: Pick<User, "id" | "email">,
  feature: FeatureKey,
): Promise<NextResponse | null> {
  if (await hasFeature(user, feature)) return null;
  return NextResponse.json({ error: "この機能はご利用いただけません。" }, { status: 403 });
}
