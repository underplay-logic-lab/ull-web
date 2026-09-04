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

export type ModalLogEntry = {
  ts: number;
  gpu_tier: "standard" | "ultra";
  status: "success" | "failed";
  duration_s: number;
  filename: string | null;
  error: string | null;
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
  | { action: "download_async"; download_id: string; url: string; subfolder: string; filename: string }
  | { action: "download_repo_async"; download_id: string; repo_id: string; save_dir: string }
  | { action: "read_file"; file_path: string }
  | { action: "delete"; file_path: string }
  | { action: "delete_dir"; file_path: string }
  | { action: "install_node"; git_url: string }
  | { action: "logs"; limit?: number };

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

export async function getModalLogs(limit = 100): Promise<ModalLogEntry[]> {
  const result = await callModalStorage<{ entries: ModalLogEntry[] }>({ action: "logs", limit });
  return result.entries;
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
function adminEndpoint(scope: "file" | "zip"): string {
  const explicit =
    scope === "file"
      ? process.env.MODAL_ADMIN_VOLUME_DOWNLOAD_URL
      : process.env.MODAL_ADMIN_VOLUME_ZIP_URL;
  if (explicit) return explicit;
  const base = process.env.MODAL_LORA_CHECKPOINT_DOWNLOAD_URL;
  if (!base) throw new Error("Modal is not configured (missing MODAL_LORA_CHECKPOINT_DOWNLOAD_URL).");
  const fn = scope === "file" ? "admin-download-volume-file" : "admin-zip-volume-folder";
  return base.replace("download-lora-checkpoint", fn);
}

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
