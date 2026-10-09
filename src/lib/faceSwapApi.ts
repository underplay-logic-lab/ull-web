import { supabase } from "@/lib/supabaseClient";
import type { FaceSwapSide } from "@/lib/faceSwapPricing";

// 顔入れ替え（2026-10-09・許可制）の画面側 API。開始は /api/studio/face-swap、状態は共通の /api/jobs/[id]。
// 画像は先に uploadStudioAsset で R2 へ上げ、ここには path だけを渡す（CLAUDE.md §6-4）。

export type FaceSwapApiError = Error & { remainingCredits?: number };

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("ログインが必要です。");
  return t;
}

export async function startFaceSwapJob(args: {
  bodyPath: string;
  swaps: { facePath: string; side: FaceSwapSide }[];
  priority?: boolean;
  queue?: boolean;
}): Promise<{ jobId: string; reserved: boolean; creditsCost: number; remainingCredits: number }> {
  const res = await fetch("/api/studio/face-swap", {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e: FaceSwapApiError = new Error(data?.error || "顔入れ替えの開始に失敗しました。");
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

export type FaceSwapJobStatus = {
  jobId: string;
  status: "reserved" | "queued" | "processing" | "completed" | "failed" | "cancelled" | "failed_timeout";
  errorMessage: string | null;
  progressMessage: string | null;
  vramUsedGb: number | null;
  imageUrls: string[];
};

export class FaceSwapJobNotFoundError extends Error {
  constructor() {
    super("ジョブが見つかりません。");
    this.name = "FaceSwapJobNotFoundError";
  }
}

export async function pollFaceSwapJob(jobId: string): Promise<FaceSwapJobStatus> {
  const res = await fetch(`/api/jobs/${jobId}`, { headers: { Authorization: `Bearer ${await token()}` }, cache: "no-store" });
  if (res.status === 404) throw new FaceSwapJobNotFoundError();
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "ジョブ状態の取得に失敗しました。");
  const meta = (data.metadata ?? {}) as { vram_used_gb?: unknown };
  return {
    jobId: data.jobId as string,
    status: data.status as FaceSwapJobStatus["status"],
    errorMessage: (data.errorMessage as string | null) ?? null,
    progressMessage: (data.progressMessage as string | null) ?? null,
    vramUsedGb: typeof meta.vram_used_gb === "number" ? meta.vram_used_gb : null,
    imageUrls: Array.isArray(data.imageUrls) ? (data.imageUrls as unknown[]).filter((u): u is string => typeof u === "string") : [],
  };
}

/** 署名付き URL の画像を取得する（保存・入れ替え先への流用に使う）。 */
export async function fetchFaceSwapImage(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`画像の取得に失敗しました (${res.status})`);
  return res.blob();
}

/** Blob を実ファイルとして保存させる（クロスオリジンの <a download> が効かないブラウザ対策、他タブと同じ fetch→blob）。 */
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
