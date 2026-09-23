import crypto from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { presignPublishedArtifact } from "@/lib/r2.server";

// 超解像画像の結果配信（2026-09-18導入）。src/app/api/studio/upscale/video/
// result/route.ts と同一設計 — 唯一の違いは拡張子がジョブごとに変わる点
// （png/webp/jpg/jpeg）なので、DBに保存されたVolume相対パスからファイル名
// をそのまま読み取って署名する（クライアントに拡張子を送らせない）。
// 背景・設計判断はそちらのコメント、および
// src/app/api/studio/upscale/original/route.ts のコメントを参照
// （同じ2つの失敗設計を経て同じ結論に至ったので重複説明しない）。
export const maxDuration = 30;

const DOWNLOAD_TOKEN_TTL_SECONDS = 900;
const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,120}\.(?:png|webp|jpg|jpeg)$/;

/** upscale_jobs.result_url がURLではなくVolume相対パス（新方式）かどうか。 */
function isVolumePath(resultUrl: string): boolean {
  return !/^https?:\/\//i.test(resultUrl);
}

function signDownloadToken(userId: string, jobId: string, file: string, expiresAt: number, secret: string): string {
  const payload = `${userId}:${jobId}:${file}:${expiresAt}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId") ?? "";
  if (!jobId) {
    return NextResponse.json({ error: "パラメータが不正です。" }, { status: 400 });
  }

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
  const userId = userData.user.id;
  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const isAdmin = Boolean(userData.user.email && adminEmails.includes(userData.user.email.toLowerCase()));

  const { data: job, error } = (await supabaseAdmin
    .from("upscale_jobs")
    .select("result_url, user_id, status, metadata")
    .eq("id", jobId)
    .maybeSingle()) as {
    data: { result_url: string | null; user_id: string; status: string; metadata: unknown } | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("[studio/upscale/image/result] job lookup failed:", error.message);
    return NextResponse.json({ error: "ジョブの取得に失敗しました。" }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  if (job.user_id !== userId && !isAdmin) {
    return NextResponse.json({ error: "このジョブのダウンロード権限がありません。" }, { status: 403 });
  }
  if (job.status !== "completed" || !job.result_url) {
    return NextResponse.json({ error: "この画像はまだ準備できていません。" }, { status: 404 });
  }
  if (!isVolumePath(job.result_url)) {
    return NextResponse.json({ error: "この画像は署名URLの発行対象ではありません。" }, { status: 400 });
  }
  const ownerId = job.user_id;

  // 2026-09-23〜（R2 移行 計画 3）: worker の CPU publish が R2 へ上げ終わった
  // 行は metadata.r2_keys に result_url が入る → R2 の署名付き GET（15 分）を
  // 返す。表示（<img src>）と fetch→blob の両方で使うので attachment は付けない。
  // まだ Volume にある行（publish 前・旧行・ARTIFACT_STORE=volume）は従来の Modal。
  const r2Url = await presignPublishedArtifact(job.metadata, job.result_url);
  if (r2Url) return NextResponse.json({ downloadUrl: r2Url, store: "r2" });

  // result_url は "upscale_image_results/<user_id>/<job_id>.<ext>" — 末尾の
  // ファイル名部分だけを署名対象にする（拡張子はここで初めて分かる）。
  const filename = job.result_url.split("/").pop() ?? "";
  if (!SAFE_NAME_RE.test(filename)) {
    return NextResponse.json({ error: "サーバー設定エラーです（不正なファイル名）。" }, { status: 500 });
  }

  const modalUrl = process.env.MODAL_SEEDVR2_IMAGE_RESULT_DOWNLOAD_URL;
  const modalAuthToken = process.env.MODAL_AUTH_TOKEN;
  if (!modalUrl || !modalAuthToken) {
    return NextResponse.json({ error: "サーバー設定エラーです（Modal未設定）。" }, { status: 500 });
  }

  const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_TOKEN_TTL_SECONDS;
  const sig = signDownloadToken(ownerId, jobId, filename, expiresAt, modalAuthToken);

  const target = new URL(modalUrl);
  target.searchParams.set("user_id", ownerId);
  target.searchParams.set("job_id", jobId);
  target.searchParams.set("filename", filename);
  target.searchParams.set("expires", String(expiresAt));
  target.searchParams.set("sig", sig);

  return NextResponse.json({ downloadUrl: target.toString() });
}
