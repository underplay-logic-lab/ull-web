import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { generateLicenseKey, hashLicenseKey, normalizeHwid, publicKeyBase64 } from "@/lib/license/license.server";
import { activateDevice } from "@/lib/license/issue.server";
import { isLicenseProduct } from "@/lib/license/products";

// admin「ライセンス」（2026-09-30）。納品ツールのライセンス台帳。
//   GET   … 一覧（端末つき）＋ツールに埋め込む公開鍵
//   POST  … { action: "create", ... } 発行（キーの原文はこの応答で一度だけ返す）
//           { action: "manual", licenseId, hwid } 手動発行（オフラインの相手用。ライセンスファイルの中身を返す）
//   PATCH … { licenseId, revoked } 停止/再開、{ activationId, revoked } 端末の解除/戻す、
//           { licenseId, maxDevices?, expiresAt? } 台数・期限の変更（expiresAt は "" で無期限）

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { data, error } = await supabaseAdmin
    .from("licenses")
    .select(
      "id, product, licensee, contact, note, key_hint, max_devices, expires_at, revoked_at, created_at, license_activations(id, hwid, method, activated_at, last_seen_at, revoked_at)",
    )
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let publicKey: string | null = null;
  let keyError: string | null = null;
  try {
    publicKey = publicKeyBase64();
  } catch (e) {
    keyError = e instanceof Error ? e.message : String(e);
  }
  return NextResponse.json({ licenses: data ?? [], publicKey, keyError });
}

type PostBody =
  | {
      action: "create";
      product?: unknown;
      licensee?: unknown;
      contact?: unknown;
      note?: unknown;
      maxDevices?: unknown;
      expiresAt?: unknown;
    }
  | { action: "manual"; licenseId?: unknown; hwid?: unknown };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function POST(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;
  const body = (await request.json().catch(() => null)) as PostBody | null;

  if (body?.action === "create") {
    const licensee = str(body.licensee, 100);
    if (!isLicenseProduct(body.product)) return NextResponse.json({ error: "ツールを選んでください。" }, { status: 400 });
    if (!licensee) return NextResponse.json({ error: "名義を入力してください。" }, { status: 400 });
    const maxDevices = Math.max(1, Math.min(50, Math.trunc(Number(body.maxDevices) || 1)));
    const expiresRaw = str(body.expiresAt, 40);
    const expiresAt = expiresRaw ? new Date(expiresRaw) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return NextResponse.json({ error: "期限の日付が正しくありません。" }, { status: 400 });
    }

    const key = generateLicenseKey();
    const { data, error } = await supabaseAdmin
      .from("licenses")
      .insert({
        product: body.product,
        licensee,
        contact: str(body.contact, 200) || null,
        note: str(body.note, 1000) || null,
        key_hash: hashLicenseKey(key),
        key_hint: key.slice(-5),
        max_devices: maxDevices,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
      })
      .select("id")
      .single();
    if (error || !data) return NextResponse.json({ error: error?.message ?? "発行に失敗しました。" }, { status: 500 });
    return NextResponse.json({ id: data.id, key });
  }

  if (body?.action === "manual") {
    const hwid = normalizeHwid(body.hwid);
    if (typeof body.licenseId !== "string" || !hwid) {
      return NextResponse.json({ error: "HWID（64 桁の英数字）を貼り付けてください。" }, { status: 400 });
    }
    const { data: lic, error } = await supabaseAdmin
      .from("licenses")
      .select("id, product, licensee, max_devices, expires_at, revoked_at")
      .eq("id", body.licenseId)
      .maybeSingle();
    if (error || !lic) return NextResponse.json({ error: error?.message ?? "ライセンスが見つかりません。" }, { status: 404 });
    const result = await activateDevice(lic, hwid, "manual");
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ token: result.token, product: lic.product });
  }

  return NextResponse.json({ error: "不明な操作です。" }, { status: 400 });
}

export async function PATCH(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;
  const body = (await request.json().catch(() => null)) as
    | { licenseId?: unknown; activationId?: unknown; revoked?: unknown; maxDevices?: unknown; expiresAt?: unknown }
    | null;

  // 台数・期限の変更（発行後）。台数を今の認証台数より減らしても既存の PC は外さない（新しい認証だけ止まる）。
  // 期限の延長は、ツールが期限切れ時にオンラインで確かめて新しいライセンスを受け取る（オフラインのままなら古い期限で止まる）。
  if (typeof body?.licenseId === "string" && (body.maxDevices !== undefined || body.expiresAt !== undefined)) {
    const update: { max_devices?: number; expires_at?: string | null } = {};
    if (body.maxDevices !== undefined) update.max_devices = Math.max(1, Math.min(50, Math.trunc(Number(body.maxDevices) || 1)));
    if (body.expiresAt !== undefined) {
      const raw = typeof body.expiresAt === "string" ? body.expiresAt.trim() : "";
      const d = raw ? new Date(raw) : null;
      if (d && Number.isNaN(d.getTime())) return NextResponse.json({ error: "期限の日付が正しくありません。" }, { status: 400 });
      update.expires_at = d ? d.toISOString() : null;
    }
    const { error } = await supabaseAdmin.from("licenses").update(update).eq("id", body.licenseId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (typeof body?.revoked !== "boolean") return NextResponse.json({ error: "revoked が必要です。" }, { status: 400 });
  const revokedAt = body.revoked ? new Date().toISOString() : null;

  if (typeof body.licenseId === "string") {
    const { error } = await supabaseAdmin.from("licenses").update({ revoked_at: revokedAt }).eq("id", body.licenseId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  if (typeof body.activationId === "string") {
    const { error } = await supabaseAdmin
      .from("license_activations")
      .update({ revoked_at: revokedAt })
      .eq("id", body.activationId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "licenseId か activationId が必要です。" }, { status: 400 });
}
