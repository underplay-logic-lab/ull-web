import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { salvageLoraJobRemote } from "@/lib/modalLoraTrain";
import { loraCallIdOf, loraDatasetIdOf, loraOutputNameOf } from "@/lib/loraJobHealth";

// Rescues whatever a dead / cancelled LoRA training run left on the Volume —
// intermediate .safetensors that vol.commit() kept alive through the SIGKILL,
// plus the persisted dataset captions. The Modal worker copies them into the
// canonical per-job folder loras/<user_id>/<job_id>/ and returns a checkpoint
// list; this route merges that list into generation_jobs.metadata.checkpoints
// so the existing signed-URL download path (/api/studio/lora/checkpoint)
// serves them unchanged.
export const maxDuration = 120;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const authHeader = request.headers.get("authorization");
    const accessToken = authHeader?.replace(/^Bearer\s+/i, "");
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
    const user = userData.user;

    const body = await request.json().catch(() => null);
    const jobId = typeof body?.jobId === "string" ? body.jobId : "";
    if (!jobId) return NextResponse.json({ error: "jobId が必要です。" }, { status: 400 });

    const { data: job, error: jobErr } = await supabaseAdmin
      .from("generation_jobs")
      .select("*")
      .eq("id", jobId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (jobErr) {
      return NextResponse.json(
        { error: "ジョブの取得に失敗しました。", reason: jobErr.message },
        { status: 500 },
      );
    }
    if (!job) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });

    const jobRow = job as Record<string, unknown>;
    const modalCallId = loraCallIdOf(jobRow);
    const datasetId = loraDatasetIdOf(jobRow);
    const outputLoraName = loraOutputNameOf(jobRow);

    let result: Awaited<ReturnType<typeof salvageLoraJobRemote>>;
    try {
      result = await salvageLoraJobRemote({
        userId: user.id,
        jobId,
        modalCallId,
        datasetId,
        outputLoraName,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[studio/lora/salvage] modal call failed:", message);
      return NextResponse.json(
        { error: "救出処理に失敗しました。", reason: message },
        { status: 502 },
      );
    }

    // Merge the salvaged artifacts into metadata.checkpoints (dedup by
    // filename) so /api/studio/lora/checkpoint recognises them.
    const existingMeta =
      jobRow.metadata && typeof jobRow.metadata === "object"
        ? (jobRow.metadata as Record<string, unknown>)
        : {};
    const existingCkpts = Array.isArray(existingMeta.checkpoints)
      ? (existingMeta.checkpoints as Record<string, unknown>[])
      : [];
    const newHasArchive = result.checkpoints.some((c) => c.is_caption_archive);
    const byName = new Map<string, Record<string, unknown>>();
    for (const c of existingCkpts) {
      if (typeof c.filename !== "string") continue;
      // A fresh run supersedes any earlier salvage archive (e.g. the old
      // captions_salvaged.zip -> dataset_salvaged.zip rename).
      if (newHasArchive && c.is_caption_archive === true && c.salvaged === true) continue;
      byName.set(c.filename, c);
    }
    for (const c of result.checkpoints) {
      byName.set(c.filename, c as unknown as Record<string, unknown>);
    }
    const mergedCkpts = [...byName.values()];

    const { error: metaErr } = await supabaseAdmin
      .from("generation_jobs")
      .update({
        metadata: { ...existingMeta, checkpoints: mergedCkpts, salvaged: true },
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    if (metaErr) {
      // A DB behind on the metadata migration — the download path needs that
      // column, so surface it rather than pretending it worked.
      console.error("[studio/lora/salvage] metadata update failed:", metaErr.message);
      return NextResponse.json(
        { error: "救出データの登録に失敗しました。", reason: metaErr.message },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: result.ok,
      salvaged: result.salvaged,
      captionFiles: result.captionFiles,
      imageFiles: result.imageFiles,
      checkpoints: result.checkpoints,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[studio/lora/salvage] unhandled:", message);
    return NextResponse.json(
      { error: "救出処理に失敗しました。", reason: message },
      { status: 500 },
    );
  }
}
