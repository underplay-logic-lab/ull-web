import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createDirectorLoraUploadTicket } from "@/lib/directorLoraUpload.server";

// ULL Cinematic Director: 外部LoRAアップロード用の署名付きチケットを発行する
// （2026-09-18導入）。ブラウザはこのチケットを使って
// modal_lora_worker.py::upload_user_lora へ直接ファイルをPOSTする
// （Vercel/Supabaseどちらのボディサイズ上限も経由しない）。
export const maxDuration = 15;

export async function POST(request: Request) {
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

  let body: { filename?: unknown } = {};
  try {
    body = (await request.json()) as { filename?: unknown };
  } catch {
    // filename 必須なので下の型チェックで弾かれる。
  }
  const filename = typeof body.filename === "string" ? body.filename : "";
  if (!filename) {
    return NextResponse.json({ error: "filename が必要です。" }, { status: 400 });
  }

  try {
    const ticket = createDirectorLoraUploadTicket(userData.user.id, filename);
    return NextResponse.json(ticket);
  } catch (err) {
    console.error("[director/loras/upload-token] failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
