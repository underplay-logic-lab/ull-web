// エントリー初月割引の資格: そのアカウントで過去に 1 件も注文が無いこと。
// チェックアウト（割引の適用）と料金欄（バッジの表示）で同じ判定を使う。
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/** 資格あり true／過去の注文あり false／読めなかった null（呼び出し側で扱いを決める）。 */
export async function isEntryFirstPurchaseEligible(userId: string): Promise<boolean | null> {
  const { count, error } = await supabaseAdmin
    .from("polar_processed_orders")
    .select("order_id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) {
    console.error(`[entryFirstPurchase] could not read past orders for ${userId}:`, error.message);
    return null;
  }
  return (count ?? 0) === 0;
}
