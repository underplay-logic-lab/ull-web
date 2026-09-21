// ローカルPC -> Modal Volume の直アップロード（admin 専用、2026-09-21）。
//
// それまで admin からモデルを持ち込む手段は「HuggingFace / Civitai の URL を
// 入れて Modal 側に落とさせる」リモートダウンローダだけで、**手元の
// .safetensors（Civitai に無いマージモデル等）を送り込む口が無かった**
// （ホスト指摘）。
//
// 設計は src/lib/directorApi.ts の外部LoRAアップロードと同じ:
//   * ブラウザ -> Modal 直（CLAUDE.md §1・§6-4。Vercel のリクエストボディ
//     上限 4.5MB は変更できないので、7GB 級は API route を通せない）
//   * MODAL_AUTH_TOKEN はブラウザに渡さない。admin 認証済みの Next.js が
//     短命の HMAC 署名 URL を発行する
//   * **レジューム**: 送信済みバイト数をサーバーに聞いて続きから送る。
//     タブのスリープ・回線断でゼロからやり直しにならない
//   * 無反応が続いたら abort して再試行（XHR の stall タイマー）

// ⚠️ modal_lora_worker.py の _ADMIN_UPLOAD_DIRS / _ADMIN_UPLOAD_NAME_RE と
// 必ず同じに保つこと。サーバー側（src/lib/modalStorage.ts）はここから
// 再エクスポートして使う — あちらは "server-only" なので、admin 画面の
// クライアントコンポーネントから直接 import できないため。
export const ADMIN_UPLOAD_DIRS = [
  "diffusion_models",
  "checkpoints",
  "text_encoders",
  "clip",
  "clip_vision",
  "vae",
  "loras",
  "upscale_models",
] as const;
export const ADMIN_UPLOAD_NAME_RE = /^[A-Za-z0-9._-]{1,180}\.(?:safetensors|ckpt|pt|pth|bin|gguf)$/;

export type AdminUploadProgress = (loaded: number, total: number) => void;

// 転送が完全に止まったと見なすまでの時間。大きいファイルほど1チャンクの
// 送信に時間がかかるので、Director 側（60秒）より長めに取る。
const STALL_TIMEOUT_MS = 180_000;
const MAX_UPLOAD_ATTEMPTS = 4;
const RETRY_DELAY_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type UploadTicket = {
  uploadUrl: string;
  statusUrl: string;
  expiresAt: number;
  path: string;
};

async function mintTicket(subdir: string, filename: string): Promise<UploadTicket> {
  const res = await fetch("/api/admin/modal/storage/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subdir, filename }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? "アップロード準備に失敗しました。");
  return data as UploadTicket;
}

function xhrPutWithProgress(
  url: string,
  body: Blob,
  baseLoaded: number,
  total: number,
  onProgress?: AdminUploadProgress,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
    };
    const armStallTimer = () => {
      clearStallTimer();
      stallTimer = setTimeout(() => xhr.abort(), STALL_TIMEOUT_MS);
    };

    xhr.upload.onprogress = (e) => {
      armStallTimer();
      if (onProgress) onProgress(baseLoaded + e.loaded, total);
    };
    xhr.onload = () => {
      clearStallTimer();
      let json: unknown = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // ignore — 呼び出し側がレスポンス内容でエラー文を組み立てる
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, json });
    };
    xhr.onerror = () => {
      clearStallTimer();
      reject(new Error("ネットワークエラーでアップロードに失敗しました。"));
    };
    xhr.onabort = () => {
      clearStallTimer();
      reject(new Error("転送が停止したため中断しました（続きから再開します）。"));
    };

    armStallTimer();
    xhr.send(body);
  });
}

async function attempt(
  file: File,
  subdir: string,
  filename: string,
  onProgress?: AdminUploadProgress,
): Promise<{ path: string; sizeBytes: number }> {
  // 署名は都度取り直す。長いアップロードの途中で TTL が切れても、次の
  // 試行で新しい署名 + 現在の offset から続けられる。
  const ticket = await mintTicket(subdir, filename);

  // 前回どこまで届いているか。確認できなければ 0（＝最初から）で進める。
  let existingBytes = 0;
  try {
    const statusRes = await fetch(ticket.statusUrl);
    if (statusRes.ok) {
      const statusData = await statusRes.json();
      if (typeof statusData?.uploaded_bytes === "number") existingBytes = statusData.uploaded_bytes;
    }
  } catch (err) {
    console.warn("[adminVolumeUpload] status check failed, uploading from scratch:", err);
  }

  if (existingBytes >= file.size) {
    // 前回で最後まで届いていた（レスポンスが返る前に切断された等）。
    if (onProgress) onProgress(file.size, file.size);
    return { path: ticket.path, sizeBytes: file.size };
  }
  if (onProgress) onProgress(existingBytes, file.size);

  const url = new URL(ticket.uploadUrl);
  if (existingBytes > 0) url.searchParams.set("offset", String(existingBytes));
  const body = existingBytes > 0 ? file.slice(existingBytes) : file;

  const { ok, status, json } = await xhrPutWithProgress(
    url.toString(),
    body,
    existingBytes,
    file.size,
    onProgress,
  );
  const result = json as { path?: string; size_bytes?: number; detail?: string } | null;
  if (!ok || !result?.path) {
    throw new Error(result?.detail ?? `アップロードに失敗しました (${status})`);
  }
  return { path: result.path, sizeBytes: result.size_bytes ?? file.size };
}

/** 手元のファイルを Volume の <subdir>/<filename> へ送る。中断しても
 * 同じファイルを選び直せば続きから再開する（サーバー側の実サイズを
 * offset として使うため、部分ファイルが残っていれば自動的に効く）。 */
export async function uploadFileToVolume(
  file: File,
  subdir: string,
  onProgress?: AdminUploadProgress,
): Promise<{ path: string; sizeBytes: number }> {
  const filename = file.name;
  let lastError: Error | null = null;
  for (let i = 1; i <= MAX_UPLOAD_ATTEMPTS; i++) {
    try {
      return await attempt(file, subdir, filename, onProgress);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[adminVolumeUpload] attempt ${i}/${MAX_UPLOAD_ATTEMPTS} failed, resuming:`,
        lastError.message,
      );
      if (i < MAX_UPLOAD_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError ?? new Error("アップロードに失敗しました。");
}
