import { supabase } from "@/lib/supabaseClient";
import type { LoraBaseArchitecture } from "@/lib/loraModels";
import type { LoraCaptionSpec } from "@/lib/loraCaptionSpec";

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
  // Set when the user supplied their own captions (semi-auto edits, or a
  // .txt set): the worker then skips loading the 27B caption VLM entirely.
  customCaptions?: string[];
  skipCaptioning?: boolean;
  // The user's own instruction for the auto-caption VLM (category preset or
  // free-text). Empty / omitted -> the worker's default character prompt.
  captionPrompt?: string;
  // The structured LoRA-type spec (人物 / 画風 / 物質 / 風景 ＋ 固定/変化させ
  // たい特徴の日本語). The server rebuilds captionPrompt from this when the
  // browser didn't send a generated one.
  captionSpec?: LoraCaptionSpec;
};

export type LoraApiError = Error & { remainingCredits?: number; requiredCredits?: number };

export type LoraStartResult = { jobId: string; remainingCredits: number; modalCallId: string | null };

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
      custom_captions: params.customCaptions,
      skip_captioning: params.skipCaptioning,
      caption_prompt: params.captionPrompt,
      caption_spec: params.captionSpec,
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
  return {
    jobId: data.jobId as string,
    remainingCredits: data.remainingCredits as number,
    modalCallId: (data.modalCallId as string | null) ?? null,
  };
}

export type LoraCheckpoint = {
  step: number;
  filename: string;
  sizeBytes: number;
  isFinal: boolean;
  // true for the dataset bundle (training images + their .txt captions;
  // older jobs: captions-only captions.zip) — shown as its own download
  // button, not in the intermediate-checkpoint list.
  isCaptionArchive: boolean;
  // true for checkpoints_all.zip — every .safetensors checkpoint in one
  // archive. Its own "download all" button, not in the per-step list.
  isBundle: boolean;
};

