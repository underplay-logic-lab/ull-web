import { NextResponse } from "next/server";
import { normalizeHwid } from "@/lib/license/license.server";
import { issueTrial } from "@/lib/license/issue.server";
import { isLicenseProduct } from "@/lib/license/products";

// 納品ツールの試用開始（ツールから直接呼ばれる。ログイン不要）。ツール × PC ごとに 1 回、products.ts の trialDays 日。
// 期限内にもう一度呼ばれたら同じ期限で再発行する（フォルダを入れ直した等）。期限切れは 403 trial_expired。
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { hwid?: unknown; product?: unknown } | null;
  const hwid = normalizeHwid(body?.hwid);
  if (!hwid || !isLicenseProduct(body?.product)) {
    return NextResponse.json({ code: "bad_request", error: "PC の情報が読み取れませんでした。" }, { status: 400 });
  }
  const result = await issueTrial(body.product, hwid, { start: true });
  if (!result.ok) return NextResponse.json({ code: result.code, error: result.error }, { status: result.status });
  return NextResponse.json({ token: result.token });
}
