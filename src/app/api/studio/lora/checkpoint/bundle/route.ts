import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { signJobArtifactUrl } from "@/lib/modalStorage";
import { loraCallIdOf } from "@/lib/loraJobHealth";

// Smart one-shot artefact download for a finished LoRA job — no salvage
// round-trip. The Modal endpoint (admin_download_job_artifact) recursively
// resolves the ACTUAL file wherever it landed (loras/<user>/<job_id>/ or
// /<call_id>/, salvaged_ prefixes, …):
//   want=final   -> *final*.safetensors, else highest *step*, else any
//   want=bundle  -> checkpoints_all.zip / *checkpoint*.zip, else zip on demand
//   want=dataset -> dataset*.zip / caption*.zip
// This route does the owner-OR-admin check, then a `probe` call so a genuine
// miss is a 404 JSON (visible toast) rather than a silent iframe 404.
export const maxDuration = 30;

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId") ?? "";
  const wantRaw = url.searchParams.get("want") ?? "bundle";
  const want: "final" | "bundle" | "dataset" =
    wantRaw === "final" || wantRaw === "dataset" ? wantRaw : "bundle";
  if (!jobId) return NextResponse.json({ error: "jobId が必要です。" }, { status: 400 });

  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!accessToken) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });

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
    .from("generation_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle()) as { data: Record<string, unknown> | null; error: { message: string } | null };
  if (error) {
    console.error("[studio/lora/checkpoint/bundle] job lookup failed:", error.message);
    return NextResponse.json({ error: "ジョブの取得に失敗しました。" }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  if (job.user_id !== userId && !isAdmin) {
    return NextResponse.json({ error: "このジョブのダウンロード権限がありません。" }, { status: 403 });
  }
  const ownerId = job.user_id as string;
  const callId = loraCallIdOf(job as never);

  try {
    // 1) probe — did the worker actually leave this artefact anywhere?
    const probeUrl = signJobArtifactUrl(want, ownerId, jobId, { callId, probe: true });
    const pr = await fetch(probeUrl, { cache: "no-store", signal: AbortSignal.timeout(25_000) });
    const probe = (await pr.json().catch(() => ({}))) as {
      found?: boolean;
      filename?: string;
      size_bytes?: number;
    };
    if (!pr.ok || probe.found !== true) {
      return NextResponse.json(
        {
          error:
            want === "final"
              ? "完成版・中間チェックポイントが見つかりませんでした。"
              : want === "dataset"
                ? "データセット ZIP が見つかりませんでした。"
                : "ダウンロード対象が見つかりません。",
        },
        { status: 404 },
      );
    }
    // 2) hand back the streaming URL (same endpoint, no probe flag).
    return NextResponse.json({
      downloadUrl: signJobArtifactUrl(want, ownerId, jobId, { callId }),
      filename: probe.filename ?? null,
      sizeBytes: probe.size_bytes ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ダウンロードURLの生成に失敗しました。" },
      { status: 502 },
    );
  }
}
