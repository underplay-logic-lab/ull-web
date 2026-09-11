import "server-only";

export type SpawnUpscaleJobParams = {
  jobId: string;
  userId: string;
  creditsCost: number;
  /** 原価割れウォッチドッグへ渡す許容最大 GPU 稼働時間（秒）。 */
  maxAllowedTime: number;
  /** 入力画像（base64・data URI 可）。 */
  imageBase64: string;
  modelKey: string;
  presetId: string;
  /** SeedVR2 ワークフローへ渡すパラメータ（target_short / max_resolution 等）。 */
  params: Record<string, number | string | boolean>;
};

export type SpawnUpscaleBatchItem = {
  jobId: string;
  creditsCost: number;
  imageBase64: string;
  modelKey: string;
  presetId: string;
  params: Record<string, number | string | boolean>;
};

export type SpawnUpscaleBatchJobParams = {
  batchId: string;
  userId: string;
  /** バッチ全体の推定合計処理秒数（コールドスタート猶予1回分込み）。 */
  maxAllowedTime: number;
  items: SpawnUpscaleBatchItem[];
};

const DISPATCH_TIMEOUT_MS = 25_000;
const DISPATCH_MAX_ATTEMPTS = 3;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// modal_seedvr2_worker.py は同一アプリ内。既存の同期エンドポイント URL
// （...seedvr2worker-upscale.modal.run）の関数名部分を差し替えれば dispatch URL。
// 専用の MODAL_UPSCALE_DISPATCH_URL があればそれを優先。
// ベース URL は MODAL_SEEDVR2_URL（推奨。worker の upscale / models いずれの
// endpoint URL でも可）または旧名 MODAL_UPSCALE_URL。
function resolveDispatchUrl(): string | undefined {
  const explicit = process.env.MODAL_UPSCALE_DISPATCH_URL;
  if (explicit) return explicit;
  const base = process.env.MODAL_SEEDVR2_URL || process.env.MODAL_UPSCALE_URL;
  if (!base) return undefined;
  return base
    .replace("seedvr2worker-upscale", "upscale-generate-dispatch")
    .replace("seedvr2worker-models", "upscale-generate-dispatch");
}

function resolveBatchDispatchUrl(): string | undefined {
  const explicit = process.env.MODAL_UPSCALE_BATCH_DISPATCH_URL;
  if (explicit) return explicit;
  const base = process.env.MODAL_SEEDVR2_URL || process.env.MODAL_UPSCALE_URL;
  if (!base) return undefined;
  return base
    .replace("seedvr2worker-upscale", "upscale-batch-generate-dispatch")
    .replace("seedvr2worker-models", "upscale-batch-generate-dispatch");
}

/**
 * modal_seedvr2_worker.py の `upscale_generate_dispatch` を叩き、GPU ジョブを
 * spawn させて即 return する。実際の進捗は worker が upscale_jobs を直接
 * 更新する。dispatch 自体が失敗したときだけ throw する。
 */
export async function spawnUpscaleJob(
  params: SpawnUpscaleJobParams,
): Promise<{ callId: string | null }> {
  const url = resolveDispatchUrl();
  const authToken = process.env.MODAL_AUTH_TOKEN;

  if (!url) {
    throw new Error(
      "MODAL_SEEDVR2_URL（または MODAL_UPSCALE_DISPATCH_URL）が未設定です。modal_seedvr2_worker.py の URL を環境変数に設定してください。",
    );
  }
  if (!authToken) {
    throw new Error("MODAL_AUTH_TOKEN が未設定です（modal_seedvr2_worker.py の _authorize が期待する共有シークレット）。");
  }

  const image = (params.imageBase64 ?? "").trim();
  if (!image) throw new Error("Modal へ渡す入力画像が空です。");

  const body = JSON.stringify({
    job_id: params.jobId,
    user_id: params.userId,
    credits_cost: params.creditsCost,
    max_allowed_time: params.maxAllowedTime,
    image,
    model_key: params.modelKey,
    preset: params.presetId,
    params: params.params,
  });

  const headers = {
    "Content-Type": "application/json",
    "x-modal-secret": authToken,
    Authorization: `Bearer ${authToken}`,
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= DISPATCH_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const parsed = (await res.json().catch(() => null)) as { call_id?: string } | null;
        return { callId: typeof parsed?.call_id === "string" ? parsed.call_id : null };
      }
      const text = (await res.text().catch(() => "")).slice(0, 500);
      lastErr = new Error(`Modal dispatch HTTP ${res.status}: ${text || "(empty)"}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastErr = err;
    }
    if (attempt < DISPATCH_MAX_ATTEMPTS) await sleep(400 * attempt);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * modal_seedvr2_worker.py の `upscale_batch_generate_dispatch` を叩き、複数
 * 画像を1コンテナ内で順番に処理するバッチジョブを spawn させて即 return
 * する。dispatch 自体が失敗したときだけ throw する（個々のアイテムの成否は
 * worker が upscale_jobs を直接更新する）。
 */
export async function spawnUpscaleBatchJob(
  params: SpawnUpscaleBatchJobParams,
): Promise<{ callId: string | null }> {
  const url = resolveBatchDispatchUrl();
  const authToken = process.env.MODAL_AUTH_TOKEN;

  if (!url) {
    throw new Error(
      "MODAL_SEEDVR2_URL（または MODAL_UPSCALE_BATCH_DISPATCH_URL）が未設定です。",
    );
  }
  if (!authToken) {
    throw new Error("MODAL_AUTH_TOKEN が未設定です（modal_seedvr2_worker.py の _authorize が期待する共有シークレット）。");
  }
  if (params.items.length === 0) throw new Error("バッチの画像が空です。");

  const body = JSON.stringify({
    batch_id: params.batchId,
    user_id: params.userId,
    max_allowed_time: params.maxAllowedTime,
    items: params.items.map((it) => ({
      job_id: it.jobId,
      credits_cost: it.creditsCost,
      image: it.imageBase64,
      model_key: it.modelKey,
      preset: it.presetId,
      params: it.params,
    })),
  });

  const headers = {
    "Content-Type": "application/json",
    "x-modal-secret": authToken,
    Authorization: `Bearer ${authToken}`,
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= DISPATCH_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const parsed = (await res.json().catch(() => null)) as { call_id?: string } | null;
        return { callId: typeof parsed?.call_id === "string" ? parsed.call_id : null };
      }
      const text = (await res.text().catch(() => "")).slice(0, 500);
      lastErr = new Error(`Modal batch dispatch HTTP ${res.status}: ${text || "(empty)"}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastErr = err;
    }
    if (attempt < DISPATCH_MAX_ATTEMPTS) await sleep(400 * attempt);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
