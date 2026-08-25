import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { GpuTier } from "@/lib/gpuTier";

// Tracks in-flight generations so the admin "GPU task manager" (see
// /api/admin/modal/logs) can show an accurate running-job count per tier.
// A row is inserted right before the Modal call and always removed in a
// finally block afterwards — see /api/wan-animate/generate.

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

export type ActiveJob = {
  id: string;
  user_id: string;
  user_email: string | null;
  job_type: string;
  gpu_tier: GpuTier;
  started_at: string;
};

// Full active-job rows (not just per-tier counts) for the admin GPU task
// manager's job list — see GpuTaskManager in LogsTab.tsx.
export async function listActiveJobs(): Promise<ActiveJob[]> {
  const { data, error } = await supabaseAdmin
    .from("active_generation_jobs")
    .select("id, user_id, job_type, gpu_tier, started_at")
    .order("started_at", { ascending: true });

  if (error) {
    console.error("[activeGenerationJobs] failed to list active jobs:", error.message);
    return [];
  }

  const rows = data ?? [];

  // active_generation_jobs.user_id references auth.users(id), not
  // public.profiles — no FK for PostgREST to embed, so resolve emails with a
  // second query, same pattern as /api/admin/logs.
  const userIds = Array.from(new Set(rows.map((row) => row.user_id as string)));
  const emailByUserId = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profileRows, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("id, email")
      .in("id", userIds);
    if (profileError) {
      console.error("[activeGenerationJobs] profile email lookup failed:", profileError.message);
    } else {
      for (const row of profileRows ?? []) {
        emailByUserId.set(row.id as string, row.email as string);
      }
    }
  }

  return rows.map((row) => ({
    id: row.id as string,
    user_id: row.user_id as string,
    user_email: emailByUserId.get(row.user_id as string) ?? null,
    job_type: row.job_type as string,
    gpu_tier: row.gpu_tier as GpuTier,
    started_at: row.started_at as string,
  }));
}

// Deletes the bookkeeping row only — this does NOT stop the underlying
// Modal GPU job (there is no mechanism wired up to actually cancel an
// in-flight Modal request from here). It exists purely to let an admin
// clear a row that got stuck because its owning request crashed before
// reaching the `finally { endActiveJob(...) }` that normally removes it.
export async function forceClearActiveJob(id: string): Promise<boolean> {
  const { error } = await supabaseAdmin.from("active_generation_jobs").delete().eq("id", id);
  if (error) {
    console.error("[activeGenerationJobs] failed to force-clear active job:", error.message);
    return false;
  }
  return true;
}
