import "server-only";
import type { LoraBaseArchitecture } from "@/lib/loraModels";

export const LORA_DATASET_BUCKET = "lora_datasets";

// TEST ONLY: when Vercel env LORA_TRAIN_TEST_STUB=1, dispatch routes to a
// GPU-less no-op on Modal that never leaves the row 'queued' — an
// artificial, storm-free way to exercise the pending-timeout auto-failover.
const TEST_STUB = process.env.LORA_TRAIN_TEST_STUB === "1";

// Which Modal worker/app a job's training dispatch targets. "ai_toolkit" is
// modal_lora_worker.py (the original, all non-SDXL archs). "sdxl" is
// modal_sdxl_lora_worker.py — a SEPARATE app (kohya-ss/sd-scripts backend)
// that route.ts sends arch==="sdxl" jobs to instead, because ai-toolkit's
// SDXL results are noticeably worse than sd-scripts' (host finding,
// 2026-09-15 — see [[sdxl-training-sd-scripts-plan]]). Default "ai_toolkit"
// everywhere below preserves every existing call site's behavior untouched.
export type LoraWorkerTarget = "ai_toolkit" | "sdxl";

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
  // Cost-guard budget (seconds) computed by the API from the credit price and
  // the pricing_knobs cost-guard thresholds — the worker's projected-wall-time
  // abort uses this directly instead of re-deriving it from credits_cost with
  // hardcoded rates. See src/lib/pricing/costGuard.server.ts.
  costCapSeconds?: number;
  // Supabase Storage object paths in the lora_datasets bucket, caption order.
  storagePaths: string[];
  // Keys the worker's persisted-caption cache on the Volume.
  datasetId?: string;
  captions: string[];
  targetModel: string;
  customModelId?: string;
  baseArchitecture?: LoraBaseArchitecture;
  /** arch 別 GPU tier（loraArchGpuTier）。worker の dispatch が with_options(gpu=…) に使う。 */
  gpuTier?: string;
  trainingConfig: LoraTrainingConfig;
  resolution?: number;
  outputLoraName: string;
  triggerWord?: string;
  // Present when the user brought their own captions — the worker skips the
  // 27B caption VLM load entirely.
  customCaptions?: string[];
  skipCaptioning?: boolean;
  // Resolved caption FORMAT ("dense" | "tags"). Keys the worker's persisted-
  // caption cache so a dense run and a tags run of the same dataset never
  // share (and overwrite) each other's cached captions.
  captionMode?: "dense" | "tags";
  // User's own auto-caption VLM instruction (category preset / free-text).
  captionPrompt?: string;
  // Which Modal app/worker to dispatch to. Default "ai_toolkit" (unchanged
  // behavior for every existing caller). route.ts sets "sdxl" for
  // arch==="sdxl" jobs.
  worker?: LoraWorkerTarget;
  // sdxl worker only — see modal_sdxl_lora_worker.py's _embed_metadata_tags /
  // _parse_embed_tags: "tag:freq,tag,..." string embedded into the finished
  // .safetensors' ss_tag_frequency/modelspec.tags/ss_trained_words. Ignored
  // by the ai-toolkit worker (which has no such param).
  embedTags?: string;
  // sdxl worker only — leading fixed-token count for shuffle_caption (see
  // DEFAULT_KEEP_TOKENS in modal_sdxl_lora_worker.py). Undefined -> worker's
  // own default (4).
  keepTokens?: number;
  // 画像ごとの学習回数（storagePaths と同じ並び）。kohya のフォルダ名規約
  // "10_name"（その画像を10回学習する）と同じ意味で、ローカルの ai-toolkit /
  // sd-scripts 運用では定番の重み付け手段。ULL Studio はブラウザから画像を
  // 1つの束として受け取るのでフォルダ名が使えず、代わりに倍率ごとに
  // dataset/subset を分けて num_repeats を指定する（両ワーカー対応）。
  // 未指定・全要素1 なら従来どおり単一データセット。
  // ⚠️ 総ステップ数は固定なので**課金は変わらない**。変わるのは構成比だけ。
  repeats?: number[];
  // sdxl worker only — 画像ごとの keep_tokens（storagePaths と同じ並び）。
  // shuffle_caption が「先頭いくつを固定するか」で、キャプションの固定ブロック
  // （trigger 群 + 数/性別タグ）の長さと一致していないと trigger が本文へ
  // 紛れ込む。solo=4 / duo=4 / 3人=6 と画像ごとに変わり得るので、
  // loraCaptionSpec.ts の keepTokensForCaption が実キャプションから数えた値を
  // 渡す（ユーザーには入力させない）。
  keepTokensPerImage?: number[];
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
  gpu_tier?: string;
  training_config: LoraTrainingConfig;
  resolution: number;
  output_lora_name: string;
  trigger_word: string;
  custom_captions?: string[];
  skip_captioning?: boolean;
  caption_mode?: "dense" | "tags";
  caption_prompt?: string;
  cost_cap_seconds?: number;
  embed_tags?: string;
  keep_tokens?: number;
  repeats?: number[];
  keep_tokens_per_image?: number[];
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
    ...(params.gpuTier ? { gpu_tier: params.gpuTier } : {}),
    training_config: params.trainingConfig,
    resolution: params.resolution ?? 768,
    output_lora_name: params.outputLoraName,
    trigger_word: params.triggerWord ?? "",
    ...(params.customCaptions && params.customCaptions.length
      ? { custom_captions: params.customCaptions }
      : {}),
    ...(params.skipCaptioning ? { skip_captioning: true } : {}),
    ...(params.captionMode === "dense" || params.captionMode === "tags"
      ? { caption_mode: params.captionMode }
      : {}),
    ...(params.captionPrompt && params.captionPrompt.trim()
      ? { caption_prompt: params.captionPrompt.trim() }
      : {}),
    ...(typeof params.costCapSeconds === "number" && Number.isFinite(params.costCapSeconds)
      ? { cost_cap_seconds: Math.round(params.costCapSeconds) }
      : {}),
    ...(params.embedTags && params.embedTags.trim() ? { embed_tags: params.embedTags.trim() } : {}),
    ...(typeof params.keepTokens === "number" && Number.isFinite(params.keepTokens)
      ? { keep_tokens: Math.round(params.keepTokens) }
      : {}),
    // 全部 1 なら送らない（ワーカー側も未指定と同じ扱いになる）。
    ...(params.repeats && params.repeats.some((n) => n !== 1)
      ? { repeats: params.repeats }
      : {}),
    // 全部同じ値なら送らない（ワーカーは keep_tokens 単体へフォールバック）。
    ...(params.keepTokensPerImage &&
    params.keepTokensPerImage.some((n) => n !== params.keepTokensPerImage?.[0])
      ? { keep_tokens_per_image: params.keepTokensPerImage }
      : {}),
  };
}

