import { supabase } from "@/lib/supabaseClient";

export type LoraTargetModel = "minimax_h3" | "wan2_1" | "flux_schnell" | "sdxl";

export type LoraTrainingConfigInput = {
  rank?: number;
  alpha?: number;
  learning_rate?: number;
  steps?: number;
  optimizer?: string;
  custom_yaml_override?: string;
};

export type StartLoraTrainingParams = {
  images: { filename: string; data: string }[];
  captions: string[];
  targetModel: LoraTargetModel;
  trainingConfig: LoraTrainingConfigInput;
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
      images: params.images,
      captions: params.captions,
      target_model: params.targetModel,
      training_config: params.trainingConfig,
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

// Reads a file as a bare base64 string (no data: prefix) for the training payload.
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
