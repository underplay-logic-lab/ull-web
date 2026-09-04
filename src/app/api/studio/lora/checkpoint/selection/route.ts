import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { signJobSelectionZipUrl } from "@/lib/modalStorage";

// Mints a short-lived signed URL for download_lora_selection — the Modal
// worker bundles the named checkpoints into ONE uncompressed (ZIP_STORED) zip
// and streams it. This route does the real ownership check (owner OR admin)
// and validates every requested filename against the job's
// metadata.checkpoints list before signing; the browser then hits Modal
// directly so GB-scale bytes never cross this Vercel function.
export const maxDuration = 30;

const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,120}\.safetensors$/;

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId") ?? "";
  const files = (url.searchParams.get("files") ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  if (
    !jobId ||
    files.length < 2 ||
    files.length > 64 ||
    files.some((f) => !SAFE_NAME_RE.test(f))
  ) {
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
  const isAdmin = Boolean(
    userData.user.email && adminEmails.includes(userData.user.email.toLowerCase()),
  );

  const { data: job, error } = (await supabaseAdmin
    .from("generation_jobs")
    .select("metadata, user_id")
    .eq("id", jobId)
    .maybeSingle()) as {
    data: { metadata: unknown; user_id: string } | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("[studio/lora/checkpoint/selection] job lookup failed:", error.message);
    return NextResponse.json({ error: "ジョブの取得に失敗しました。" }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  if (job.user_id !== userId && !isAdmin) {
    return NextResponse.json({ error: "このジョブのダウンロード権限がありません。" }, { status: 403 });
  }

  const checkpoints = (job.metadata as { checkpoints?: unknown })?.checkpoints;
  const known = new Set(
    Array.isArray(checkpoints)
      ? checkpoints
          .map((c) => (c as { filename?: unknown })?.filename)
          .filter((f): f is string => typeof f === "string")
      : [],
  );
  if (files.some((f) => !known.has(f))) {
    return NextResponse.json(
      { error: "選択したファイルの一部が見つかりません。画面を再読み込みしてお試しください。" },
      { status: 404 },
    );
  }

  try {
    // Token carries the JOB OWNER's id — the worker resolves files at
    // loras/<owner_id>/<job_id>/, so signing with an admin requester's id 404s.
    const downloadUrl = signJobSelectionZipUrl(job.user_id, jobId, files);
    return NextResponse.json({ downloadUrl });
  } catch (err) {
    console.error("[studio/lora/checkpoint/selection] sign failed:", err);
    return NextResponse.json({ error: "サーバー設定エラーです（Modal未設定）。" }, { status: 500 });
  }
}
