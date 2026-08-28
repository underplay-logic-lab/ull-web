import "server-only";
import type { GpuTier } from "@/lib/gpuTier";
import { DEFAULT_WORKFLOW_GPU_TIER, type WorkflowGpuTier } from "@/lib/customWorkflows";

export type CustomWorkflowFile = { filename: string; base64: string };

export type CustomWorkflowResult = {
  filename: string;
  result_base64: string;
  gpu_tier: GpuTier;
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
  gpuTier: GpuTier;
  execConfig: CustomWorkflowExecConfig;
  // Persists the output into the Modal Volume (outputs/admin/) in addition
  // to returning it — set only for admin-triggered generations, see
  // /api/studio/custom-workflows/generate.
  saveToVolume: boolean;
  // Node id in the graph to read the final output from — "" means
  // auto-detect (see run_custom_workflow in scripts/modal_wan_animate.py).
  outputNodeId: string;
  // The Modal GPU the admin picked for this workflow (studio_custom_workflows
  // .default_gpu_tier). Forwarded to Modal as `gpu_tier`.
  defaultGpuTier?: WorkflowGpuTier;
};

// Same cold-start budget as generateWithModal (modalWanAnimate.ts) — a
// custom workflow's inference time varies by graph, but the container
// spin-up + model load overhead is identical.
const MODAL_TIMEOUT_MS = 280_000;

// Reuses the WanAnimate / WanAnimateUltra Modal classes' `custom_workflow`
// endpoint (see scripts/modal_wan_animate.py) — same containers, models
// volume, and GPU tier split as Wan Animate 2, just a different entrypoint
// method that accepts an arbitrary ComfyUI graph instead of the fixed
// reference-image/pose-video shape.
const MODAL_URL_ENV_BY_TIER: Record<GpuTier, string> = {
  standard: "MODAL_CUSTOM_WORKFLOW_URL",
  ultra: "MODAL_CUSTOM_WORKFLOW_ULTRA_URL",
};

export async function runCustomWorkflowOnModal(params: RunCustomWorkflowParams): Promise<CustomWorkflowResult> {
  const urlEnvName = MODAL_URL_ENV_BY_TIER[params.gpuTier];
  const url = process.env[urlEnvName];
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!url) {
    throw new Error(`Modal is not configured (missing ${urlEnvName}).`);
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
      gpu_tier: params.defaultGpuTier ?? DEFAULT_WORKFLOW_GPU_TIER,
    }),
    signal: AbortSignal.timeout(MODAL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Modal request failed (${res.status}): ${text.slice(0, 2000)}`);
  }

  return (await res.json()) as CustomWorkflowResult;
}
