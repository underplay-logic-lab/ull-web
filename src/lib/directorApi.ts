import { supabase } from "@/lib/supabaseClient";
import { uploadStudioAsset } from "@/lib/studioUploads";
import { isDirectorQualityMode, type DirectorQualityMode, type DirectorScene } from "@/lib/directorPricing";

export type DirectorApiError = Error & { remainingCredits?: number };

export type DirectorStartResult = {
  jobId: string;
  /** 予約として受け付けた（まだ始まっていない）。queue: true で、前のジョブが動いているとき。 */
  reserved: boolean;
  creditsCost: number;
  remainingCredits: number;
  totalDurationS: number;
};

export type DirectorStartArgs = (
  | {
      userId: string;
      image: File;
      scenes: DirectorScene[];
      rawPrompt?: undefined;
      conceptText?: undefined;
      /** 動画全体の音楽・環境音の指示（任意、シーンビルダー限定・2026-09-15追加）。 */
      musicDirection?: string;
    }
  | {
      userId: string;
      image: File;
      rawPrompt: string;
      rawDurationS: number;
      scenes?: undefined;
      conceptText?: undefined;
      musicDirection?: undefined;
    }
  | {
      // Advanced モード（2026-09-18追加）: 短い日本語の思いつきを渡すと、
      // Qwen（自己ホストVLM）が参照画像を見て台本を書き起こす。
      userId: string;
      image: File;
      conceptText: string;
      rawDurationS: number;
      scenes?: undefined;
      rawPrompt?: undefined;
      musicDirection?: undefined;
    }
) & {
  quality: DirectorQualityMode;
  /** true: 実行中のジョブを待たず並列で今すぐ実行（追加料金）。既定 false = 順番待ち。 */
  priority?: boolean;
  /** true: 予約（順番待ち）。その場で課金し、前のジョブが終わったらサーバーが起動する（タブを閉じても進む）。 */
  queue?: boolean;
  /** LoRA選択（全モード共通、2026-09-18追加）。省略/"none" はLoRAなし。 */
  lora?: DirectorLoraSelection;
};

/** LoRAの指定方法。①trained: LoRA Studioで本人が学習済みのMiniMax H3 LoRA
 * （14日パージ対象）。②upload: 外部で用意した .safetensors——2026-09-19〜、
 * 生成ボタンを押す前に別途アップロードを完了させ、Volume相対パスとして
 * 渡す方式に変更（それまではfileを渡して生成開始時にアップロードして
 * いたが、1GB級のアップロード中にブラウザを閉じるとジョブ自体が一度も
 * 作られないまま止まってしまう問題があり、「アップロード」と「生成」を
 * 明確に別々の操作に分離した——ホスト指摘）。 */
export type DirectorLoraSelection =
  | { source: "none" }
  | { source: "trained"; loraId: string; triggerWord?: string }
  | { source: "upload"; r2Key: string; triggerWord?: string };

