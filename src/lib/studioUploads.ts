import { supabase } from "@/lib/supabaseClient";

// Studio 全体（超解像・Multi-Angle・特化ワークフロー・Director）で共有する、
// 入力ファイルの一時アップロード先。API route には storage path だけを
// 渡し、route 側は studioUploads.server.ts の各関数で取得する。Vercel
// サーバーレス関数のリクエストボディ上限（約4.5MB。CLAUDE.md §6）と
// Supabase の月間送信量クォータ（CLAUDE.md §1）の両方を回避する。
//
// 2026-09-19: Supabase Storage バケット "upscale-uploads" から Modal 直
// アップロードへ移行（CLAUDE.md §1標準）。
// 2026-09-23: 既定を Cloudflare R2 への直 PUT（署名付き URL）に切替（計画 4）。
// チケットの `store` で経路が決まり、"modal" なら従来の POST。呼び出し側が
// 受け取る path の形（"<userId>/<filename>"）はどちらでも同じ。

const R2_PUT_ATTEMPTS = 3;

async function putToR2(url: string, file: File): Promise<void> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= R2_PUT_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (res.ok) return;
      last = new Error(`アップロードに失敗しました (${res.status})`);
      // 4xx は再送しても変わらない（署名切れ・キー不正）。
      if (res.status >= 400 && res.status < 500) break;
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < R2_PUT_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  throw last instanceof Error ? last : new Error("アップロードに失敗しました。");
}

export async function uploadStudioAsset(userId: string, file: File): Promise<{ path: string }> {
  const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "file";
  const filename = `${crypto.randomUUID()}-${safe}`;

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const ticketRes = await fetch("/api/studio/uploads/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ filename, sizeBytes: file.size, contentType: file.type || "" }),
  });
  const ticket = await ticketRes.json().catch(() => ({}));
  if (!ticketRes.ok) throw new Error(ticket?.error || "アップロード準備に失敗しました。");

  if (ticket.store === "r2") {
    await putToR2(ticket.uploadUrl as string, file);
    return { path: ticket.path as string };
  }

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
