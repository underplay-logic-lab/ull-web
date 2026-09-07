import "server-only";
import { angleModeSteps, type AngleMode } from "@/lib/angleStudio";

export type SpawnAngleJobParams = {
  jobId: string;
  userId: string;
  creditsCost: number;
  /** 原価割れウォッチドッグ（損切り自爆）へ渡す許容最大 GPU 稼働時間（秒）。 */
  maxAllowedTime: number;
  imageBase64: string;
  instructions: string[];
  /** instructions と並行な日本語構図ラベル（ギャラリー表示用） */
  labels: string[];
  mode: AngleMode;
  seed?: number | null;
};

// The dispatch endpoint only .spawn()s the GPU job and ACKs — it never runs
// inference on this request. A few seconds of cold-start on the dispatch
// container (dispatch_image, no GPU) is the whole budget; the retry wrapper
// covers a transient Modal edge blip.
const DISPATCH_TIMEOUT_MS = 25_000;
const DISPATCH_MAX_ATTEMPTS = 3;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// train_lora_dispatch の兄弟 URL 導出と同じ考え方: 同一 Modal アプリ内なので
// edit エンドポイント URL の関数名部分を差し替えれば dispatch URL になる。
// 専用の MODAL_ANGLE_DISPATCH_URL があればそれを優先。
function resolveDispatchUrl(): string | undefined {
  const explicit = process.env.MODAL_ANGLE_DISPATCH_URL;
  if (explicit) return explicit;
  const editUrl = process.env.MODAL_ANGLE_URL;
  if (!editUrl) return undefined;
  return editUrl.replace("qwenimageeditworker-edit", "angle-generate-dispatch");
}

/**
 * modal_angle_worker.py の `angle_generate_dispatch` を叩き、GPU ジョブを
 * spawn させて即 return する。実際の生成進捗は Modal ワーカーが angle_jobs を
 * 直接更新する（この関数はもう関与しない）。dispatch 自体が失敗したときだけ
 * throw する。
 */
export async function spawnAngleJob(
  params: SpawnAngleJobParams,
): Promise<{ callId: string | null }> {
  const url = resolveDispatchUrl();
  const authToken = process.env.MODAL_AUTH_TOKEN;

  if (!url) {
    throw new Error(
      "MODAL_ANGLE_URL（または MODAL_ANGLE_DISPATCH_URL）が未設定です。modal_angle_worker.py の URL を環境変数に設定してください。",
    );
  }
  if (!authToken) {
    throw new Error("MODAL_AUTH_TOKEN が未設定です（modal_angle_worker.py の _authorize が期待する共有シークレット）。");
  }

  // 54 個フル選択でも欠落なく Modal へ渡す。instruction と label を対で整形し、
  // 空の instruction だけを落として label の対応がズレないようにする
  // （buildAngleCombos は空 instruction を生成しないので通常は素通り）。
  const sanitized = params.instructions
    .map((instr, i) => ({
      instruction: String(instr ?? "").trim(),
      label: String(params.labels[i] ?? "").trim(),
    }))
    .filter((p) => p.instruction.length > 0);

  if (sanitized.length === 0) {
    throw new Error("Modal へ渡す構図プロンプトが空です。");
  }

  const body = JSON.stringify({
    job_id: params.jobId,
    user_id: params.userId,
    credits_cost: params.creditsCost,
    max_allowed_time: params.maxAllowedTime,
    image: params.imageBase64,
    instructions: sanitized.map((p) => p.instruction),
    labels: sanitized.map((p) => p.label),
    num_inference_steps: angleModeSteps(params.mode),
    ...(typeof params.seed === "number" && Number.isFinite(params.seed)
      ? { seed: Math.trunc(params.seed) }
      : {}),
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
      // 4xx（auth / bad request）は即諦める。429 / 5xx はリトライ。
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
