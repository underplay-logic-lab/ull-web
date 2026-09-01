import crypto from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Mints a short-lived signed download URL for one LoRA checkpoint (an
// intermediate save_every snapshot, or the final weights) rather than
// proxying the file itself through this route. The worker persists them to
// loras/<user_id>/<job_id>/ and lists them in generation_jobs.metadata.
// checkpoints — this route only signs a filename that appears in that
// list, for a job the caller owns.
//
// Two designs were tried before this one, both against modal_lora_worker.py:
//   1. ModalStorage.handle(action="read_file") (a different app,
//      scripts/modal_wan_animate.py) reads the whole file and base64-
//      encodes it into a JSON body — ~800MB of JSON for a 600MB+
//      checkpoint, which blew past its own timeout (184s observed) and
//      this route's maxDuration.
//   2. A raw FileResponse stream, proxied through this route with
//      `fetch(...).body` piped into the NextResponse — no more base64
//      blow-up, but every byte still crossed BOTH browser<->this server
//      AND this server<->Modal. That doubled hop caused an
//      NGHTTP2_INTERNAL_ERROR mid-stream once transfers ran past a
//      couple of minutes, and it makes this route's own bandwidth the
//      ceiling on download speed regardless of the user's connection.
// This route now does only the ownership check and mints a signed URL —
// the actual bytes flow directly browser<->Modal, a single hop, and
// modal_lora_worker.py's download_lora_checkpoint endpoint verifies the
// signature itself (see _verify_download_token there) since the browser
// never sends this app's own Supabase session or MODAL_AUTH_TOKEN to Modal.
export const maxDuration = 30;

const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,120}\.(?:safetensors|zip)$/;
// 15 minutes — long enough to paste the link into an external Model
// Downloader and start the transfer, short enough that a leaked link
// expires quickly. The Modal endpoint re-checks this `expires` timestamp.
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

  // Look the job up by id only, then authorise: owner OR admin. The signed
  // download token must carry the JOB OWNER's id — the worker resolves the
  // file at loras/<owner_id>/<job_id>/, so signing with the (possibly admin)
  // requester's id would 404.
  const { data: job, error } = (await supabaseAdmin
    .from("generation_jobs")
    .select("metadata, user_id")
    .eq("id", jobId)
    .maybeSingle()) as {
    data: { metadata: unknown; user_id: string } | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("[studio/lora/checkpoint] job lookup failed:", error.message);
    return NextResponse.json({ error: "ジョブの取得に失敗しました。" }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  if (job.user_id !== userId && !isAdmin) {
    return NextResponse.json({ error: "このジョブのダウンロード権限がありません。" }, { status: 403 });
  }
  const ownerId = job.user_id;

  const checkpoints = (job.metadata as { checkpoints?: unknown })?.checkpoints;
  const known =
    Array.isArray(checkpoints) &&
    checkpoints.some((c) => (c as { filename?: unknown })?.filename === file);
  // dataset.zip / bundle names are always valid targets for an owned job even
  // if a stale metadata row hasn't listed them yet (salvage merges them in).
  const wellKnown = /^(dataset(_salvaged)?|checkpoints_all)\.zip$/.test(file);
  if (!known && !wellKnown) {
    return NextResponse.json(
      { error: "このファイルはまだ準備されていません。「一括DL」で復元してください。" },
      { status: 404 },
    );
  }

  const modalUrl = process.env.MODAL_LORA_CHECKPOINT_DOWNLOAD_URL;
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
