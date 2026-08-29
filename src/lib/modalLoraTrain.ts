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
  };
}

// How long to wait on the *dispatch* ack. train_lora_dispatch is a GPU-less
// Modal function whose whole body is an auth check + a .spawn(); it runs on
// a tiny image with a warm container, but a genuine cold start (right after
// a deploy, or after a long idle) can still take ~20-40s, so allow 55s —
// just under the route's maxDuration.
const SPAWN_TIMEOUT_MS = 55_000;

// Fire-and-forget: posts to modal_lora_worker.py's train_lora_dispatch,
// which .spawn()s the GPU training job and returns immediately. The spawned
// job PATCHes generation_jobs (status / progress_percent / progress_message
// / result_path) directly via Supabase REST as it runs — this request is
// long gone by then. Throws only if the dispatch itself failed.
async function modalEnv(kind: "train" | "cancel"): Promise<{ url: string; authToken: string; host: string }> {
  const url = kind === "cancel"
    ? (process.env.MODAL_LORA_CANCEL_URL || deriveCancelUrl(process.env.MODAL_LORA_TRAIN_URL))
    : process.env.MODAL_LORA_TRAIN_URL;
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

// cancel_lora_job is a sibling endpoint on the same Modal app, so its URL is
// the train URL with "train-lora-dispatch" swapped for "cancel-lora-job".
function deriveCancelUrl(trainUrl: string | undefined): string {
  return (trainUrl ?? "").replace("train-lora-dispatch", "cancel-lora-job");
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
