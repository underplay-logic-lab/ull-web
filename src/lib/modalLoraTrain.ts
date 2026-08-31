import "server-only";
import type { LoraBaseArchitecture } from "@/lib/loraModels";

export const LORA_DATASET_BUCKET = "lora_datasets";

// TEST ONLY: when Vercel env LORA_TRAIN_TEST_STUB=1, dispatch routes to a
// GPU-less no-op on Modal that never leaves the row 'queued' — an
// artificial, storm-free way to exercise the pending-timeout auto-failover.
const TEST_STUB = process.env.LORA_TRAIN_TEST_STUB === "1";

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
  // Keys the worker's persisted-caption cache on the Volume.
  datasetId?: string;
  captions: string[];
  targetModel: string;
  customModelId?: string;
  baseArchitecture?: LoraBaseArchitecture;
  trainingConfig: LoraTrainingConfig;
  resolution?: number;
  outputLoraName: string;
  triggerWord?: string;
  // Present when the user brought their own captions — the worker skips the
  // 27B caption VLM load entirely.
  customCaptions?: string[];
  skipCaptioning?: boolean;
  // User's own auto-caption VLM instruction (category preset / free-text).
  captionPrompt?: string;
};

// The exact Modal payload — stored on the job so a pending-timeout retry can
// re-dispatch it verbatim without another credit debit.
export type LoraDispatchPayload = {
  storage_bucket: string;
  storage_paths: string[];
  dataset_id: string;
  captions: string[];
  target_model: string;
  custom_model_id: string;
  base_architecture: string;
  training_config: LoraTrainingConfig;
  resolution: number;
  output_lora_name: string;
  trigger_word: string;
  custom_captions?: string[];
  skip_captioning?: boolean;
  caption_prompt?: string;
};

export function buildLoraDispatchPayload(params: SpawnLoraTrainingParams): LoraDispatchPayload {
  return {
    storage_bucket: LORA_DATASET_BUCKET,
    storage_paths: params.storagePaths,
    dataset_id: params.datasetId ?? "",
    captions: params.captions,
    target_model: params.targetModel,
    custom_model_id: params.customModelId ?? "",
    base_architecture: params.baseArchitecture ?? "",
    training_config: params.trainingConfig,
    resolution: params.resolution ?? 768,
    output_lora_name: params.outputLoraName,
    trigger_word: params.triggerWord ?? "",
    ...(params.customCaptions && params.customCaptions.length
      ? { custom_captions: params.customCaptions }
      : {}),
    ...(params.skipCaptioning ? { skip_captioning: true } : {}),
    ...(params.captionPrompt && params.captionPrompt.trim()
      ? { caption_prompt: params.captionPrompt.trim() }
      : {}),
  };
}

// How long to wait on the *dispatch* ack. train_lora_dispatch is a GPU-less
// Modal function that auth-checks, then (only for HF-repo base models) runs
// the CPU model pre-cache synchronously — a first-time snapshot_download of a
// multi-GB model can take a few minutes — before .spawn()ing the GPU job.
// A single-file / Volume model (the common path) still returns in ~1-5s.
// 5 min covers the worst case without a spurious client-side timeout; the
// route's own maxDuration must be raised alongside this to actually wait it out.
const SPAWN_TIMEOUT_MS = 300_000;

