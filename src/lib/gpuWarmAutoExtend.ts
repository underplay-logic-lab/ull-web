import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { WARM_EXTEND_SECONDS } from "@/lib/gpuWarm";

// Free counterpart to the paid "🔥 火をくべる" extend (/api/gpu/warm-extend) —
// called from every generation route's success path so a completed
// generation naturally keeps the shared gpu_warm_status hot for the next
// one, no credits involved. extend_gpu_warm() itself only ever touches the
// warm_until timestamp (see supabase/migrations/20260833000000_create_gpu_warm_status.sql),
// so calling it here with no prior credit debit is safe by construction.
// Never throws — a failure here should never fail the generation response
// that already succeeded.
export async function autoExtendGpuWarmOnSuccess(userId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("extend_gpu_warm", {
    p_user_id: userId,
    p_seconds: WARM_EXTEND_SECONDS,
  });
  if (error) {
    console.error("[gpuWarmAutoExtend] failed to auto-extend warm status:", error.message);
  }
}
