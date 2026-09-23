import "server-only";
import { DEFAULT_WORKFLOW_GPU_TIER, type WorkflowGpuTier } from "@/lib/customWorkflows";

export type CustomWorkflowFile = { filename: string; base64: string };

export type CustomWorkflowResult = {
  filename: string;
  result_base64: string;
  gpu_tier: string;
  output_path: string;
  /** 生成完了時点の実効 VRAM 消費量（GB）。ネタバレ防止 — 分母・％・GPU名なし。
   *  worker 未デプロイ／CUDA 無しなら欠落 or null。 */
  vram_used_gb?: number | null;
  /** custom_workflow_results/<user_id>/<job_id>.<ext> のVolume相対パス
   *  （2026-09-18導入、CLAUDE.md §1）。userId/jobIdを渡さなかった場合や
   *  保存に失敗した場合は null。 */
  result_volume_path?: string | null;
  /** 2026-09-23〜（R2 移行 計画 3）: worker が R2 へ直接置けたときはそのキー
   *  （= result_volume_path と同じ相対パス）。Volume に落ちたときは null。 */
  result_r2_key?: string | null;
};

export type CustomWorkflowExecConfig = {
  disable_smart_memory: boolean;
  cpu_vae: boolean;
  gpu_only: boolean;
  use_pytorch_cross_attention: boolean;
  high_vram: boolean;
  extra_args: string;
};

export type RunCustomWorkflowParams = {
  workflow: Record<string, unknown>;
  files: CustomWorkflowFile[];
  execConfig: CustomWorkflowExecConfig;
  // Persists the output into the Modal Volume (outputs/admin/) in addition
  // to returning it — set only for admin-triggered generations, see
  // /api/studio/custom-workflows/generate.
  saveToVolume: boolean;
  // Node id in the graph to read the final output from — "" means
  // auto-detect (see run_custom_workflow in scripts/modal_wan_animate.py).
  outputNodeId: string;
  // The Modal GPU to run this workflow on: the workflow's saved
  // default_gpu_tier, or a user-form override if the workflow exposes one.
  // Forwarded to Modal as `gpu_tier`.
  gpuTier?: WorkflowGpuTier;
  // Priority-ordered GPU fallback chain (the primary tier first, then the
  // workflow's configured fallbacks). Forwarded to Modal as
  // `gpu_fallback_list` so its scheduler can hop past a congested GPU.
  gpuFallbackChain?: WorkflowGpuTier[];
  /** custom_workflow_results/<user_id>/<job_id>.<ext> への直接保存
   *  （2026-09-18導入、CLAUDE.md §1）に使う id。両方渡すと Modal が同じ
   *  同期呼び出しの中でVolumeへ保存し、CustomWorkflowResult.result_volume_path
   *  にそのパスを返す。 */
  userId?: string;
  jobId?: string;
};

// Same cold-start budget as generateWithModal (modalWanAnimate.ts) — a
// custom workflow's inference time varies by graph, but the container
// spin-up + model load overhead is identical.
const MODAL_TIMEOUT_MS = 280_000;

// A single custom-workflow endpoint now — the old Standard/ULTRA URL split
// is gone. The GPU is selected per workflow via `gpu_tier` in the body
// (studio_custom_workflows.default_gpu_tier, see the generate route), which
// Modal reads to place the container.
export async function runCustomWorkflowOnModal(params: RunCustomWorkflowParams): Promise<CustomWorkflowResult> {
  const url = process.env.MODAL_CUSTOM_WORKFLOW_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!url) {
    throw new Error("Modal is not configured (missing MODAL_CUSTOM_WORKFLOW_URL).");
  }
  if (!authToken) {
    throw new Error("Modal is not configured (missing MODAL_AUTH_TOKEN).");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-modal-secret": authToken,
    },
    body: JSON.stringify({
      workflow_json: JSON.stringify(params.workflow),
      files_b64: Object.fromEntries(params.files.map((f) => [f.filename, f.base64])),
      exec_config: params.execConfig,
      save_to_volume: params.saveToVolume,
      output_node_id: params.outputNodeId,
      gpu_tier: params.gpuTier ?? DEFAULT_WORKFLOW_GPU_TIER,
      gpu_fallback_list:
        params.gpuFallbackChain && params.gpuFallbackChain.length > 0
          ? params.gpuFallbackChain
          : [params.gpuTier ?? DEFAULT_WORKFLOW_GPU_TIER],
      user_id: params.userId,
      job_id: params.jobId,
    }),
    signal: AbortSignal.timeout(MODAL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Modal request failed (${res.status}): ${text.slice(0, 2000)}`);
  }

  return (await res.json()) as CustomWorkflowResult;
}
