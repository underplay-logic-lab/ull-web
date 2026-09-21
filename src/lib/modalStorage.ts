import "server-only";
import crypto from "crypto";
import { formatBytes } from "@/lib/modelVram";

export type VolumeFile = {
  path: string;
  size_bytes: number;
  // Alias of size_bytes + a pre-formatted human string ("63.2 GB"),
  // computed server-side so every consumer (model pickers, capacity
  // checker) has them without re-deriving.
  size: number;
  formattedSize: string;
  modified_at: string;
};

// modified_at は「直下の中身が最後に変わった時刻」。Linux では作成日時
// （st_birthtime）が取れないため、フォルダについてはこれが出せる唯一の日時。
// 学習ジョブフォルダの本当の作成日時は generation_jobs.created_at 側
// （/api/admin/modal/storage/labels）で解決している。
export type VolumeDirEntry = { name: string; path: string; modified_at?: string };

export type VolumeDirListing = {
  path: string;
  dirs: VolumeDirEntry[];
  files: Array<VolumeFile & { name: string }>;
};

// Same admin-only model-file subfolders the Modal image symlinks into
// ComfyUI's models/ dir (see MODEL_SUBFOLDERS in scripts/modal_wan_animate.py).
export const MODEL_SUBFOLDERS = ["diffusion_models", "text_encoders", "clip_vision", "vae", "loras"] as const;
export type ModelSubfolder = (typeof MODEL_SUBFOLDERS)[number];

const MODAL_STORAGE_TIMEOUT_MS = 30_000;
// Cloning a custom node / streaming a large model file can run well past
// the default timeout.
const MODAL_STORAGE_LONG_TIMEOUT_MS = 180_000;

type ModalStorageAction =
  | { action: "list" }
  | { action: "list_dir"; path: string }
  | { action: "total_usage" }
  | { action: "dir_stats"; paths: string[] }
  | { action: "thumbnail"; file_path: string }
  | { action: "download_async"; download_id: string; url: string; subfolder: string; filename: string }
  | { action: "download_repo_async"; download_id: string; repo_id: string; save_dir: string }
  | { action: "read_file"; file_path: string }
  | { action: "delete"; file_path: string }
  | { action: "delete_dir"; file_path: string }
  | { action: "install_node"; git_url: string };

async function callModalStorage<T>(body: ModalStorageAction, timeoutMs = MODAL_STORAGE_TIMEOUT_MS): Promise<T> {
  const url = process.env.MODAL_STORAGE_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!url) {
    throw new Error("Modal is not configured (missing MODAL_STORAGE_URL).");
  }
  if (!authToken) {
    throw new Error("Modal is not configured (missing MODAL_AUTH_TOKEN).");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-modal-secret": authToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Modal storage request failed (${res.status}): ${text.slice(0, 2000)}`);
  }

  return (await res.json()) as T;
}

export async function listVolumeFiles(): Promise<VolumeFile[]> {
  const result = await callModalStorage<{ files: Array<Omit<VolumeFile, "size" | "formattedSize">> }>({
    action: "list",
  });
  // Modal returns only size_bytes — normalise every row so `size` and
  // `formattedSize` are always present downstream.
  return (result.files ?? []).map((f) => {
    const bytes = typeof f.size_bytes === "number" ? f.size_bytes : 0;
    return { ...f, size_bytes: bytes, size: bytes, formattedSize: formatBytes(bytes) };
  });
}

// 2026-09-19導入: 遅延読み込み版の1階層取得。listVolumeFiles()（Volume全体を
// os.walkする"list"アクション）は、実運用規模（数千ファイル）では admin
// ファイルエクスプローラーを開くだけで数秒〜十数秒かかっていた。こちらは
// 指定ディレクトリの直下だけを見るので、開いたフォルダの分しかコストが
// かからない。
export async function listVolumeDir(path: string): Promise<VolumeDirListing> {
  const result = await callModalStorage<{
    path: string;
    dirs: VolumeDirEntry[];
    files: Array<{ name: string; path: string; size_bytes: number; modified_at: string }>;
  }>({ action: "list_dir", path });
  const files = (result.files ?? []).map((f) => {
    const bytes = typeof f.size_bytes === "number" ? f.size_bytes : 0;
    return { ...f, size_bytes: bytes, size: bytes, formattedSize: formatBytes(bytes) };
  });
  return { path: result.path ?? path, dirs: result.dirs ?? [], files };
}

