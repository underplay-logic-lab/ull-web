import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { verifyToken } from "@/lib/license/license.server";
import { activateDevice, issueTrial } from "@/lib/license/issue.server";

// 納品ツールの再確認（ツールが rck を過ぎたとき・hck を過ぎたとき・試用中は起動のたびに呼ぶ）。
// 停止・期限切れ・PC の解除（移し替え含む）をここで反映する。
// 応答が 400/403/404 のときツールはライセンスファイルを消して止まる。通信エラーなら hck までは今のファイルのまま動く。
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const payload = typeof body?.token === "string" ? verifyToken(body.token) : null;
  if (!payload) return NextResponse.json({ code: "invalid_token", error: "ライセンスファイルが正しくありません。" }, { status: 400 });

  if (payload.kind === "trial") {
    const result = await issueTrial(payload.product, payload.hwid, { start: false });
    if (!result.ok) return NextResponse.json({ code: result.code, error: result.error }, { status: result.status });
    return NextResponse.json({ token: result.token });
  }

  const [{ data: lic, error }, { data: act }] = await Promise.all([
    supabaseAdmin
      .from("licenses")
      .select("id, product, licensee, max_devices, expires_at, revoked_at, last_transfer_at")
      .eq("id", payload.lid)
      .maybeSingle(),
    supabaseAdmin.from("license_activations").select("id, hwid, revoked_at").eq("id", payload.aid).maybeSingle(),
  ]);
  if (error) return NextResponse.json({ code: "db", error: "認証サーバーでエラーが起きました。" }, { status: 500 });
  if (!lic) return NextResponse.json({ code: "not_found", error: "このライセンスは見つかりませんでした。" }, { status: 404 });
  if (!act || act.hwid !== payload.hwid || act.revoked_at) {
    return NextResponse.json(
      {
        code: "device_revoked",
        error: "この PC のライセンスは解除されています（別の PC に移された可能性があります）。心当たりが無い場合は「困ったときは」からご連絡ください。",
      },
      { status: 403 },
    );
  }

  const result = await activateDevice(lic, payload.hwid, "online");
  if (!result.ok) return NextResponse.json({ code: result.code, error: result.error }, { status: result.status });
  return NextResponse.json({ token: result.token });
}
