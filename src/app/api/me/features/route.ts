import { NextResponse } from "next/server";
import { getUserFeatures, userFromBearer } from "@/lib/features.server";

// 自分に許可されている機能の一覧（2026-10-09）。タブの出し分け用。未ログインは空。
// 実際の利用可否は各機能の API が requireFeature で確かめる（ここの結果は表示にだけ使う）。
export async function GET(request: Request) {
  const user = await userFromBearer(request);
  if (!user) return NextResponse.json({ features: [] });
  return NextResponse.json({ features: await getUserFeatures(user) });
}
