import crypto from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// modal_seedvr2_worker.py が WebP 再エンコード（20MB超のPNG出力）で失う元の
// 無劣化 PNG を、modal_lora_worker.py の checkpoint ダウンロードと全く同じ
// 「署名付きURLを発行し、実バイトはブラウザ↔Modal直結で流す」方式で復元する
// ルート。理由・設計判断は src/app/api/studio/lora/checkpoint/route.ts の
// コメントを参照（同じ2つの失敗設計を経て同じ結論に至ったので、そちらを
// 重複説明しない）。
export const maxDuration = 30;

const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,120}\.(?:png|webp|jpg|jpeg)$/;
const DOWNLOAD_TOKEN_TTL_SECONDS = 900;

function signDownloadToken(userId: string, jobId: string, file: string, expiresAt: number, secret: string): string {
  const payload = `${userId}:${jobId}:${file}:${expiresAt}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId") ?? "";
  const file = url.searchParams.get("file") ?? "";

  if (!jobId || !SAFE_NAME_RE.test(file)) {
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
    .select("metadata, user_id")
    .eq("id", jobId)
    .maybeSingle()) as {
    data: { metadata: unknown; user_id: string } | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("[studio/upscale/original] job lookup failed:", error.message);
    return NextResponse.json({ error: "ジョブの取得に失敗しました。" }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  if (job.user_id !== userId && !isAdmin) {
    return NextResponse.json({ error: "このジョブのダウンロード権限がありません。" }, { status: 403 });
  }
  const ownerId = job.user_id;

  const meta = job.metadata as { original_available?: unknown; original_filename?: unknown } | null;
  if (!meta?.original_available || meta.original_filename !== file) {
    return NextResponse.json(
      { error: "元画質のファイルは保存されていません（20MB以下の出力は元々PNGのまま保存されます）。" },
      { status: 404 },
    );
  }

  const modalUrl = process.env.MODAL_SEEDVR2_ORIGINAL_DOWNLOAD_URL;
  const modalAuthToken = process.env.MODAL_AUTH_TOKEN;
  if (!modalUrl || !modalAuthToken) {
    return NextResponse.json({ error: "サーバー設定エラーです（Modal未設定）。" }, { status: 500 });
  }

  const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_TOKEN_TTL_SECONDS;
  const sig = signDownloadToken(ownerId, jobId, file, expiresAt, modalAuthToken);

  const target = new URL(modalUrl);
  target.searchParams.set("user_id", ownerId);
  target.searchParams.set("job_id", jobId);
  target.searchParams.set("filename", file);
  target.searchParams.set("expires", String(expiresAt));
  target.searchParams.set("sig", sig);

  return NextResponse.json({ downloadUrl: target.toString() });
}
