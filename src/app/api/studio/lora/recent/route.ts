import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// The requesting user's most recent LoRA Studio job. The client uses this to
// re-attach to a job after its localStorage pointer was lost (a terminal
// 'failed'/'cancelled' job whose key was cleared before the Salvage panel
// added a reason to keep it, or an in-flight job on a fresh device).
export const maxDuration = 15;

export async function GET(request: Request): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");
  const accessToken = authHeader?.replace(/^Bearer\s+/i, "");
  if (!accessToken) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });

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

  // 2026-09-20: limit(1)（＝単純に最新1件）をやめた。呼び出し側がこの API に
  // 求めているのは「実行中ジョブへの再アタッチ」と「最近完了したジョブの
  // ダウンロード導線」の2つだけで、failed / cancelled は recent 経由では
  // 扱わない（LoraStudioTab の fromRecent ガード）。にもかかわらず最新1件しか
  // 返していなかったため、**失敗ジョブを1本挟むと直前の完了ジョブの成果物に
  // UI から到達できなくなっていた**（Modal Volume には 14日間残っているのに
  // 「🏆 直前の学習が完了しています」バナーが出ない）。実際に踏んだ。
  // そこで数件見て、呼び出し側が実際に使える1件を優先順位付きで返す。
  const { data, error } = await supabaseAdmin
    .from("generation_jobs")
    .select("id, status, created_at, updated_at")
    .eq("user_id", userData.user.id)
    .eq("workflow_type", "lora_training")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("[studio/lora/recent] lookup failed:", error.message);
    return NextResponse.json({ error: "取得に失敗しました。" }, { status: 500 });
  }
  const rows = (data ?? []) as {
    id: string;
    status: string | null;
    created_at: string | null;
    updated_at: string | null;
  }[];
  if (rows.length === 0) return NextResponse.json({ job: null });

  // 1) まだ走っているジョブ（再アタッチが最優先）
  // 2) 次に、直近の完了ジョブ（成果物のダウンロード導線）
  // 3) どちらも無ければ最新1件（従来どおり。呼び出し側が reattachable 判定で
  //    弾くので画面は動かないが、状態を隠さない意味で返す）
  const running = rows.find((r) => r.status === "queued" || r.status === "processing");
  const completed = rows.find((r) => r.status === "completed");
  const picked = running ?? completed ?? rows[0];

  return NextResponse.json({
    job: {
      jobId: picked.id,
      status: String(picked.status ?? ""),
      createdAt: picked.created_at ?? null,
      updatedAt: picked.updated_at ?? null,
    },
  });
}
