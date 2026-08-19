import "server-only";
import type { AspectRatio } from "@/lib/data";

const RUNPOD_BASE_URL = "https://api.runpod.ai/v2";

// FLUX latents are 16-channel and want dimensions that are multiples of 16.
const RATIO_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768, height: 1344 },
};

const DEFAULT_CHECKPOINT = "flux1-dev-fp8.safetensors";
const FLUX_GUIDANCE = 3.5;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildComfyWorkflow(prompt: string, ratio: AspectRatio) {
  const { width, height } = RATIO_DIMENSIONS[ratio];
  const checkpoint = process.env.RUNPOD_COMFYUI_CHECKPOINT || DEFAULT_CHECKPOINT;
  const seed = Math.floor(Math.random() * 2 ** 32);

  // FLUX.1-dev API-format graph (ComfyUI's official Flux template), for the
  // deployed worker-comfyui endpoint whose checkpoint list is
  // ["flux1-dev-fp8.safetensors"]. FLUX differs from SDXL in a few load-
  // bearing ways: there is no negative prompt (an empty/zeroed conditioning
  // is fed to KSampler's "negative" input instead), guidance is applied via
  // a dedicated FluxGuidance node rather than CFG (cfg stays at 1.0), and
  // the latent must come from EmptySD3LatentImage (16 channels) rather than
  // EmptyLatentImage (4 channels, SD1.5/SDXL only).
  return {
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: checkpoint },
    },
    "5": {
      class_type: "EmptySD3LatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["4", 1] },
    },
    "7": {
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: ["6", 0] },
    },
    "26": {
      class_type: "FluxGuidance",
      inputs: { conditioning: ["6", 0], guidance: FLUX_GUIDANCE },
    },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: 20,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
        model: ["4", 0],
        positive: ["26", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "underplay", images: ["8", 0] },
    },
  };
}

type RunpodJobResult = {
  id?: string;
  status?: string;
  output?: unknown;
  error?: string;
};

async function runpodFetch(path: string, init?: RequestInit) {
  const endpointId = process.env.RUNPOD_ENDPOINT_ID;
  const apiKey = process.env.RUNPOD_API_KEY;

  if (!endpointId || !apiKey) {
    throw new Error("RunPod is not configured (missing endpoint id or API key).");
  }

  return fetch(`${RUNPOD_BASE_URL}/${endpointId}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(init?.headers ?? {}),
    },
  });
}

async function pollJobStatus(jobId: string): Promise<RunpodJobResult> {
  const pollIntervalMs = 3000;
  const maxAttempts = 60; // ~3 minutes of polling on top of the runsync wait

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(pollIntervalMs);

    const res = await runpodFetch(`/status/${jobId}`);
    if (!res.ok) {
      throw new Error(`RunPod status check failed (${res.status}).`);
    }

    const data = (await res.json()) as RunpodJobResult;
    if (data.status === "COMPLETED" || data.status === "FAILED") {
      return data;
    }
  }

  throw new Error("RunPod job timed out while waiting for GPU output.");
}

function extractImageDataUrl(output: unknown): string {
  const asRecord = (value: unknown) =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

  const record = asRecord(output);
  const images = record?.images;

  if (Array.isArray(images) && images.length > 0) {
    const first = asRecord(images[0]);
    if (first) {
      if (typeof first.data === "string") {
        const mime = typeof first.type === "string" && first.type.includes("/")
          ? first.type
          : "image/png";
        return first.data.startsWith("data:") ? first.data : `data:${mime};base64,${first.data}`;
      }
      if (typeof first.url === "string") {
        return first.url;
      }
    }
  }

  if (typeof record?.image === "string") {
    const value = record.image;
    return value.startsWith("data:") || value.startsWith("http")
      ? value
      : `data:image/png;base64,${value}`;
  }

  if (typeof record?.message === "string" && record.message.length > 0) {
    const value = record.message;
    return value.startsWith("data:") || value.startsWith("http")
      ? value
      : `data:image/png;base64,${value}`;
  }

  throw new Error("RunPod output did not contain a recognizable image.");
}

export async function generateImageWithRunpod(
  prompt: string,
  ratio: AspectRatio,
): Promise<string> {
  const workflow = buildComfyWorkflow(prompt, ratio);

  const runRes = await runpodFetch("/runsync", {
    method: "POST",
    body: JSON.stringify({ input: { workflow } }),
  });

  if (!runRes.ok) {
    const text = await runRes.text().catch(() => "");
    throw new Error(`RunPod request failed (${runRes.status}): ${text}`);
  }

  let result = (await runRes.json()) as RunpodJobResult;

  if (result.status === "IN_QUEUE" || result.status === "IN_PROGRESS") {
    if (!result.id) {
      throw new Error("RunPod did not return a job id to poll.");
    }
    result = await pollJobStatus(result.id);
  }

  if (result.status !== "COMPLETED") {
    throw new Error(result.error || `RunPod job did not complete (status: ${result.status}).`);
  }

  return extractImageDataUrl(result.output);
}