// train_lora_dispatch is a warm (min_containers=1) GPU-less Modal function
// that only auth-checks and .spawn()s the async pre-cache/GPU orchestrator,
// then ACKs — it returns in well under a second, cold start or not (the CPU
// snapshot_download and GPU work all happen off this request, in the spawned
// _prepare_and_spawn_training). So a slow/failed ACK is a transient network /
// edge blip, not real work in progress: retry it.
//
// Per-attempt AbortController ceiling. 30s absorbs a Modal edge/proxy hiccup
// or a rare FastAPI container recycle without a spurious client abort, while
// still failing fast enough to fit 3 attempts + backoff inside the route's
// maxDuration.
const DISPATCH_ATTEMPT_TIMEOUT_MS = 30_000;
const DISPATCH_MAX_ATTEMPTS = 3;
// Exponential backoff between attempts (ms): after attempt 1 wait ~1.5s,
// after attempt 2 wait ~3s (attempt 3 is the last — no wait after it). Full
// jitter of up to +0.5s is added so simultaneous failures don't retry in
// lockstep. A 6s slot is kept for symmetry / future MAX_ATTEMPTS bumps.
const DISPATCH_BACKOFF_MS = [1_500, 3_000, 6_000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function dispatchBackoff(attemptIndex: number): number {
  const base =
    DISPATCH_BACKOFF_MS[attemptIndex] ?? DISPATCH_BACKOFF_MS[DISPATCH_BACKOFF_MS.length - 1];
  return base + Math.floor(Math.random() * 500);
}

// A thrown fetch error worth retrying: a network-level failure where the
// request provably did NOT get processed by Modal (undici "fetch failed" ->
// TypeError; DNS / connect / socket errors; our own AbortController timeout).
// A deterministic error (bad payload, auth) is a TypeError only in pathological
// cases and would just fail again — but retrying 3x is cheap and the dispatch
// endpoint is idempotent enough for our purposes (a duplicate spawn on the
// same job_id is the far rarer failure mode than the fetch simply not landing).
function isRetriableDispatchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "TypeError" || err.name === "AbortError" || err.name === "TimeoutError";
}

