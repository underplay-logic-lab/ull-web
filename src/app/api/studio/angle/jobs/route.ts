import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Multi-Angle「最近の生成」一覧（2026-09-23）。ログインユーザー自身の angle_jobs を
// 直近 14 日ぶん（＝保持期間、CLAUDE.md §3）返す。画像は含めない — 選んだジョブを
// フロントが pollAngleJob で読み直し、images route で署名 URL に解決する。
// 背景: 順番待ち予約や並列実行で画面が次のジョブに切り替わると、前の結果に戻る
// 手段が UI に無かった（サーバー側には残っている）。
export const maxDuration = 15;

const RETENTION_DAYS = 14;
const LIMIT = 30;

export async function GET(request: Request): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");
  const accessToken = authHeader?.replace(/^Bearer\s+/i, "");
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

  const since = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("angle_jobs")
    .select("id, status, mode, total_angles, completed_angles, credits_cost, created_at")
    .eq("user_id", userData.user.id)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (error) {
    console.error("[studio/angle/jobs] list failed:", error.message);
    return NextResponse.json({ error: "一覧の取得に失敗しました。" }, { status: 500 });
  }
  return NextResponse.json({ jobs: data ?? [] });
}
