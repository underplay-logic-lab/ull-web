import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// クレジットの引き落としと返金（2026-10-09・セキュリティ点検）。
// 「残高を読む → 引いた値を書く」だと、同時に何本も送られたときに 1 本分の料金で何本も作れた（二重使用）。
// データベースの関数（migration 20260897000000）で、確かめるのと引くのを 1 回の操作にする。

/** 残高が足りれば、その場で引いて新しい残高を返す。足りない・期限切れなら null（何も引かない）。DB の失敗は例外。 */
export async function debitCredits(userId: string, amount: number): Promise<number | null> {
  const n = Math.max(0, Math.round(amount));
  const { data, error } = await supabaseAdmin.rpc("debit_profile_credits", { p_user_id: userId, p_amount: n });
  if (error) throw new Error(`debit_profile_credits failed: ${error.message}`);
  return typeof data === "number" ? data : null;
}

/** その場で足して新しい残高を返す（期限は動かさない）。失敗してもログだけ（呼び出し元の後始末を止めない）。 */
export async function refundCredits(userId: string, amount: number): Promise<number | null> {
  const n = Math.max(0, Math.round(amount));
  if (n === 0) return null;
  const { data, error } = await supabaseAdmin.rpc("refund_profile_credits", { p_user_id: userId, p_amount: n });
  if (error) {
    console.error(`[credits] refund ${n}C for ${userId} failed:`, error.message);
    return null;
  }
  return typeof data === "number" ? data : null;
}
