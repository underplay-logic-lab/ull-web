import "server-only";

import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 起動した Modal の実行（FunctionCall）の id をジョブ行に残す（2026-09-29、ホスト「停止ボタンを全般に」）。
// admin の中止ボタンが Modal 側の実行まで止められるようにするため（cancelLoraTrainingCall は workspace 共通の
// FunctionCall.from_id().cancel() なので、どのワーカーの id でも止まる）。
// - angle_jobs / upscale_jobs: metadata.modal_call_id（ワーカーは metadata を GET→merge で書くので消えない）
// - generation_jobs（Director 等）: modal_call_id 列（Director のワーカーは生成中に metadata を丸ごと上書きするため）
// どれも best-effort。失敗しても生成は止めない。

async function mergeMetadata(table: "angle_jobs" | "upscale_jobs", ids: string[], callId: string): Promise<void> {
  for (const id of ids) {
    const { data } = await supabaseAdmin.from(table).select("metadata").eq("id", id).maybeSingle();
    const meta = (data?.metadata as Record<string, unknown> | null) ?? {};
    const { error } = await supabaseAdmin
      .from(table)
      .update({ metadata: { ...meta, modal_call_id: callId } })
      .eq("id", id);
    if (error) console.warn(`[modalCallRecord] ${table} ${id}:`, error.message);
  }
}

export async function rememberAngleCall(jobId: string, callId: string | null): Promise<void> {
  if (!callId) return;
  try {
    await mergeMetadata("angle_jobs", [jobId], callId);
  } catch (err) {
    console.warn("[modalCallRecord] angle failed:", err);
  }
}

export async function rememberUpscaleCall(target: { jobId?: string; batchId?: string }, callId: string | null): Promise<void> {
  if (!callId) return;
  try {
    let ids: string[] = target.jobId ? [target.jobId] : [];
    if (target.batchId) {
      const { data } = await supabaseAdmin.from("upscale_jobs").select("id").eq("batch_id", target.batchId);
      ids = (data ?? []).map((r) => r.id as string);
    }
    await mergeMetadata("upscale_jobs", ids, callId);
  } catch (err) {
    console.warn("[modalCallRecord] upscale failed:", err);
  }
}

export async function rememberGenerationCall(jobId: string, callId: string | null): Promise<void> {
  if (!callId) return;
  try {
    const { error } = await supabaseAdmin.from("generation_jobs").update({ modal_call_id: callId }).eq("id", jobId);
    if (error) console.warn(`[modalCallRecord] generation_jobs ${jobId}:`, error.message);
  } catch (err) {
    console.warn("[modalCallRecord] generation failed:", err);
  }
}
