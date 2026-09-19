import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createLoraDatasetUploadTicket } from "@/lib/loraDatasetUpload.server";

// LoRA学習用データセット画像の直アップロード用チケットを発行する
// （2026-09-19導入）。ブラウザはこのチケットを使って
// modal_lora_worker.py::upload_lora_dataset_image へ画像を1枚ずつ直接POST
// する（Vercelのリクエストボディ上限もSupabaseの月間送信量クォータも
// 経由しない）。
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

  let body: { datasetId?: unknown } = {};
  try {
    body = (await request.json()) as { datasetId?: unknown };
  } catch {
    // datasetId 必須なので下の型チェックで弾かれる。
  }
  const datasetId = typeof body.datasetId === "string" ? body.datasetId : "";
  if (!datasetId) {
    return NextResponse.json({ error: "datasetId が必要です。" }, { status: 400 });
  }

  try {
    const ticket = createLoraDatasetUploadTicket(userData.user.id, datasetId);
    return NextResponse.json(ticket);
  } catch (err) {
    console.error("[studio/lora/dataset-upload-token] failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