export async function startDirectorJob(args: DirectorStartArgs): Promise<DirectorStartResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const { path: storagePath } = await uploadStudioAsset(args.userId, args.image);

  let loraId: string | undefined;
  let loraUploadR2Key: string | undefined;
  if (args.lora?.source === "trained") {
    loraId = args.lora.loraId;
  } else if (args.lora?.source === "upload") {
    loraUploadR2Key = args.lora.r2Key;
  }

  const priority = args.priority ?? false;
  // トリガーワード（2026-10-04）: サーバー／ワーカーが最終の指示文に入っていなければ先頭に足す。
  const loraTriggerWord = args.lora && args.lora.source !== "none" ? args.lora.triggerWord : undefined;
  const loraFields = { loraId, loraUploadR2Key, loraTriggerWord, ...(args.queue ? { queue: true } : {}) };
  const body =
    "conceptText" in args && args.conceptText !== undefined
      ? {
          storagePath,
          conceptText: args.conceptText,
          rawDurationS: args.rawDurationS,
          quality: args.quality,
          priority,
          ...loraFields,
        }
      : "rawPrompt" in args && args.rawPrompt !== undefined
        ? {
            storagePath,
            rawPrompt: args.rawPrompt,
            rawDurationS: args.rawDurationS,
            quality: args.quality,
            priority,
            ...loraFields,
          }
        : {
            storagePath,
            scenes: args.scenes,
            musicDirection: args.musicDirection,
            quality: args.quality,
            priority,
            ...loraFields,
          };

  const res = await fetch("/api/director/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const error: DirectorApiError = new Error(data?.error || "動画生成に失敗しました。");
    if (typeof data?.remainingCredits === "number") error.remainingCredits = data.remainingCredits;
    throw error;
  }
  return {
    jobId: data.jobId as string,
    reserved: data.reserved === true,
    creditsCost: data.creditsCost as number,
    remainingCredits: data.remainingCredits as number,
    totalDurationS: data.totalDurationS as number,
  };
}

/**
 * 完了した動画を元に作り直す（2026-10-01〜）。参照画像・台本・尺・LoRA はサーバーが元のジョブから引き継ぐ。
 *   new_seed  … 別パターン（台本はそのまま、揺れだけ変える）
 *   same_seed … この動画をもとに調整（同じシードで、rawPrompt を書き換えたり画質を変えたりする）
 */
export async function regenerateDirectorJob(args: {
  baseJobId: string;
  variation: "new_seed" | "same_seed";
  rawPrompt?: string;
  rawDurationS?: number;
  quality?: DirectorQualityMode;
  priority?: boolean;
  queue?: boolean;
}): Promise<DirectorStartResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");
  const res = await fetch("/api/director/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...args, priority: args.priority ?? false }),
  });
  const data = await res.json();
  if (!res.ok) {
    const error: DirectorApiError = new Error(data?.error || "動画生成に失敗しました。");
    if (typeof data?.remainingCredits === "number") error.remainingCredits = data.remainingCredits;
    throw error;
  }
  return {
    jobId: data.jobId as string,
    reserved: data.reserved === true,
    creditsCost: data.creditsCost as number,
    remainingCredits: data.remainingCredits as number,
    totalDurationS: data.totalDurationS as number,
  };
}

// 外部LoRA（.safetensors）アップロード。
// 2026-09-18〜10-03 はブラウザ → Modal（modal_lora_worker.py::upload_user_lora）→ Volume の 1 本の接続で送っていたが、
// 日米往復のせいで 1 本あたり約 2.2 Mbps で頭打ちになり（docs/gpu-benchmarks.md §15）、1GB 級に数十分かかった。
// 2026-10-03 から R2 へ 32MB ずつ並行に PUT する（S3 マルチパート、/api/director/loras/r2-upload）。
// 保存はしない前提（R2 は 14 日で消える。使うたびに上げ直せばよい、ホスト判断）。
const DIRECTOR_LORA_MAX_BYTES = 2 * 1024 * 1024 * 1024; // サーバー側の上限（2GB）と合わせる

// 同じ File を連続生成のたびに上げ直さない（ファイルを選び直せば WeakMap から自然に消える）。
const _uploadedLoraCache = new WeakMap<File, string>();

/** アップロードの進捗。loaded/total はファイル全体のバイト数。 */
export type DirectorLoraUploadProgress = (loaded: number, total: number) => void;

const PART_CONCURRENCY = 6;
const PART_ATTEMPTS = 4;
// 進捗が止まったら打ち切って、その部分だけ送り直す（2026-09-19 に「69% で固まりエラーも出ない」を踏んだ）。
const STALL_TIMEOUT_MS = 30_000;