// 画像・動画の小さな JPEG サムネイル（Modal 側で ffmpeg が1フレーム抜き、
// Volume にキャッシュする）。動画プレビューで本体を丸ごと中継しないために使う。
export async function getVolumeThumbnail(filePath: string): Promise<Buffer> {
  const result = await callModalStorage<{ filename: string; base64: string }>({
    action: "thumbnail",
    file_path: filePath,
  });
  return Buffer.from(result.base64 ?? "", "base64");
}

export type VolumeDirStat = { files: number; bytes: number; truncated: boolean };

// 2026-09-21: フォルダ行の「ファイル数 / 容量」表示の復活用（e271c62 の遅延
// 読み込み化で消えていた）。今開いているフォルダの子ディレクトリぶんだけを
// まとめて集計する。UI は一覧を描画してから後追いで呼ぶので、開く速度は
// 落ちない。1フォルダ2万エントリで打ち切り（truncated=true）。
export async function getVolumeDirStats(
  paths: string[],
): Promise<Record<string, VolumeDirStat>> {
  if (paths.length === 0) return {};
  const result = await callModalStorage<{ stats: Record<string, VolumeDirStat> }>(
    { action: "dir_stats", paths },
    MODAL_STORAGE_LONG_TIMEOUT_MS,
  );
  return result.stats ?? {};
}

// Volume全体の実使用量。os.walkする重い処理なので明示的にadminが要求した
// 時だけ呼ぶ（listVolumeDir によるツリー閲覧の既定経路には含めない）。
export async function getVolumeTotalUsage(): Promise<{ totalBytes: number; totalFiles: number }> {
  const result = await callModalStorage<{ total_bytes: number; total_files: number }>(
    { action: "total_usage" },
    MODAL_STORAGE_LONG_TIMEOUT_MS,
  );
  return { totalBytes: result.total_bytes ?? 0, totalFiles: result.total_files ?? 0 };
}

// Triggers the background download (see download_model_async in
// scripts/modal_wan_animate.py) and returns as soon as Modal has accepted
// the .spawn() call — the transfer itself happens out of band, with
// progress reported into the model_downloads row identified by downloadId
// (created by the caller before this is invoked; see POST
// /api/admin/modal/storage). Uses the short default timeout since this
// request no longer waits on the actual file transfer.
export async function spawnDownloadToVolume(
  downloadId: string,
  url: string,
  subfolder: string,
  filename: string,
): Promise<{ ok: true; spawned: true }> {
  return callModalStorage({ action: "download_async", download_id: downloadId, url, subfolder, filename });
}

// Triggers the background repo-wide download (see download_repo_async in
// scripts/modal_wan_animate.py) — same spawn-and-return-immediately shape as
// spawnDownloadToVolume above, but for an entire Hugging Face repo
// (snapshot_download) instead of a single file.
export async function spawnRepoDownloadToVolume(
  downloadId: string,
  repoId: string,
  saveDir: string,
): Promise<{ ok: true; spawned: true }> {
  return callModalStorage({ action: "download_repo_async", download_id: downloadId, repo_id: repoId, save_dir: saveDir });
}

export async function readVolumeFile(filePath: string): Promise<{ filename: string; base64: string }> {
  return callModalStorage({ action: "read_file", file_path: filePath }, MODAL_STORAGE_LONG_TIMEOUT_MS);
}

export async function deleteVolumeFile(filePath: string): Promise<{ ok: true }> {
  return callModalStorage({ action: "delete", file_path: filePath });
}

