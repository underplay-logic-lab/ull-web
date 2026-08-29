import { supabase } from "@/lib/supabaseClient";
import type { LoraBaseArchitecture } from "@/lib/loraModels";

// A preset id from LORA_PRESETS, or the literal "custom" (universal loader).
export type LoraTargetModel = string;

export type LoraTrainingConfigInput = {
  rank?: number;
  alpha?: number;
  learning_rate?: number;
  steps?: number;
  optimizer?: string;
  custom_yaml_override?: string;
};

export const LORA_DATASET_BUCKET = "lora_datasets";

// Uploads the raw image files straight to Supabase Storage (bypassing
// Vercel's 4.5 MB request body cap) under "<userId>/<datasetId>/NNNN_name".
// The zero-padded index keeps the server-side sort aligned with the caption
// array order. Returns the object paths, in upload order.
export async function uploadLoraDataset(
  userId: string,
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ datasetId: string; paths: string[] }> {
  const datasetId = crypto.randomUUID();
  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "image";
    const path = `${userId}/${datasetId}/${String(i).padStart(4, "0")}_${safe}`;
    const { error } = await supabase.storage
      .from(LORA_DATASET_BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type || "image/png" });
    if (error) throw new Error(`画像のアップロードに失敗しました: ${error.message}`);
    paths.push(path);
    onProgress?.(i + 1, files.length);
  }
  return { datasetId, paths };
}

export type StartLoraTrainingParams = {
  // Supabase Storage object paths (from uploadLoraDataset), in caption order.
  storagePaths: string[];
  captions: string[];
  targetModel: LoraTargetModel;
  // Universal loader — required when targetModel === "custom".
  customModelId?: string;
  baseArchitecture?: LoraBaseArchitecture;
  trainingConfig: LoraTrainingConfigInput;
  // Training resolution (512 / 768 / 1024). Default 768.
  resolution?: number;
  outputLoraName: string;
  triggerWord: string;
};

export type LoraApiError = Error & { remainingCredits?: number; requiredCredits?: number };

export type LoraStartResult = { jobId: string; remainingCredits: number };

export async function startLoraTraining(params: StartLoraTrainingParams): Promise<LoraStartResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const res = await fetch("/api/studio/lora/train", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      storage_paths: params.storagePaths,
      captions: params.captions,
      target_model: params.targetModel,
      custom_model_id: params.customModelId,
      base_architecture: params.baseArchitecture,
      training_config: params.trainingConfig,
      resolution: params.resolution,
      output_lora_name: params.outputLoraName,
      trigger_word: params.triggerWord,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error: LoraApiError = new Error(data?.error || "LoRA学習の開始に失敗しました。");
    if (typeof data?.remainingCredits === "number") error.remainingCredits = data.remainingCredits;
    if (typeof data?.requiredCredits === "number") error.requiredCredits = data.requiredCredits;
    throw error;
  }
  return { jobId: data.jobId as string, remainingCredits: data.remainingCredits as number };
}

export type LoraJobStatus = {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  errorMessage: string | null;
  resultPath: string | null;
  progressPercent: number | null;
  progressMessage: string | null;
  queue:
    | { queuePosition: number; avgExecutionSeconds: number; estimatedWaitSeconds: number }
    | null;
};

export async function pollLoraJob(jobId: string): Promise<LoraJobStatus> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const res = await fetch(`/api/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "ジョブ状態の取得に失敗しました。");

  return {
    jobId: data.jobId as string,
    status: data.status as LoraJobStatus["status"],
    errorMessage: (data.errorMessage as string | null) ?? null,
    resultPath: (data.resultPath as string | null) ?? null,
    progressPercent: (data.progressPercent as number | null) ?? null,
    progressMessage: (data.progressMessage as string | null) ?? null,
    queue:
      typeof data.queuePosition === "number"
        ? {
            queuePosition: data.queuePosition as number,
            avgExecutionSeconds: (data.avgExecutionSeconds as number | undefined) ?? 0,
            estimatedWaitSeconds: (data.estimatedWaitSeconds as number | undefined) ?? 0,
          }
        : null,
  };
}
