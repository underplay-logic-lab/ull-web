import crypto from "crypto";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { presignPublishedArtifact } from "@/lib/r2.server";

// admin「生成物 & ストレージ」タブ用 — /api/studio/upscale/original と同じ
// 署名付きURL方式だが、こちらは cookie ベースの管理者セッション
// （requireAdmin）で認可する。admin 側は client-side Supabase セッションを
// 持たない（Authorization ヘッダを付けられない）ため別ルートに分けている。
export const maxDuration = 30;

const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,120}\.(?:png|webp|jpg|jpeg)$/;
const DOWNLOAD_TOKEN_TTL_SECONDS = 900;

function signDownloadToken(userId: string, jobId: string, file: string, expiresAt: number, secret: string): string {
  const payload = `${userId}:${jobId}:${file}:${expiresAt}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export async function GET(request: Request): Promise<NextResponse> {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId") ?? "";
  const file = url.searchParams.get("file") ?? "";
  if (!jobId || !SAFE_NAME_RE.test(file)) {
    return NextResponse.json({ error: "パラメータが不正です。" }, { status: 400 });
  }

  const { data: job, error } = (await supabaseAdmin
    .from("upscale_jobs")
    .select("metadata, user_id")
    .eq("id", jobId)
    .maybeSingle()) as {
    data: { metadata: unknown; user_id: string } | null;
    error: { message: string } | null;
  };
  if (error) {
    console.error("[admin/upscale-original] job lookup failed:", error.message);
    return NextResponse.json({ error: "ジョブの取得に失敗しました。" }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });

  const meta = job.metadata as { original_available?: unknown; original_filename?: unknown } | null;
  if (!meta?.original_available || meta.original_filename !== file) {
    return NextResponse.json({ error: "元画質のファイルは保存されていません。" }, { status: 404 });
  }

  // 2026-09-23〜（R2 移行 計画 3）: publish 済みなら R2 の署名付き GET（attachment）。
  const r2Url = await presignPublishedArtifact(job.metadata, `upscale_originals/${job.user_id}/${jobId}/${file}`, {
    downloadName: file,
  });
  if (r2Url) return NextResponse.json({ downloadUrl: r2Url, store: "r2" });

  const modalUrl = process.env.MODAL_SEEDVR2_ORIGINAL_DOWNLOAD_URL;
  const modalAuthToken = process.env.MODAL_AUTH_TOKEN;
  if (!modalUrl || !modalAuthToken) {
    return NextResponse.json({ error: "サーバー設定エラーです（Modal未設定）。" }, { status: 500 });
  }

  const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_TOKEN_TTL_SECONDS;
  const sig = signDownloadToken(job.user_id, jobId, file, expiresAt, modalAuthToken);

  const target = new URL(modalUrl);
  target.searchParams.set("user_id", job.user_id);
  target.searchParams.set("job_id", jobId);
  target.searchParams.set("filename", file);
  target.searchParams.set("expires", String(expiresAt));
  target.searchParams.set("sig", sig);

  return NextResponse.json({ downloadUrl: target.toString() });
}
