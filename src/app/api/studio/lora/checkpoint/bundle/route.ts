import crypto from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { signAdminVolumeUrl } from "@/lib/modalStorage";

// One-shot bulk download for a finished LoRA job — no salvage round-trip.
//   - checkpoints_all.zip / dataset.zip already in loras/<owner>/<job>/ ->
//     a signed direct URL (download_lora_checkpoint), returned instantly.
//   - not pre-built -> the CPU-only admin_zip_volume_folder endpoint zips the
//     whole job folder on demand and streams it.
// Auth: the job's owner OR an admin (ADMIN_EMAILS). The signed token always
// carries the JOB OWNER's id so the worker resolves loras/<owner>/<job>/.
export const maxDuration = 30;

const TTL_SECONDS = 900;
const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,120}\.(?:safetensors|zip)$/;

function signCheckpointToken(
  ownerId: string,
  jobId: string,
  file: string,
  expiresAt: number,
  secret: string,
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${ownerId}:${jobId}:${file}:${expiresAt}`)
    .digest("hex");
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId") ?? "";
  const want = url.searchParams.get("want") === "dataset" ? "dataset" : "bundle";
  if (!jobId) return NextResponse.json({ error: "jobId が必要です。" }, { status: 400 });

  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!accessToken) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const modalUrl = process.env.MODAL_LORA_CHECKPOINT_DOWNLOAD_URL;
  const modalAuthToken = process.env.MODAL_AUTH_TOKEN;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
  }
  if (!modalUrl || !modalAuthToken) {
    return NextResponse.json({ error: "サーバー設定エラーです（Modal未設定）。" }, { status: 500 });
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
    .from("generation_jobs")
    .select("metadata, user_id")
    .eq("id", jobId)
    .maybeSingle()) as {
    data: { metadata: unknown; user_id: string } | null;
    error: { message: string } | null;
  };
  if (error) {
    console.error("[studio/lora/checkpoint/bundle] job lookup failed:", error.message);
    return NextResponse.json({ error: "ジョブの取得に失敗しました。" }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  if (job.user_id !== userId && !isAdmin) {
    return NextResponse.json({ error: "このジョブのダウンロード権限がありません。" }, { status: 403 });
  }
  const ownerId = job.user_id;

  const ckpts = Array.isArray((job.metadata as { checkpoints?: unknown })?.checkpoints)
    ? ((job.metadata as { checkpoints: Record<string, unknown>[] }).checkpoints)
    : [];

  const directUrl = (file: string): string => {
    const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const sig = signCheckpointToken(ownerId, jobId, file, expiresAt, modalAuthToken);
    const t = new URL(modalUrl);
    t.searchParams.set("user_id", ownerId);
    t.searchParams.set("job_id", jobId);
    t.searchParams.set("filename", file);
    t.searchParams.set("expires", String(expiresAt));
    t.searchParams.set("sig", sig);
    return t.toString();
  };

  if (want === "dataset") {
    const ds =
      (ckpts.find((c) => c?.is_caption_archive === true)?.filename as string | undefined) ??
      (ckpts.find((c) => typeof c?.filename === "string" && /^dataset(_salvaged)?\.zip$/.test(c.filename as string))
        ?.filename as string | undefined) ??
      "dataset.zip";
    return NextResponse.json({ downloadUrl: directUrl(ds), mode: "direct" });
  }

  // want === "bundle"
  const bundle =
    (ckpts.find((c) => c?.is_bundle === true)?.filename as string | undefined) ??
    (ckpts.find((c) => c?.filename === "checkpoints_all.zip")?.filename as string | undefined);
  if (bundle && SAFE_NAME_RE.test(bundle)) {
    return NextResponse.json({ downloadUrl: directUrl(bundle), mode: "direct" });
  }

  // Not pre-built — CPU-zip the whole job folder on demand (0 GPU cost).
  try {
    return NextResponse.json({
      downloadUrl: signAdminVolumeUrl("zip", `loras/${ownerId}/${jobId}`),
      mode: "zip",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ZIP URL の生成に失敗しました。" },
      { status: 500 },
    );
  }
}
