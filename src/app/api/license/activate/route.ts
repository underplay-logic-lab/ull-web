import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { hashLicenseKey, normalizeHwid } from "@/lib/license/license.server";
import { activateDevice } from "@/lib/license/issue.server";

// 納品ツールの初回認証（ツールから直接呼ばれる。ログイン不要）。キー＋HWID → 署名付きライセンス（トークン）。
// キーは 100 bit の乱数なので総当たりは現実的でない。応答は「キーが違う」と「商品が違う」を区別しない。
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { key?: unknown; hwid?: unknown; product?: unknown } | null;
  const hwid = normalizeHwid(body?.hwid);
  const key = typeof body?.key === "string" ? body.key : "";
  const product = typeof body?.product === "string" ? body.product : "";
  if (!hwid || !key.trim() || !product) {
    return NextResponse.json({ code: "bad_request", error: "ライセンスキーを入力してください。" }, { status: 400 });
  }

  const { data: lic, error } = await supabaseAdmin
    .from("licenses")
    .select("id, product, licensee, max_devices, expires_at, revoked_at")
    .eq("key_hash", hashLicenseKey(key))
    .maybeSingle();
  if (error) return NextResponse.json({ code: "db", error: "認証サーバーでエラーが起きました。" }, { status: 500 });
  if (!lic || lic.product !== product) {
    return NextResponse.json({ code: "invalid_key", error: "ライセンスキーが正しくありません。" }, { status: 404 });
  }

  const result = await activateDevice(lic, hwid, "online");
  if (!result.ok) return NextResponse.json({ code: result.code, error: result.error }, { status: result.status });
  return NextResponse.json({ token: result.token });
}
