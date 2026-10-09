import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 回数の制限（2026-10-09・セキュリティ点検、migration 20260898000000）。
// 料金を取らずに有料の外部 AI を呼ぶ API を、無料登録のアカウントで繰り返し叩かれないようにする。
// DB の失敗（マイグレーション前を含む）は止めずに通す（fail-open）。制限は保険で、本来の機能を止める方が損。

/** 有料の外部 AI（Gemini）を料金なしで呼ぶ API の共通の枠: 1 人 1 時間 300 回（普通の使い方は数十回）。 */
export const GEMINI_FREE_LIMIT = { bucket: "gemini_free", windowS: 3600, max: 300 } as const;

/** 上限以内なら null、超えたら 429 の応答を返す（呼び出し元はそのまま return する）。 */
export async function rateLimitResponse(
  userId: string,
  limit: { bucket: string; windowS: number; max: number },
): Promise<NextResponse | null> {
  const { data, error } = await supabaseAdmin.rpc("hit_rate_limit", {
    p_user_id: userId,
    p_bucket: limit.bucket,
    p_window_s: limit.windowS,
    p_max: limit.max,
  });
  if (error) {
    console.error(`[rateLimit] ${limit.bucket} check failed (allowing):`, error.message);
    return null;
  }
  if (data === false) {
    return NextResponse.json(
      { error: "短い時間に回数が多すぎます。しばらく時間をおいてからお試しください。" },
      { status: 429 },
    );
  }
  return null;
}
