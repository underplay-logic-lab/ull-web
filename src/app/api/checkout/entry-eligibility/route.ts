import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isEntryFirstPurchaseEligible } from "@/lib/entryFirstPurchase.server";

// 料金欄の「初めてのご購入なら初月 ¥○」バッジを出してよいか（チェックアウトと同じ判定）。
// 読めなかったときは出さない（割引が付かない人に割引を見せるより安全）。
export async function GET(request: Request) {
  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  }

  const eligible = await isEntryFirstPurchaseEligible(userData.user.id);
  return NextResponse.json({ eligible: eligible === true }, { headers: { "Cache-Control": "no-store" } });
}
