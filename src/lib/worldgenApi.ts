import { supabase } from "@/lib/supabaseClient";

// 背景づくり（WorldGen・2026-10-10・許可制）の画面側 API。開始は /api/studio/worldgen、状態は共通の /api/jobs/[id]。
// 部屋の画像は先に uploadStudioAsset で R2 へ上げ、ここには path だけを渡す（CLAUDE.md §6-4）。

export type WorldgenApiError = Error & { remainingCredits?: number };

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("ログインが必要です。");
  return t;
}

export async function startWorldgenJob(args: {
  mode: "t2s" | "i2s";
  prompt?: string;
  imagePath?: string;
  priority?: boolean;
  queue?: boolean;
}): Promise<{ jobId: string; reserved: boolean; creditsCost: number; remainingCredits: number }> {
  const res = await fetch("/api/studio/worldgen", {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e: WorldgenApiError = new Error(data?.error || "背景づくりの開始に失敗しました。");
    if (typeof data?.remainingCredits === "number") e.remainingCredits = data.remainingCredits;
    throw e;
  }
  return {
    jobId: data.jobId as string,
    reserved: data.reserved === true,
    creditsCost: data.creditsCost as number,
    remainingCredits: data.remainingCredits as number,
  };
}

export type WorldgenJobStatus = {
  jobId: string;
  status: "reserved" | "queued" | "processing" | "completed" | "failed" | "cancelled" | "failed_timeout";
  errorMessage: string | null;
  progressMessage: string | null;
  vramUsedGb: number | null;
  /** 360 度パノラマ（正距円筒）の署名 URL。 */
  panoUrl: string | null;
  /** 3DGS（.ply）の署名 URL。 */
  plyUrl: string | null;
};

export class WorldgenJobNotFoundError extends Error {
  constructor() {
    super("ジョブが見つかりません。");
    this.name = "WorldgenJobNotFoundError";
  }
}

export async function pollWorldgenJob(jobId: string): Promise<WorldgenJobStatus> {
  const res = await fetch(`/api/jobs/${jobId}`, { headers: { Authorization: `Bearer ${await token()}` }, cache: "no-store" });
  if (res.status === 404) throw new WorldgenJobNotFoundError();
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "ジョブ状態の取得に失敗しました。");
  const meta = (data.metadata ?? {}) as { vram_used_gb?: unknown };
  const urls = Array.isArray(data.imageUrls) ? (data.imageUrls as unknown[]).filter((u): u is string => typeof u === "string") : [];
  return {
    jobId: data.jobId as string,
    status: data.status as WorldgenJobStatus["status"],
    errorMessage: (data.errorMessage as string | null) ?? null,
    progressMessage: (data.progressMessage as string | null) ?? null,
    vramUsedGb: typeof meta.vram_used_gb === "number" ? meta.vram_used_gb : null,
    panoUrl: urls[0] ?? null,
    plyUrl: typeof data.plyUrl === "string" ? data.plyUrl : null,
  };
}

/** 署名付き URL のファイルを Blob で取る（保存・表示用）。 */
export async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ファイルの取得に失敗しました (${res.status})`);
  return res.blob();
}

/** Blob を実ファイルとして保存させる。 */
export function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}