export async function deleteVolumeDir(filePath: string): Promise<{ ok: true }> {
  return callModalStorage({ action: "delete_dir", file_path: filePath }, MODAL_STORAGE_LONG_TIMEOUT_MS);
}

export async function installCustomNode(gitUrl: string): Promise<{ ok: true; name: string }> {
  return callModalStorage({ action: "install_node", git_url: gitUrl }, MODAL_STORAGE_LONG_TIMEOUT_MS);
}

// --- Direct browser<->Modal signed downloads (admin file explorer) --------
//
// The base64-through-Next.js path (readVolumeFile) OOMs / times out a Vercel
// function on GB-scale .safetensors. Instead the browser hits the Modal
// endpoint directly (hidden <iframe>) with a short-lived HMAC token this
// helper mints — same design as /api/studio/lora/checkpoint.
const ADMIN_DL_TOKEN_TTL_S = 900;

// Modal deploy URL: <workspace>--<app>-<function-name-kebab>.modal.run.
// Derived from the checkpoint URL so no new env var is required (override
// with MODAL_ADMIN_VOLUME_DOWNLOAD_URL / _ZIP_URL if the pattern ever shifts).
function adminEndpoint(scope: "file" | "zip" | "upload" | "upload-status"): string {
  const explicit =
    scope === "file"
      ? process.env.MODAL_ADMIN_VOLUME_DOWNLOAD_URL
      : scope === "zip"
        ? process.env.MODAL_ADMIN_VOLUME_ZIP_URL
        : undefined;
  if (explicit) return explicit;
  const base = process.env.MODAL_LORA_CHECKPOINT_DOWNLOAD_URL;
  if (!base) throw new Error("Modal is not configured (missing MODAL_LORA_CHECKPOINT_DOWNLOAD_URL).");
  const fn =
    scope === "file"
      ? "admin-download-volume-file"
      : scope === "zip"
        ? "admin-zip-volume-folder"
        : scope === "upload"
          ? "admin-upload-volume-file"
          : "admin-upload-volume-status";
  return base.replace("download-lora-checkpoint", fn);
}

// ローカルPC -> Volume の直アップロード（2026-09-21）。ブラウザは
// MODAL_AUTH_TOKEN を持たないので、admin 認証済みの Next.js 側で短命の
// HMAC 署名 URL を作って渡す（ダウンロード側と同じ設計）。
// アップロード自体は Vercel を経由せずブラウザから Modal へ直接投げる
// （CLAUDE.md §1・§6-4: リクエストボディ 4.5MB 上限を避ける）。
// `uploadUrl` は PUT・レジューム用に ?offset= を足して使う。
// TTL は 15分だが、Modal 側は署名の expires しか見ないので、長いアップロード
// の途中で失効した場合はクライアントが再発行して offset から再開する。
export function signAdminVolumeUploadUrls(relPath: string): {
  uploadUrl: string;
  statusUrl: string;
  expiresAt: number;
} {
  const secret = process.env.MODAL_AUTH_TOKEN;
  if (!secret) throw new Error("Modal is not configured (missing MODAL_AUTH_TOKEN).");
  const path = relPath.replace(/^\/+/, "");
  const expires = Math.floor(Date.now() / 1000) + ADMIN_DL_TOKEN_TTL_S;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`admin:upload:${path}:${expires}`)
    .digest("hex");
  const build = (scope: "upload" | "upload-status") => {
    const u = new URL(adminEndpoint(scope));
    u.searchParams.set("path", path);
    u.searchParams.set("expires", String(expires));
    u.searchParams.set("sig", sig);
    return u.toString();
  };
  return { uploadUrl: build("upload"), statusUrl: build("upload-status"), expiresAt: expires };
}

// 保存先ホワイトリストとファイル名規則は client 側と共有する
// （このファイルは "server-only" なので admin 画面から直接 import できない）。
export { ADMIN_UPLOAD_DIRS, ADMIN_UPLOAD_NAME_RE } from "@/lib/adminVolumeUpload";

