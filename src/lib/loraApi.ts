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
  const datasetId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "image";
    const path = `${userId}/${datasetId}/${String(i).padStart(4, "0")}_${safe}`;
    let uploadError: unknown = null;
    try {
      const { error } = await supabase.storage
        .from(LORA_DATASET_BUCKET)
        .upload(path, file, { upsert: true, contentType: file.type || "image/png" });
      uploadError = error;
    } catch (thrown) {
      uploadError = thrown;
    }
    if (uploadError) {
      const detail = uploadError instanceof Error ? uploadError.message : String(uploadError);
      // Stop on the very first failure — the caller must not proceed to
      // /api/studio/lora/train with a partial dataset.
      throw new Error(`${file.name}（${i + 1}/${files.length} 枚目）: ${detail}`);
    }
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
    const reason =
      typeof data?.reason === "string"
        ? data.reason
        : data?.details && typeof data.details === "object" && typeof data.details.message === "string"
          ? data.details.message
          : typeof data?.details === "string"
            ? data.details
            : "";
    const base = data?.error || "LoRA学習の開始に失敗しました。";
    const error: LoraApiError = new Error(reason ? `${base}（${reason}）` : base);
    if (typeof data?.remainingCredits === "number") error.remainingCredits = data.remainingCredits;
    if (typeof data?.requiredCredits === "number") error.requiredCredits = data.requiredCredits;
    throw error;
  }
  return { jobId: data.jobId as string, remainingCredits: data.remainingCredits as number };
}

export type LoraJobStatus = {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled" | "failed_timeout";
  errorMessage: string | null;
  resultPath: string | null;
  progressPercent: number | null;
  progressMessage: string | null;
  retryCount: number;
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
    retryCount: (data.retryCount as number | undefined) ?? 0,
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

export type LoraRecoverResult = {
  ok: boolean;
  status?: string;
  jobId?: string; // set when a retry produced a fresh job to poll
  retryCount?: number;
  refunded?: number; // credits returned when it escalated to failed_timeout
  modalCancelled?: boolean; // whether Modal confirmed the physical .cancel()
  noop?: boolean;
};

// Pending-timeout auto-failover: cancels the stuck Modal call, then either
// re-dispatches the same job onto another node (action "retry") or closes
// it as failed_timeout with a 100% refund (action "timeout", or when the
// retry cap is hit server-side).
export async function recoverLoraJob(
  jobId: string,
  action: "retry" | "timeout",
): Promise<LoraRecoverResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const res = await fetch("/api/studio/lora/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jobId, action }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || data?.reason || "リカバリに失敗しました。");
  return data as LoraRecoverResult;
}