// Robust POST to train_lora_dispatch: up to DISPATCH_MAX_ATTEMPTS tries with a
// per-attempt 30s timeout and exponential backoff + jitter between them.
// Retries transient failures only — a network throw, or an HTTP 429 / 5xx
// (Modal edge error / .spawn() failure, i.e. the job was NOT queued). A 2xx or
// a deterministic 4xx (auth / bad request) is returned to the caller as-is,
// body unread. On exhaustion it throws the last error so the caller's existing
// catch (mark job failed + refund) runs unchanged.
async function postModalDispatchWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  ctx: { host: string; jobId: string },
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= DISPATCH_MAX_ATTEMPTS; attempt++) {
    const isLast = attempt === DISPATCH_MAX_ATTEMPTS;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(DISPATCH_ATTEMPT_TIMEOUT_MS),
      });
      if (res.status !== 429 && res.status < 500) return res;
      const snippet = (await res.text().catch(() => "")).slice(0, 500);
      lastErr = new Error(
        `Modal dispatch (${ctx.host}) HTTP ${res.status}: ${snippet || "(empty body)"}`,
      );
      if (isLast) break;
      console.warn(
        `[modalDispatch] ${ctx.host} job ${ctx.jobId}: attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS} -> HTTP ${res.status}; retrying`,
      );
    } catch (err) {
      lastErr = err;
      if (isLast || !isRetriableDispatchError(err)) break;
      const name = err instanceof Error ? err.name : "Error";
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[modalDispatch] ${ctx.host} job ${ctx.jobId}: attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS} threw ${name} (${msg}); retrying`,
      );
    }
    await sleep(dispatchBackoff(attempt - 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Fire-and-forget: posts to modal_lora_worker.py's train_lora_dispatch (or,
// for worker="sdxl", modal_sdxl_lora_worker.py's train_sdxl_lora_dispatch),
// which .spawn()s the GPU training job and returns immediately. The spawned
// job PATCHes generation_jobs (status / progress_percent / progress_message
// / result_path) directly via Supabase REST as it runs — this request is
// long gone by then. Throws only if the dispatch itself failed.
//
// worker="sdxl" only supports kind="train": modal_sdxl_lora_worker.py has no
// cancel_lora_job / check_call_status / salvage_lora_job endpoints of its
// own yet (see cancelLoraTrainingCall / checkLoraCallStatus / salvageLoraJobRemote
// below for how those 3 are actually handled for an sdxl job in the
// meantime). Asking for one of those here is a caller bug, not a runtime
// condition to degrade gracefully from — fail loudly.
async function modalEnv(
  kind: "train" | "cancel" | "status" | "salvage",
  worker: LoraWorkerTarget = "ai_toolkit",
): Promise<{ url: string; authToken: string; host: string }> {
  let url: string | undefined;
  if (worker === "sdxl") {
    if (kind !== "train") {
      throw new Error(
        `modal_sdxl_lora_worker.py has no '${kind}' endpoint yet — this is a caller bug, not a config issue.`,
      );
    }
    url = process.env.MODAL_SDXL_LORA_TRAIN_URL;
    if (!url) {
      throw new Error(
        "MODAL_SDXL_LORA_TRAIN_URL が未設定です。Vercel の環境変数に modal_sdxl_lora_worker.py の train_sdxl_lora_dispatch の URL を設定してください。",
      );
    }
  } else {
    const trainUrl = process.env.MODAL_LORA_TRAIN_URL;
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
    if (!url) {
      throw new Error(
        "MODAL_LORA_TRAIN_URL が未設定です。Vercel の環境変数に modal_lora_worker.py の train_lora_dispatch の URL を設定してください。",
      );
    }
  }
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!authToken) {
    throw new Error("MODAL_AUTH_TOKEN が未設定です（両ワーカーの _authorize が期待する共有シークレット、Secret名 wan-animate-auth）。");
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
  const { url, authToken, host } = await modalEnv("train", params.worker ?? "ai_toolkit");

  const body = JSON.stringify({
    job_id: params.jobId,
    user_id: params.userId,
    credits_cost: params.creditsCost,
    ...buildLoraDispatchPayload(params),
    ...(TEST_STUB ? { _test_stub: true } : {}),
  });

  let res: Response;
  try {
    res = await postModalDispatchWithRetry(
      url,
      {
        "Content-Type": "application/json",
        // _authorize accepts this header OR "Authorization: Bearer <token>".
        "x-modal-secret": authToken,
        Authorization: `Bearer ${authToken}`,
      },
      body,
      { host, jobId: params.jobId },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[spawnLoraTrainingJob] dispatch to ${host} failed after ${DISPATCH_MAX_ATTEMPTS} attempts (job ${params.jobId}):`,
      reason,
    );
    throw new Error(
      `Modal dispatch (${host}) への接続に失敗しました（${DISPATCH_MAX_ATTEMPTS}回リトライ後）: ${reason}`,
    );
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    // Only a deterministic 4xx reaches here — 429 / 5xx were retried then thrown.
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
  worker?: LoraWorkerTarget;
}): Promise<{ modalCallId: string | null }> {
  const { url, authToken, host } = await modalEnv("train", args.worker ?? "ai_toolkit");
  const res = await postModalDispatchWithRetry(
    url,
    {
      "Content-Type": "application/json",
      "x-modal-secret": authToken,
      Authorization: `Bearer ${authToken}`,
    },
    JSON.stringify({
      job_id: args.jobId,
      user_id: args.userId,
      credits_cost: 0,
      ...args.payload,
      ...(TEST_STUB ? { _test_stub: true } : {}),
    }),
    { host, jobId: args.jobId },
  );
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
//
// No `worker` param needed: modal.FunctionCall ids are WORKSPACE-global, not
// scoped to the app/endpoint that issued them (cancel_lora_job just does a
// raw `modal.FunctionCall.from_id(call_id).cancel()`), and both
// modal_lora_worker.py and modal_sdxl_lora_worker.py deploy into the same
// Modal workspace — so this one endpoint already cancels an SDXL job's call
// id too, with zero SDXL-specific code needed.
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
//
// Same workspace-global FunctionCall-id reasoning as cancelLoraTrainingCall
// above — no `worker` param needed, this already works for an SDXL job's
// call id too.
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
//
// KNOWN GAP (2026-09-15): ai-toolkit-only — salvage_lora_job scans
// PERSIST_OUTPUT_ROOT/<run_key> using ai-toolkit's own output-dir layout, so
// calling this for an SDXL job (whose files, if any survive a dead
// container, sit under modal_sdxl_lora_worker.py's own _job_output_dir path
// on the SAME Volume but a DIFFERENT root) finds nothing — it degrades to a
// harmless empty result (checkpoints: [], salvaged: 0), never a crash, but a
// dead SDXL job's partial checkpoints are NOT actually recoverable through
// this path yet. Add an equivalent salvage endpoint to
// modal_sdxl_lora_worker.py before this worker sees real unattended traffic.
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
