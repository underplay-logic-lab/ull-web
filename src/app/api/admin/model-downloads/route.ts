import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Polled every few seconds by ModalStorageTab's "📥 ダウンロードタスク一覧"
// panel — capped well above any realistic number of concurrent/recent
// downloads so the panel still has history to show right after a clear.
const RECENT_DOWNLOADS_LIMIT = 50;

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { data, error } = await supabaseAdmin
    .from("model_downloads")
    .select("id, url, save_path, status, progress_percent, error_message, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(RECENT_DOWNLOADS_LIMIT);

  if (error) {
    console.error("[admin/model-downloads] list failed:", error.message);
    return NextResponse.json({ error: "ダウンロードタスクの取得に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ downloads: data ?? [] });
}

export async function DELETE(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : null;
  const clearFinished = body?.clear_finished === true;

  if (!id && !clearFinished) {
    return NextResponse.json({ error: "id または clear_finished を指定してください。" }, { status: 400 });
  }

  const query = supabaseAdmin.from("model_downloads").delete();
  const { error } = id ? await query.eq("id", id) : await query.in("status", ["completed", "failed"]);

  if (error) {
    console.error("[admin/model-downloads] delete failed:", error.message);
    return NextResponse.json({ error: "削除に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
