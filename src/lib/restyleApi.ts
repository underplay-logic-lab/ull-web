import { supabase } from "@/lib/supabaseClient";
import type { RestyleKeepId, RestyleStyleId } from "@/lib/restylePricing";
import { warmRefundOf } from "@/lib/warmRefundNote";

// 画風を変える（構図そのまま・2026-10-10・許可制）の画面側 API。開始は /api/studio/restyle、状態は共通の /api/jobs/[id]。
// 画像は先に uploadStudioAsset で R2 へ上げ、ここには path だけを渡す（CLAUDE.md §6-4）。

export type RestyleApiError = Error & { remainingCredits?: number };

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("ログインが必要です。");
  return t;
}

export async function startRestyleJob(args: {
  imagePath: string;
  style: RestyleStyleId;
  freeStyle?: string;
  keep: RestyleKeepId;
  count: number;
  priority?: boolean;
  queue?: boolean;
}): Promise<{ jobId: string; reserved: boolean; creditsCost: number; remainingCredits: number }> {
  const res = await fetch("/api/studio/restyle", {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e: RestyleApiError = new Error(data?.error || "描き直しの開始に失敗しました。");
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

export type RestyleJobStatus = {
  jobId: string;
  status: "reserved" | "queued" | "processing" | "completed" | "failed" | "cancelled" | "failed_timeout";
  errorMessage: string | null;
  progressMessage: string | null;
  vramUsedGb: number | null;
  /** 温まり返金（2026-10-10）: 完了時に返した額（無ければ null）。 */
  warmRefundCredits: number | null;
  /** 署名付き URL（完了時のみ・15 分で切れるので使い回さない、CLAUDE.md §6-11）。 */
  imageUrls: string[];
};

export class RestyleJobNotFoundError extends Error {
  constructor() {
    super("ジョブが見つかりません。");
    this.name = "RestyleJobNotFoundError";
  }
}

export async function pollRestyleJob(jobId: string): Promise<RestyleJobStatus> {
  const res = await fetch(`/api/jobs/${jobId}`, { headers: { Authorization: `Bearer ${await token()}` }, cache: "no-store" });
  if (res.status === 404) throw new RestyleJobNotFoundError();
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "ジョブ状態の取得に失敗しました。");
  const meta = (data.metadata ?? {}) as { vram_used_gb?: unknown };
  return {
    jobId: data.jobId as string,
    status: data.status as RestyleJobStatus["status"],
    errorMessage: (data.errorMessage as string | null) ?? null,
    progressMessage: (data.progressMessage as string | null) ?? null,
    vramUsedGb: typeof meta.vram_used_gb === "number" ? meta.vram_used_gb : null,
    warmRefundCredits: warmRefundOf(data.metadata),
    imageUrls: Array.isArray(data.imageUrls) ? (data.imageUrls as unknown[]).filter((u): u is string => typeof u === "string") : [],
  };
}
