import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";

export type GenerationLogStatus = "success" | "failed";

export type LogGenerationActivityInput = {
  userId: string;
  jobType: string;
  promptInput?: string | null;
  promptOptimized?: string | null;
  executionTimeMs?: number | null;
  creditsConsumed?: number | null;
  status: GenerationLogStatus;
  errorMessage?: string | null;
  gpuTier?: string | null;
  // Volume-relative path of the output Modal saved to outputs/all/ (7-day
  // retention) — see _save_output_temp in scripts/modal_wan_animate.py.
  // Only set on success; lets the Admin logs UI preview the result.
  outputFileName?: string | null;
};

// Fire-and-forget-friendly: logs the insert error instead of throwing, so a
// logging failure never breaks the generation flow that called it.
export async function logGenerationActivity(input: LogGenerationActivityInput): Promise<void> {
  const { error } = await supabaseAdmin.from("generation_logs").insert({
    user_id: input.userId,
    job_type: input.jobType,
    prompt_input: input.promptInput ?? null,
    prompt_optimized: input.promptOptimized ?? null,
    execution_time_ms: input.executionTimeMs ?? null,
    credits_consumed: input.creditsConsumed ?? null,
    status: input.status,
    error_message: input.errorMessage ?? null,
    gpu_tier: input.gpuTier ?? "standard",
    output_file_name: input.outputFileName ?? "",
  });

  if (error) {
    console.error("[logGenerationActivity] insert failed:", error);
  }
}
