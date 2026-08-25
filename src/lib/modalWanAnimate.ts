import "server-only";
import type { WanAnimateWorkflow } from "@/lib/wanAnimateWorkflow";
import type { GpuTier } from "@/lib/gpuTier";

export type ModalGenerateResult = { filename: string; video_base64: string; output_path: string };

export type ModalGenerateParams = {
  workflow: WanAnimateWorkflow;
  referenceImageB64: string;
  referenceImageName: string;
  poseVideoB64: string;
  poseVideoName: string;
  gpuTier: GpuTier;
  // Persists the output into the Modal Volume (outputs/admin/) in addition
  // to returning it — set only for admin-triggered generations, see
  // /api/wan-animate/generate.
  saveToVolume: boolean;
};

// Cold starts on the deployed Modal endpoint (scaledown_window: 2s means
// nearly every request is a cold container) plus a 6-step sampling pass
// take ~2-3 minutes end to end — comfortably under this ceiling, with room
// for a slow cold start.
const MODAL_TIMEOUT_MS = 280_000;

// Standard (L40S) and ULTRA (B300) are separate Modal classes with separate
// deployed URLs — see WanAnimate / WanAnimateUltra in
// scripts/modal_wan_animate.py.
const MODAL_URL_ENV_BY_TIER: Record<GpuTier, string> = {
  standard: "MODAL_WAN_ANIMATE_URL",
  ultra: "MODAL_WAN_ANIMATE_ULTRA_URL",
};

export async function generateWithModal(params: ModalGenerateParams): Promise<ModalGenerateResult> {
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
      reference_image_b64: params.referenceImageB64,
      reference_image_name: params.referenceImageName,
      pose_video_b64: params.poseVideoB64,
      pose_video_name: params.poseVideoName,
      save_to_volume: params.saveToVolume,
    }),
    signal: AbortSignal.timeout(MODAL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Modal request failed (${res.status}): ${text.slice(0, 2000)}`);
  }

  return (await res.json()) as ModalGenerateResult;
}