// Fire-and-forget: posts to modal_lora_worker.py's train_lora_dispatch,
// which .spawn()s the GPU training job and returns immediately. The spawned
// job PATCHes generation_jobs (status / progress_percent / progress_message
// / result_path) directly via Supabase REST as it runs — this request is
// long gone by then. Throws only if the dispatch itself failed.
async function modalEnv(
  kind: "train" | "cancel" | "status" | "salvage",
): Promise<{ url: string; authToken: string; host: string }> {
  const trainUrl = process.env.MODAL_LORA_TRAIN_URL;
  let url: string | undefined;
  switch (kind) {
    case "train":
      url = trainUrl;
      break;
    case "cancel":
      url = process.env.MODAL_LORA_CANCEL_URL || deriveSiblingUrl(trainUrl, "cancel-lora-job");
      break;
    case "status":
      url = process.env.MODAL_LORA_STATUS_URL || deriveSiblingUrl(trainUrl, "check-call-status");
      break;
    case "salvage":
      url = process.env.MODAL_LORA_SALVAGE_URL || deriveSiblingUrl(trainUrl, "salvage-lora-job");
      break;
  }
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!url) {
    throw new Error(
      "MODAL_LORA_TRAIN_URL が未設定です。Vercel の環境変数に modal_lora_worker.py の train_lora_dispatch の URL を設定してください。",
    );
  }
  if (!authToken) {
    throw new Error("MODAL_AUTH_TOKEN が未設定です（modal_lora_worker.py の _authorize が期待する共有シークレット）。");
  }
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error(`Modal の URL が不正です: ${url}`);
  }
  return { url, authToken, host };
}

// Every worker endpoint lives on the same Modal app, so a sibling's URL is
// the train URL with "train-lora-dispatch" swapped for the dashed function
// name (cancel-lora-job / check-call-status / salvage-lora-job). A dedicated
// MODAL_LORA_*_URL env var overrides this when set.
function deriveSiblingUrl(trainUrl: string | undefined, fnDashed: string): string {
  return (trainUrl ?? "").replace("train-lora-dispatch", fnDashed);
}

// Dispatches to train_lora_dispatch, which .spawn()s the GPU job and
// returns { modal_call_id }. Throws only if the dispatch itself failed.
export async function spawnLoraTrainingJob(
  params: SpawnLoraTrainingParams,
): Promise<{ modalCallId: string | null }> {
  const { url, authToken, host } = await modalEnv("train");

  const body = JSON.stringify({
    job_id: params.jobId,
    user_id: params.userId,
    credits_cost: params.creditsCost,
    ...buildLoraDispatchPayload(params),
    ...(TEST_STUB ? { _test_stub: true } : {}),
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // _authorize accepts this header OR "Authorization: Bearer <token>".
        "x-modal-secret": authToken,
        Authorization: `Bearer ${authToken}`,
      },
      body,
      signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[spawnLoraTrainingJob] fetch to ${host} threw:`, reason);
    throw new Error(`Modal dispatch (${host}) への接続に失敗しました: ${reason}`);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    console.error(`[spawnLoraTrainingJob] ${host} responded ${res.status}: ${text.slice(0, 2000)}`);
    throw new Error(`Modal dispatch failed — HTTP ${res.status} from ${host}: ${text.slice(0, 1000) || "(empty body)"}`);
  }
  console.log(`[spawnLoraTrainingJob] ${host} accepted job ${params.jobId}: ${text.slice(0, 500)}`);

  let modalCallId: string | null = null;
  try {
    const parsed = JSON.parse(text) as { modal_call_id?: string };
    modalCallId = typeof parsed.modal_call_id === "string" ? parsed.modal_call_id : null;
  } catch {
    /* non-JSON body — leave modalCallId null */
  }
  return { modalCallId };
}

// Re-dispatch an already-priced job (a pending-timeout retry) — no new
// credit debit; the payload comes straight off the job's stored inputs.
export async function redispatchLoraTrainingJob(args: {
  jobId: string;
  userId: string;
  payload: LoraDispatchPayload;
}): Promise<{ modalCallId: string | null }> {
  const { url, authToken, host } = await modalEnv("train");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-modal-secret": authToken,
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      job_id: args.jobId,
      user_id: args.userId,
      credits_cost: 0,
      ...args.payload,
      ...(TEST_STUB ? { _test_stub: true } : {}),
    }),
    signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Modal re-dispatch failed — HTTP ${res.status} from ${host}: ${text.slice(0, 1000)}`);
  }
  try {
    const parsed = JSON.parse(text) as { modal_call_id?: string };
    return { modalCallId: typeof parsed.modal_call_id === "string" ? parsed.modal_call_id : null };
  } catch {
    return { modalCallId: null };
  }
}

