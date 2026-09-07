import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { GpuTier } from "@/lib/gpuTier";

// Tracks in-flight generations: a row is inserted right before the Modal
// call and always removed in a finally block afterwards (see
// /api/wan-animate/generate). Originally fed the admin "リアルタイムGPU
// タスクマネージャー", which was removed 2026-09-08 — nothing reads these
// rows now, so startActiveJob/endActiveJob are vestigial bookkeeping kept
// only to avoid touching the (pricing-knobs-entangled) generate routes.
// Safe to strip along with their call sites in a later cleanup.

export async function startActiveJob(
  userId: string,
  jobType: string,
  gpuTier: GpuTier,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("active_generation_jobs")
    .insert({ user_id: userId, job_type: jobType, gpu_tier: gpuTier })
    .select("id")
    .single();

  if (error) {
    console.error("[activeGenerationJobs] failed to record active job:", error.message);
    return null;
  }
  return data.id as string;
}

export async function endActiveJob(id: string | null): Promise<void> {
  if (!id) return;
  const { error } = await supabaseAdmin.from("active_generation_jobs").delete().eq("id", id);
  if (error) {
    console.error("[activeGenerationJobs] failed to clear active job:", error.message);
  }
}
