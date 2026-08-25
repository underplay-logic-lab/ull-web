import "server-only";

export type VolumeFile = {
  path: string;
  size_bytes: number;
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
  const result = await callModalStorage<{ files: VolumeFile[] }>({ action: "list" });
  return result.files;
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
