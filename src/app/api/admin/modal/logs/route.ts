import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { listActiveJobs, forceClearActiveJob } from "@/lib/activeGenerationJobs";
import { getModalLogs } from "@/lib/modalStorage";
import { WAN_ANIMATE_GPU_SPEC, WAN_ANIMATE_ULTRA_GPU_SPEC } from "@/lib/data";
import type { GpuTier } from "@/lib/gpuTier";

// VRAM figures are the static per-tier hardware spec (see data.ts), not a
// live nvidia-smi reading — Modal doesn't expose a simple way to poll a
// running container's GPU stats from outside, and containers usually aren't
// even running between requests (scaledown_window=2s). Running-job counts
// AND the job list ARE live and accurate, sourced from active_generation_jobs.
export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const [activeJobs, logsResult] = await Promise.all([
    listActiveJobs(),
    getModalLogs(100).catch((err) => {
      console.error("[admin/modal/logs] Modal log fetch failed:", err);
      return null;
    }),
  ]);

  const runningCounts: Record<GpuTier, number> = { standard: 0, ultra: 0 };
  for (const job of activeJobs) {
    if (job.gpu_tier in runningCounts) runningCounts[job.gpu_tier] += 1;
  }

  return NextResponse.json({
    gpuStatus: {
      standard: {
        name: WAN_ANIMATE_GPU_SPEC.name,
        vramGb: WAN_ANIMATE_GPU_SPEC.vramGb,
        runningJobs: runningCounts.standard,
      },
      ultra: {
        name: WAN_ANIMATE_ULTRA_GPU_SPEC.name,
        vramGb: WAN_ANIMATE_ULTRA_GPU_SPEC.vramGb,
        runningJobs: runningCounts.ultra,
      },
    },
    activeJobs,
    comfyLogs: logsResult ?? [],
    comfyLogsUnavailable: logsResult === null,
  });
}

// Clears a stuck active_generation_jobs row (e.g. its owning request crashed
// before reaching its `finally { endActiveJob(...) }`). Does NOT stop the
// underlying Modal GPU job — see forceClearActiveJob's doc comment.
export async function DELETE(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id が指定されていません。" }, { status: 400 });
  }

  const ok = await forceClearActiveJob(id);
  if (!ok) {
    return NextResponse.json({ error: "クリアに失敗しました。" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
