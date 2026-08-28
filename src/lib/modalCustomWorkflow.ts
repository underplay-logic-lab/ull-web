import "server-only";
import { DEFAULT_WORKFLOW_GPU_TIER, type WorkflowGpuTier } from "@/lib/customWorkflows";

export type CustomWorkflowFile = { filename: string; base64: string };

export type CustomWorkflowResult = {
  filename: string;
  result_base64: string;
  gpu_tier: string;
  output_path: string;
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
    }),
    signal: AbortSignal.timeout(MODAL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Modal request failed (${res.status}): ${text.slice(0, 2000)}`);
  }

  return (await res.json()) as CustomWorkflowResult;
}
