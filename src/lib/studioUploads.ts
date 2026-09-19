import { supabase } from "@/lib/supabaseClient";

// Studio 全体（超解像・Multi-Angle・特化ワークフロー・Director）で共有する、
// 入力ファイルの一時アップロード先。ブラウザから Modal（modal_studio_
// uploads.py）へ直接アップロードし、Vercel サーバーレス関数のリクエスト
// ボディ上限（約4.5MB。CLAUDE.md §6）と Supabase の月間送信量クォータ
// （CLAUDE.md §1）の両方を回避する。API route には storage path だけを
// 渡し、route 側は studioUploads.server.ts の各関数で取得する。
//
// 2026-09-19: Supabase Storage バケット "upscale-uploads" から Modal 直
// アップロードへ移行（CLAUDE.md §1標準）。呼び出し側が受け取る path の
// 形（"<userId>/<filename>"）は移行前と互換のまま — 変わったのは内部の
// 転送経路だけ。

export async function uploadStudioAsset(userId: string, file: File): Promise<{ path: string }> {
  const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "file";
  const filename = `${crypto.randomUUID()}-${safe}`;

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const ticketRes = await fetch("/api/studio/uploads/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ filename }),
  });
  const ticket = await ticketRes.json().catch(() => ({}));
  if (!ticketRes.ok) throw new Error(ticket?.error || "アップロード準備に失敗しました。");

  const uploadUrl = new URL(ticket.uploadUrl as string);
  uploadUrl.searchParams.set("user_id", ticket.userId as string);
  uploadUrl.searchParams.set("filename", ticket.filename as string);
  uploadUrl.searchParams.set("expires", String(ticket.expiresAt));
  uploadUrl.searchParams.set("sig", ticket.sig as string);

  const res = await fetch(uploadUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}) as { detail?: string; error?: string });
    throw new Error(detail?.detail || detail?.error || `アップロードに失敗しました (${res.status})`);
  }
  return { path: ticket.path as string };
}