// Returns a ~15-minute signed URL that streams a Volume file (scope "file")
// or a CPU-built ZIP of a Volume folder (scope "zip") straight to the browser.
export function signAdminVolumeUrl(scope: "file" | "zip", relPath: string): string {
  const secret = process.env.MODAL_AUTH_TOKEN;
  if (!secret) throw new Error("Modal is not configured (missing MODAL_AUTH_TOKEN).");
  const path = relPath.replace(/^\/+/, "");
  const expires = Math.floor(Date.now() / 1000) + ADMIN_DL_TOKEN_TTL_S;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`admin:${scope}:${path}:${expires}`)
    .digest("hex");
  const u = new URL(adminEndpoint(scope));
  u.searchParams.set("path", path);
  u.searchParams.set("expires", String(expires));
  u.searchParams.set("sig", sig);
  return u.toString();
}

// Signed URL for admin_download_job_artifact — resolves the ACTUAL file for a
// job (final weights / all-checkpoint zip / dataset zip) wherever it landed
// (loras/<user>/<job_id>/ or /<call_id>/, salvaged_ prefixes, …). `probe`
// returns JSON {found, filename, size_bytes} instead of streaming.
export function signJobArtifactUrl(
  want: "final" | "bundle" | "dataset",
  userId: string,
  jobId: string,
  opts: { callId?: string; probe?: boolean } = {},
): string {
  const secret = process.env.MODAL_AUTH_TOKEN;
  if (!secret) throw new Error("Modal is not configured (missing MODAL_AUTH_TOKEN).");
  const base = process.env.MODAL_LORA_CHECKPOINT_DOWNLOAD_URL;
  if (!base) throw new Error("Modal is not configured (missing MODAL_LORA_CHECKPOINT_DOWNLOAD_URL).");
  const expires = Math.floor(Date.now() / 1000) + ADMIN_DL_TOKEN_TTL_S;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`admin:artifact:${want}:${userId}:${jobId}:${expires}`)
    .digest("hex");
  const u = new URL(base.replace("download-lora-checkpoint", "admin-download-job-artifact"));
  u.searchParams.set("user_id", userId);
  u.searchParams.set("job_id", jobId);
  u.searchParams.set("want", want);
  u.searchParams.set("expires", String(expires));
  u.searchParams.set("sig", sig);
  if (opts.callId) u.searchParams.set("call_id", opts.callId);
  if (opts.probe) u.searchParams.set("probe", "1");
  return u.toString();
}

// Signed URL for download_lora_selection — the worker resolves each named
// checkpoint under loras/<user>/<job_id>/, stitches them into ONE
// uncompressed (ZIP_STORED) zip in /tmp and streams that (4 MiB chunks,
// BackgroundTask cleanup). `files` is sorted + comma-joined so the same
// string is both signed here and re-hashed by the worker.
export function signJobSelectionZipUrl(userId: string, jobId: string, files: string[]): string {
  const secret = process.env.MODAL_AUTH_TOKEN;
  if (!secret) throw new Error("Modal is not configured (missing MODAL_AUTH_TOKEN).");
  const base = process.env.MODAL_LORA_CHECKPOINT_DOWNLOAD_URL;
  if (!base) throw new Error("Modal is not configured (missing MODAL_LORA_CHECKPOINT_DOWNLOAD_URL).");
  const joined = [...files].sort().join(",");
  const expires = Math.floor(Date.now() / 1000) + ADMIN_DL_TOKEN_TTL_S;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`selection:${userId}:${jobId}:${joined}:${expires}`)
    .digest("hex");
  const u = new URL(base.replace("download-lora-checkpoint", "download-lora-selection"));
  u.searchParams.set("user_id", userId);
  u.searchParams.set("job_id", jobId);
  u.searchParams.set("files", joined);
  u.searchParams.set("expires", String(expires));
  u.searchParams.set("sig", sig);
  return u.toString();
}
