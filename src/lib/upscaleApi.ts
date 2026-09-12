import { supabase } from "@/lib/supabaseClient";
import { normalizeUpscaleInput } from "@/lib/upscaleImage";

export type UpscaleApiError = Error & { remainingCredits?: number };

export type UpscaleJobStatus = "pending" | "processing" | "completed" | "failed";

export type UpscaleJob = {
  id: string;
  status: UpscaleJobStatus;
  modelKey: string;
  preset: string;
  /** 完成画像/動画の公開 URL（未完なら null）。 */
  resultUrl: string | null;
  errorMessage: string | null;
  /** ライブ実効 VRAM 消費量（GB）。ネタバレ防止 — 分母・％・GPU名なし。 */
  vramUsedGb: number | null;
  vramPeakGb: number | null;
  elapsedTime: number | null;
  outWidth: number | null;
  outHeight: number | null;
};

export type StartUpscaleJobResult = {
  jobId: string;
  remainingCredits: number;
  creditsCost: number;
};

export async function startUpscaleJob(params: {
  image: File;
  modelKey: string;
  modeId: string;
}): Promise<StartUpscaleJobResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const norm = await normalizeUpscaleInput(params.image);

  const form = new FormData();
  form.append("image", norm.blob, norm.filename);
  form.append("modelKey", params.modelKey);
  form.append("mode", params.modeId);

  const res = await fetch("/api/studio/upscale/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    const error: UpscaleApiError = new Error(data?.error || "ジョブの作成に失敗しました。");
    if (typeof data?.remainingCredits === "number") error.remainingCredits = data.remainingCredits;
    throw error;
  }

  return {
    jobId: data.jobId as string,
    remainingCredits: data.remainingCredits as number,
    creditsCost: data.creditsCost as number,
  };
}

export type StartUpscaleVideoJobResult = {
  jobId: string;
  remainingCredits: number;
  creditsCost: number;
};

export async function startUpscaleVideoJob(params: {
  video: File;
  modelKey: string;
  presetId: string;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
}): Promise<StartUpscaleVideoJobResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const form = new FormData();
  form.append("video", params.video, params.video.name || "input.mp4");
  form.append("modelKey", params.modelKey);
  form.append("preset", params.presetId);
  form.append("durationSec", String(params.durationSec));
  form.append("fps", String(params.fps));
  form.append("width", String(params.width));
  form.append("height", String(params.height));

  const res = await fetch("/api/studio/upscale/video/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    const error: UpscaleApiError = new Error(data?.error || "ジョブの作成に失敗しました。");
    if (typeof data?.remainingCredits === "number") error.remainingCredits = data.remainingCredits;
    throw error;
  }

  return {
    jobId: data.jobId as string,
    remainingCredits: data.remainingCredits as number,
    creditsCost: data.creditsCost as number,
  };
}

export type StartUpscaleBatchJobResult = {
  batchId: string;
  jobIds: string[];
  remainingCredits: number;
  creditsCost: number;
};

export async function startUpscaleBatchJob(params: {
  images: File[];
  modelKey: string;
  modeId: string;
}): Promise<StartUpscaleBatchJobResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const form = new FormData();
  for (const file of params.images) {
    const norm = await normalizeUpscaleInput(file);
    form.append("images", norm.blob, norm.filename);
  }
  form.append("modelKey", params.modelKey);
  form.append("mode", params.modeId);

  const res = await fetch("/api/studio/upscale/batch", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    const error: UpscaleApiError = new Error(data?.error || "バッチの作成に失敗しました。");
    if (typeof data?.remainingCredits === "number") error.remainingCredits = data.remainingCredits;
    throw error;
  }

  return {
    batchId: data.batchId as string,
    jobIds: data.jobIds as string[],
    remainingCredits: data.remainingCredits as number,
    creditsCost: data.creditsCost as number,
  };
}

type UpscaleJobRow = {
  id: string;
  status: UpscaleJobStatus;
  model_key: string;
  preset: string;
  result_url: string | null;
  error_message: string | null;
  metadata: unknown;
};

function metaNumber(meta: unknown, key: string): number | null {
  if (!meta || typeof meta !== "object") return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const UPSCALE_COLS =
  "id, status, model_key, preset, result_url, error_message, metadata";

/** ジョブ行が見つからない（14日保持を過ぎて自動 purge 済み等）— 一時的な
 * 通信エラーと違いリトライしても直らないので、呼び出し側で区別して案内する。 */
export class UpscaleJobNotFoundError extends Error {
  constructor() {
    super("ジョブが見つかりません。");
    this.name = "UpscaleJobNotFoundError";
  }
}

export async function pollUpscaleJob(jobId: string): Promise<UpscaleJob> {
  const { data, error } = await supabase
    .from("upscale_jobs")
    .select(UPSCALE_COLS)
    .eq("id", jobId)
    .single<UpscaleJobRow>();

  // .single() は 0 件でも PGRST116 でエラーを返す（profile.ts と同じ規約）。
  if (error?.code === "PGRST116") throw new UpscaleJobNotFoundError();
  if (error) throw new Error(error.message);
  if (!data) throw new UpscaleJobNotFoundError();

  return {
    id: data.id,
    status: data.status,
    modelKey: data.model_key,
    preset: data.preset,
    resultUrl: data.result_url,
    errorMessage: data.error_message,
    vramUsedGb: metaNumber(data.metadata, "vram_used_gb"),
    vramPeakGb: metaNumber(data.metadata, "vram_peak_gb"),
    elapsedTime: metaNumber(data.metadata, "elapsed_time"),
    outWidth: metaNumber(data.metadata, "out_width"),
    outHeight: metaNumber(data.metadata, "out_height"),
  };
}

/** 公開 URL を実ファイルとして保存させる（cross-origin download 対策）。 */
export async function downloadUpscaleImage(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`画像の取得に失敗しました (${res.status})`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