function putPart(
  url: string,
  body: Blob,
  onLoaded: (loaded: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    let stall: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => xhr.abort(), STALL_TIMEOUT_MS);
    };
    const done = () => {
      if (stall) clearTimeout(stall);
    };
    xhr.upload.onprogress = (e) => {
      arm();
      onLoaded(e.loaded);
    };
    xhr.onload = () => {
      done();
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error(`HTTP ${xhr.status}${etag ? "" : "（ETag なし）"}`));
    };
    xhr.onerror = () => {
      done();
      reject(new Error("ネットワークエラー"));
    };
    xhr.onabort = () => {
      done();
      reject(new Error(`${STALL_TIMEOUT_MS / 1000}秒間進まなかった`));
    };
    arm();
    xhr.send(body);
  });
}

async function r2UploadApi(accessToken: string, payload: Record<string, unknown>) {
  const res = await fetch("/api/director/loras/r2-upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `LoRAのアップロードに失敗しました（HTTP ${res.status}）。`);
  return data;
}

/** R2 へ上げて、そのキーを返す（生成のときに loraUploadR2Key として渡す）。 */
export async function uploadDirectorLoraFile(
  file: File,
  onProgress?: DirectorLoraUploadProgress,
): Promise<{ r2Key: string }> {
  const cached = _uploadedLoraCache.get(file);
  if (cached) return { r2Key: cached };

  if (!file.name.toLowerCase().endsWith(".safetensors")) {
    throw new Error(".safetensors ファイルを選んでください。");
  }
  if (file.size > DIRECTOR_LORA_MAX_BYTES) {
    throw new Error("ファイルサイズが大きすぎます（上限2GB）。");
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const t0 = performance.now();
  const start = (await r2UploadApi(accessToken, {
    action: "start",
    filename: file.name,
    size: file.size,
    lastModified: file.lastModified,
  })) as { key: string; exists?: boolean; uploadId: string; partBytes: number; partUrls: string[] };
  // 同じファイルが既に上がっている（同じキーに上書きする作りなので、上げ直しても複製は溜まらない）。
  if (start.exists) {
    onProgress?.(file.size, file.size);
    _uploadedLoraCache.set(file, start.key);
    return { r2Key: start.key };
  }
  const loadedByPart = new Array<number>(start.partUrls.length).fill(0);
  const report = () => onProgress?.(Math.min(file.size, loadedByPart.reduce((a, b) => a + b, 0)), file.size);
  report();

  const etags = new Array<string>(start.partUrls.length);
  let next = 0;
  const worker = async () => {
    while (next < start.partUrls.length) {
      const i = next++;
      const blob = file.slice(i * start.partBytes, Math.min(file.size, (i + 1) * start.partBytes));
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
        try {
          etags[i] = await putPart(start.partUrls[i], blob, (loaded) => {
            loadedByPart[i] = loaded;
            report();
          });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          loadedByPart[i] = 0;
          report();
          console.warn(`[directorApi] LoRA part ${i + 1}/${start.partUrls.length} failed (attempt ${attempt}):`, err);
          if (attempt < PART_ATTEMPTS) await sleep(1500 * attempt);
        }
      }
      if (lastErr) {
        throw new Error(
          `LoRAのアップロードに失敗しました（${lastErr instanceof Error ? lastErr.message : String(lastErr)}）。もう一度お試しください。`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, start.partUrls.length) }, worker));

  await r2UploadApi(accessToken, {
    action: "complete",
    key: start.key,
    uploadId: start.uploadId,
    parts: etags.map((etag, i) => ({ partNumber: i + 1, etag })),
  });
  const sec = (performance.now() - t0) / 1000;
  console.log(
    `[director-lora-upload] ${(file.size / 1e6).toFixed(1)}MB を ${sec.toFixed(1)}秒` +
      `（実効 ${((file.size * 8) / 1e6 / Math.max(sec, 0.001)).toFixed(1)} Mbps・r2・${start.partUrls.length}分割・並列${PART_CONCURRENCY}）`,
  );
  _uploadedLoraCache.set(file, start.key);
  return { r2Key: start.key };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 公開 URL を実ファイルとして保存させる（cross-origin download 対策）。
 * 2026-09-17: videoUrl が旧 data: URI から director-results バケットの公開
 * URL へ移行したため、plain `<a download>` はクロスオリジンで無視される
 * ブラウザがあり得る（downloadUpscaleImage と同じ fetch→blob 方式に統一）。 */
export async function downloadDirectorVideo(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`動画の取得に失敗しました (${res.status})`);
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

export type DirectorJobStatus = {
  jobId: string;
  /** reserved = 予約（順番待ち）。前のジョブが終わるとサーバーが起動して queued へ（2026-10-03）。 */
  status: "reserved" | "queued" | "processing" | "completed" | "failed";
  videoUrl: string | null;
  errorMessage: string | null;
  vramUsedGb: number | null;
  /** 出力解像度（route が生成時に metadata.out_width/out_height へ記録、2026-09-24〜）。 */
  outWidth: number | null;
  outHeight: number | null;
  combinedPrompt: string | null;
  combinedPromptJa: string | null;
  /** 動画のシード（2026-10-01〜のジョブだけ）。 */
  seed: number | null;
  /** 「作り直す」が使えるか（参照画像と台本が記録されている）。 */
  regenerable: boolean;
  /** 生成時の画質（metadata.quality_mode）。作り直しの料金表示に使う。 */
  quality: DirectorQualityMode | null;
  totalDurationS: number | null;
  queue: { queuePosition: number; avgExecutionSeconds: number; estimatedWaitSeconds: number } | null;
};

/** ジョブ行が見つからない（自動 purge 済み・別アカウントのジョブ等）。リトライしても直らないので呼び出し側で区別する。 */
export class DirectorJobNotFoundError extends Error {
  constructor() {
    super("ジョブが見つかりません。");
    this.name = "DirectorJobNotFoundError";
  }
}

export async function pollDirectorJob(jobId: string): Promise<DirectorJobStatus> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const res = await fetch(`/api/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (res.status === 404) throw new DirectorJobNotFoundError();
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "ジョブ状態の取得に失敗しました。");

  const meta = (data.metadata ?? {}) as {
    vram_used_gb?: unknown;
    total_duration_s?: unknown;
    out_width?: unknown;
    out_height?: unknown;
    quality_mode?: unknown;
  };
  const vramUsedGb =
    typeof meta.vram_used_gb === "number" && Number.isFinite(meta.vram_used_gb) ? meta.vram_used_gb : null;

  return {
    jobId: data.jobId as string,
    status: data.status as DirectorJobStatus["status"],
    videoUrl: (data.videoUrl as string | null) ?? null,
    errorMessage: (data.errorMessage as string | null) ?? null,
    vramUsedGb,
    outWidth: typeof meta.out_width === "number" ? meta.out_width : null,
    outHeight: typeof meta.out_height === "number" ? meta.out_height : null,
    combinedPrompt: (data.combinedPrompt as string | null) ?? null,
    combinedPromptJa: (data.combinedPromptJa as string | null) ?? null,
    seed: typeof data.seed === "number" ? data.seed : null,
    regenerable: data.regenerable === true,
    quality: isDirectorQualityMode(data.qualityMode) ? data.qualityMode : isDirectorQualityMode(meta.quality_mode) ? meta.quality_mode : null,
    totalDurationS:
      typeof data.durationS === "number" ? data.durationS : typeof meta.total_duration_s === "number" ? meta.total_duration_s : null,
    queue:
      typeof data.queuePosition === "number"
        ? {
            queuePosition: data.queuePosition as number,
            avgExecutionSeconds: (data.avgExecutionSeconds as number | undefined) ?? 28,
            estimatedWaitSeconds: (data.estimatedWaitSeconds as number | undefined) ?? 0,
          }
        : null,
  };
}
