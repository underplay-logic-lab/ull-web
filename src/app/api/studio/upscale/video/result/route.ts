import crypto from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 超解像動画の結果配信（2026-09-18導入）。
//
// 旧実装は modal_seedvr2_worker.py が Supabase Storage の upscale-results
// バケット（公開）へ mp4 を upsert し、upscale_jobs.result_url にその公開
// URLをそのまま永続化していた。閲覧・ダウンロードのたびにSupabase側の
// 送信量としてカウントされ、動画は容量が大きいためFreeプランの月間5GB
// クォータを圧迫する主因の一つだった（CLAUDE.md §1「大容量バイナリは
// Supabaseを経由させない」標準を参照）。
//
// 新実装は、ワーカーが Volume（upscale_video_results/<user_id>/<job_id>.mp4）
// へ直接保存し、result_url カラムにはURLではなくそのVolume相対パスを保存
// する。このルートは src/app/api/studio/upscale/original/route.ts と全く
// 同じ「署名付きURLを発行し、実バイトはブラウザ↔Modal直結で流す」方式で、
// modal_seedvr2_worker.py::download_upscale_video が署名を検証する
// （_verify_download_token、download_upscale_originalと共通の汎用実装）。
export const maxDuration = 30;

const DOWNLOAD_TOKEN_TTL_SECONDS = 900;

/** upscale_jobs.result_url がURLではなくVolume相対パスかどうか判定する。
 * http(s) で始まらなければ新方式（Volume直接配信）とみなす。 */
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
    .select("result_url, user_id, status")
    .eq("id", jobId)
    .maybeSingle()) as {
    data: { result_url: string | null; user_id: string; status: string } | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("[studio/upscale/video/result] job lookup failed:", error.message);
    return NextResponse.json({ error: "ジョブの取得に失敗しました。" }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  if (job.user_id !== userId && !isAdmin) {
    return NextResponse.json({ error: "このジョブのダウンロード権限がありません。" }, { status: 403 });
  }
  if (job.status !== "completed" || !job.result_url) {
    return NextResponse.json({ error: "この動画はまだ準備できていません。" }, { status: 404 });
  }
  if (!isVolumePath(job.result_url)) {
    // 旧方式（Supabase公開URL）で保存済みの行 — そのまま使えるので、この
    // ルートを呼ぶ意味が無い（呼び出し側の実装ミス）。
    return NextResponse.json({ error: "この動画は署名URLの発行対象ではありません。" }, { status: 400 });
  }
  const ownerId = job.user_id;

  const modalUrl = process.env.MODAL_SEEDVR2_VIDEO_RESULT_DOWNLOAD_URL;
  const modalAuthToken = process.env.MODAL_AUTH_TOKEN;
  if (!modalUrl || !modalAuthToken) {
    return NextResponse.json({ error: "サーバー設定エラーです（Modal未設定）。" }, { status: 500 });
  }

  const filename = `${jobId}.mp4`;
  const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_TOKEN_TTL_SECONDS;
  const sig = signDownloadToken(ownerId, jobId, filename, expiresAt, modalAuthToken);

  const target = new URL(modalUrl);
  target.searchParams.set("user_id", ownerId);
  target.searchParams.set("job_id", jobId);
  target.searchParams.set("expires", String(expiresAt));
  target.searchParams.set("sig", sig);

  return NextResponse.json({ downloadUrl: target.toString() });
}
