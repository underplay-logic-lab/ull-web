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

  const { data, error } = await supabaseAdmin
    .from("generation_jobs")
    .select("id, status, created_at, updated_at")
    .eq("user_id", userData.user.id)
    .eq("workflow_type", "lora_training")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[studio/lora/recent] lookup failed:", error.message);
    return NextResponse.json({ error: "取得に失敗しました。" }, { status: 500 });
  }
  if (!data) return NextResponse.json({ job: null });

  return NextResponse.json({
    job: {
      jobId: data.id as string,
      status: String(data.status ?? ""),
      createdAt: (data.created_at as string | null) ?? null,
      updatedAt: (data.updated_at as string | null) ?? null,
    },
  });
}
