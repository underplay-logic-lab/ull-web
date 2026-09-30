import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { hashLicenseKey, normalizeHwid } from "@/lib/license/license.server";
import { activateDevice } from "@/lib/license/issue.server";

// 納品ツールの認証（ツールから直接呼ばれる。ログイン不要）。キー＋HWID → 署名付きライセンス（トークン）。
// キーは 100 bit の乱数なので総当たりは現実的でない。応答は「キーが違う」と「商品が違う」を区別しない。
// 台数が上限のときは 409 device_limit と transferAvailable を返す。ツールが確認のうえ transfer:true で送り直すと移し替える。
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { key?: unknown; hwid?: unknown; product?: unknown; transfer?: unknown }
    | null;
  const hwid = normalizeHwid(body?.hwid);
  const key = typeof body?.key === "string" ? body.key : "";
  const product = typeof body?.product === "string" ? body.product : "";
  if (!hwid || !product) {
    return NextResponse.json({ code: "bad_request", error: "PC の情報が読み取れませんでした。" }, { status: 400 });
  }
  if (!key.trim()) {
    return NextResponse.json({ code: "bad_request", error: "ライセンスキーを入力してください。" }, { status: 400 });
  }

  const { data: lic, error } = await supabaseAdmin
    .from("licenses")
    .select("id, product, licensee, max_devices, expires_at, revoked_at, last_transfer_at")
    .eq("key_hash", hashLicenseKey(key))
    .maybeSingle();
  if (error) return NextResponse.json({ code: "db", error: "認証サーバーでエラーが起きました。" }, { status: 500 });
  if (!lic || lic.product !== product) {
    return NextResponse.json({ code: "invalid_key", error: "ライセンスキーが正しくありません。" }, { status: 404 });
  }

  const result = await activateDevice(lic, hwid, "online", { transfer: body?.transfer === true });
  if (!result.ok) {
    return NextResponse.json(
      { code: result.code, error: result.error, transferAvailable: result.transferAvailable ?? false },
      { status: result.status },
    );
  }
  return NextResponse.json({ token: result.token });
}
