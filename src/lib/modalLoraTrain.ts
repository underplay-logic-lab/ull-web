import "server-only";
import type { LoraBaseArchitecture } from "@/lib/loraModels";

export const LORA_DATASET_BUCKET = "lora_datasets";

export type LoraTrainingConfig = {
  rank?: number;
  alpha?: number;
  learning_rate?: number;
  steps?: number;
  optimizer?: string;
  // Fully-manual mode: a raw ai-toolkit job YAML string, or a parsed dict.
  custom_yaml_override?: string | Record<string, unknown>;
};

export type SpawnLoraTrainingParams = {
  jobId: string;
  userId: string;
  creditsCost: number;
  // Supabase Storage object paths in the lora_datasets bucket, caption order.
  storagePaths: string[];
  captions: string[];
  targetModel: string;
  customModelId?: string;
  baseArchitecture?: LoraBaseArchitecture;
  trainingConfig: LoraTrainingConfig;
  resolution?: number;
  outputLoraName: string;
  triggerWord?: string;
};

// How long to wait on the *dispatch* ack — train_lora_dispatch is a GPU-less
// Modal function whose whole body is an auth check + a .spawn(), so it
// resolves near-instantly; this only catches a hung/unreachable endpoint.
const SPAWN_TIMEOUT_MS = 15_000;

// Fire-and-forget: posts to modal_lora_worker.py's train_lora_dispatch,
// which .spawn()s the GPU training job and returns immediately. The spawned
// job PATCHes generation_jobs (status / progress_percent / progress_message
// / result_path) directly via Supabase REST as it runs — this request is
// long gone by then. Throws only if the dispatch itself failed.
export async function spawnLoraTrainingJob(params: SpawnLoraTrainingParams): Promise<void> {
  const url = process.env.MODAL_LORA_TRAIN_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!url) {
    throw new Error("Modal is not configured (missing MODAL_LORA_TRAIN_URL).");
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
      job_id: params.jobId,
      user_id: params.userId,
      credits_cost: params.creditsCost,
      storage_bucket: LORA_DATASET_BUCKET,
      storage_paths: params.storagePaths,
      captions: params.captions,
      target_model: params.targetModel,
      custom_model_id: params.customModelId ?? "",
      base_architecture: params.baseArchitecture ?? "",
      training_config: params.trainingConfig,
      resolution: params.resolution ?? 768,
      output_lora_name: params.outputLoraName,
      trigger_word: params.triggerWord ?? "",
    }),
    signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Modal LoRA dispatch failed (${res.status}): ${text.slice(0, 2000)}`);
  }
}