export type LoraJobStatus = {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled" | "failed_timeout";
  errorMessage: string | null;
  resultPath: string | null;
  progressPercent: number | null;
  progressMessage: string | null;
  retryCount: number;
  // Live effective VRAM load (GB) — spoiler-free, no total / GPU model.
  vramUsedGb: number | null;
  // Live Stage-2 (ai-toolkit) training telemetry, parsed from tqdm output.
  // null until the trainer's progress bar starts emitting.
  currentStep: number | null;
  totalSteps: number | null;
  etaSeconds: number | null;
  loss: number | null;
  // Ring buffer of the ~40 most recent worker stdout/stderr lines (each
  // "HH:MM:SS  message"), for the collapsible Live Terminal. null on older
  // jobs / before the trainer starts emitting.
  logs: string[] | null;
  // Intermediate + final LoRA checkpoints, available once completed.
  checkpoints: LoraCheckpoint[];
  // On a 'failed' job: whether the consumed credits were refunded. null when
  // unknown (older jobs / column absent). Raw-YAML config errors are NOT
  // refunded (platform-defence policy), standard GUI-mode faults are.
  refunded: boolean | null;
  customYaml: boolean;
  // The system stopped the run early to protect cost (prep deadlock, or the
  // projected time would exceed what the paid credits cover). Always refunded.
  safetyStop: boolean;
  safetyKind: "cost" | "prep" | null;
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

  const meta = (data.metadata ?? {}) as {
    vram_used_gb?: unknown;
    checkpoints?: unknown;
    refunded?: unknown;
    custom_yaml?: unknown;
    safety_stop?: unknown;
    safety_kind?: unknown;
    current_step?: unknown;
    total_steps?: unknown;
    eta_seconds?: unknown;
    loss?: unknown;
    logs?: unknown;
  };
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const logs: string[] | null = Array.isArray(meta.logs)
    ? (meta.logs as unknown[]).filter((l): l is string => typeof l === "string").slice(-60)
    : null;
  const checkpoints: LoraCheckpoint[] = Array.isArray(meta.checkpoints)
    ? (meta.checkpoints as Record<string, unknown>[])
        .map((c) => ({
          step: typeof c.step === "number" ? c.step : 0,
          filename: typeof c.filename === "string" ? c.filename : "",
          sizeBytes: typeof c.size_bytes === "number" ? c.size_bytes : 0,
          isFinal: c.is_final === true,
          isCaptionArchive: c.is_caption_archive === true,
          isBundle: c.is_bundle === true,
        }))
        .filter((c) => c.filename)
    : [];

  return {
    jobId: data.jobId as string,
    status: data.status as LoraJobStatus["status"],
    errorMessage: (data.errorMessage as string | null) ?? null,
    resultPath: (data.resultPath as string | null) ?? null,
    progressPercent: (data.progressPercent as number | null) ?? null,
    progressMessage: (data.progressMessage as string | null) ?? null,
    retryCount: (data.retryCount as number | undefined) ?? 0,
    vramUsedGb: num(meta.vram_used_gb),
    currentStep: num(meta.current_step),
    totalSteps: num(meta.total_steps),
    etaSeconds: num(meta.eta_seconds),
    loss: num(meta.loss),
    logs,
    checkpoints,
    refunded: typeof meta.refunded === "boolean" ? meta.refunded : null,
    customYaml: meta.custom_yaml === true,
    safetyStop: meta.safety_stop === true,
    safetyKind:
      meta.safety_kind === "cost" || meta.safety_kind === "prep" ? meta.safety_kind : null,
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

// Asks /api/studio/lora/checkpoint (bearer-auth'd) for a short-lived signed
// Modal URL, then navigates the browser straight to it — the actual bytes
// flow browser<->Modal directly (Content-Disposition: attachment on
// Modal's FileResponse makes the cross-origin nav download rather than
// navigate), not through this app's server. A prior version fetched the
// file here and re-served it as a blob: fine for small assets, but a
// 600MB+ checkpoint doubles every byte's hop count and was timing out
// (NGHTTP2_INTERNAL_ERROR) partway through the transfer.
// Asks /api/studio/lora/checkpoint (bearer-auth'd) for the short-lived
// signed Modal URL and returns it — used by both the direct-download button
// and the "copy URL for the Model Downloader" button. The link is valid for
// ~15 minutes and the bytes flow browser<->Modal directly (one hop).
export async function getLoraCheckpointDownloadUrl(jobId: string, filename: string): Promise<string> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const res = await fetch(
    `/api/studio/lora/checkpoint?jobId=${encodeURIComponent(jobId)}&file=${encodeURIComponent(filename)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data?.downloadUrl !== "string") {
    throw new Error(data?.error || "ダウンロードURLの取得に失敗しました。");
  }
  return data.downloadUrl as string;
}

export async function downloadLoraCheckpoint(jobId: string, filename: string): Promise<void> {
  const downloadUrl = await getLoraCheckpointDownloadUrl(jobId, filename);
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export type LoraRecoverResult = {
  ok: boolean;
  status?: string;
  jobId?: string; // set when a retry produced a fresh job to poll
  retryCount?: number;
  refunded?: number; // credits returned when it escalated to failed_timeout
  modalCancelled?: boolean; // whether Modal confirmed the physical .cancel()
  customYaml?: boolean; // true -> raw-YAML job, credits NOT refunded
  noop?: boolean;
};

// Ends a stuck / unwanted job: physically cancels the Modal call (terminating
// its GPU container) and 100%-refunds the cost. "abort" also reaches a job
// that's already 'processing' (-> 'cancelled'); "timeout" -> 'failed_timeout'.
//
// NOT wired to any user-facing UI — the LoRA Studio screen is monitor-only.
// Kept for admin / internal / manual recovery use (call the /api/studio/lora
// /recover route directly, or from a future admin panel).
export async function recoverLoraJob(
  jobId: string,
  action: "timeout" | "abort",
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

export type RecentLoraJob = {
  jobId: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
};

// The user's most recent LoRA Studio job — used to re-attach after the
// localStorage pointer was lost. Returns null when they've never run one.
export async function fetchRecentLoraJob(): Promise<RecentLoraJob | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) return null;

  const res = await fetch("/api/studio/lora/recent", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const job = data?.job;
  return job && typeof job.jobId === "string" ? (job as RecentLoraJob) : null;
}

export type LoraSalvageResult = {
  ok: boolean;
  // Number of .safetensors recovered (excludes the dataset archive).
  salvaged: number;
  // Files bundled into dataset_salvaged.zip.
  captionFiles: number;
  imageFiles: number;
  // Recovered artifacts — download via downloadLoraCheckpoint / the signed
  // URL, exactly like a completed job's checkpoints.
  checkpoints: LoraCheckpoint[];
};

// Asks the salvage API to scan the Volume for whatever a failed / cancelled
// job left behind (intermediate weights + persisted captions) and register
// them for download. Safe to call more than once — it's idempotent.
export async function salvageLoraJob(jobId: string): Promise<LoraSalvageResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const res = await fetch("/api/studio/lora/salvage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jobId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || data?.reason || "救出処理に失敗しました。");

  const rawCkpts = Array.isArray(data.checkpoints)
    ? (data.checkpoints as Record<string, unknown>[])
    : [];
  const checkpoints: LoraCheckpoint[] = rawCkpts
    .map((c) => ({
      step: typeof c.step === "number" ? c.step : 0,
      filename: typeof c.filename === "string" ? c.filename : "",
      sizeBytes: typeof c.size_bytes === "number" ? c.size_bytes : 0,
      isFinal: c.is_final === true,
      isCaptionArchive: c.is_caption_archive === true,
      isBundle: c.is_bundle === true,
    }))
    .filter((c) => c.filename);

  return {
    ok: data.ok === true,
    salvaged: typeof data.salvaged === "number" ? data.salvaged : 0,
    captionFiles: typeof data.captionFiles === "number" ? data.captionFiles : 0,
    imageFiles: typeof data.imageFiles === "number" ? data.imageFiles : 0,
    checkpoints,
  };
}