// Best-effort physical cancel of a stuck spawned FunctionCall (hits
// modal_lora_worker.py::cancel_lora_job -> FunctionCall.from_id().cancel()).
// Never throws. Returns true when Modal reports success:true.
export async function cancelLoraTrainingCall(modalCallId: string): Promise<boolean> {
  if (!modalCallId) return false;
  try {
    const { url, authToken, host } = await modalEnv("cancel");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-modal-secret": authToken,
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ call_id: modalCallId, modal_call_id: modalCallId }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text().catch(() => "");
    console.log(`[cancelLoraTrainingCall] ${host} -> ${res.status}: ${text.slice(0, 300)}`);
    if (!res.ok) return false;
    try {
      const j = JSON.parse(text) as { success?: boolean; cancelled?: boolean };
      return Boolean(j.success ?? j.cancelled);
    } catch {
      return true;
    }
  } catch (err) {
    console.error("[cancelLoraTrainingCall] failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

// Modal-native self-healing: asks modal_lora_worker.py::check_call_status
// whether a spawned training FunctionCall is still alive. Authoritative even
// when the container died by SIGKILL (train_lora_job's own except-block never
// runs in that case). Never throws — an unreachable endpoint returns
// "unknown" so the caller leaves the job alone.
export type LoraCallStatus = {
  status: "completed" | "running" | "failed" | "unknown";
  error?: string;
};

export async function checkLoraCallStatus(modalCallId: string): Promise<LoraCallStatus> {
  if (!modalCallId) return { status: "unknown", error: "no modal_call_id" };
  try {
    const { url, authToken, host } = await modalEnv("status");
    const target = new URL(url);
    target.searchParams.set("call_id", modalCallId);
    const res = await fetch(target.toString(), {
      method: "GET",
      headers: { "x-modal-secret": authToken, Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      console.error(`[checkLoraCallStatus] ${host} -> ${res.status}: ${text.slice(0, 300)}`);
      return { status: "unknown", error: `HTTP ${res.status}` };
    }
    const j = JSON.parse(text) as LoraCallStatus;
    if (j && typeof j.status === "string") return j;
    return { status: "unknown" };
  } catch (err) {
    console.error("[checkLoraCallStatus] failed:", err instanceof Error ? err.message : String(err));
    return { status: "unknown", error: err instanceof Error ? err.message : String(err) };
  }
}

// One salvaged artifact, in the same snake_case shape train_lora_job writes
// to generation_jobs.metadata.checkpoints.
export type SalvagedCheckpoint = {
  step: number;
  filename: string;
  size_bytes: number;
  is_final?: boolean;
  is_caption_archive?: boolean;
  salvaged?: boolean;
  path?: string;
};

// Scans the Volume for whatever a dead / cancelled run left behind (see
// modal_lora_worker.py::salvage_lora_job) and returns the checkpoint list.
// Throws only if the salvage call itself failed.
export async function salvageLoraJobRemote(args: {
  userId: string;
  jobId: string;
  modalCallId: string;
  datasetId?: string;
  outputLoraName?: string;
}): Promise<{
  ok: boolean;
  checkpoints: SalvagedCheckpoint[];
  salvaged: number;
  captionFiles: number;
  imageFiles: number;
}> {
  const { url, authToken, host } = await modalEnv("salvage");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-modal-secret": authToken,
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      user_id: args.userId,
      job_id: args.jobId,
      call_id: args.modalCallId,
      dataset_id: args.datasetId ?? "",
      output_lora_name: args.outputLoraName ?? "",
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Modal salvage failed — HTTP ${res.status} from ${host}: ${text.slice(0, 500)}`);
  }
  const j = JSON.parse(text) as {
    ok?: boolean;
    checkpoints?: SalvagedCheckpoint[];
    salvaged?: number;
    caption_files?: number;
    image_files?: number;
  };
  return {
    ok: Boolean(j.ok),
    checkpoints: Array.isArray(j.checkpoints) ? j.checkpoints : [],
    salvaged: typeof j.salvaged === "number" ? j.salvaged : 0,
    captionFiles: typeof j.caption_files === "number" ? j.caption_files : 0,
    imageFiles: typeof j.image_files === "number" ? j.image_files : 0,
  };
}
