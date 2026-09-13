import { supabase } from "@/lib/supabaseClient";
import { uploadStudioAsset } from "@/lib/studioUploads";
import type { DirectorScene } from "@/lib/directorPricing";

export type DirectorApiError = Error & { remainingCredits?: number };

export type DirectorStartResult = {
  jobId: string;
  creditsCost: number;
  remainingCredits: number;
  totalDurationS: number;
};

export async function startDirectorJob(args: {
  userId: string;
  image: File;
  scenes: DirectorScene[];
}): Promise<DirectorStartResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const { path: storagePath } = await uploadStudioAsset(args.userId, args.image);

  const res = await fetch("/api/director/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ storagePath, scenes: args.scenes }),
  });
  const data = await res.json();
  if (!res.ok) {
    const error: DirectorApiError = new Error(data?.error || "動画生成に失敗しました。");
    if (typeof data?.remainingCredits === "number") error.remainingCredits = data.remainingCredits;
    throw error;
  }
  return {
    jobId: data.jobId as string,
    creditsCost: data.creditsCost as number,
    remainingCredits: data.remainingCredits as number,
    totalDurationS: data.totalDurationS as number,
  };
}

export type DirectorJobStatus = {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  videoUrl: string | null;
  errorMessage: string | null;
  vramUsedGb: number | null;
  queue: { queuePosition: number; avgExecutionSeconds: number; estimatedWaitSeconds: number } | null;
};

export async function pollDirectorJob(jobId: string): Promise<DirectorJobStatus> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const res = await fetch(`/api/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "ジョブ状態の取得に失敗しました。");

  const meta = (data.metadata ?? {}) as { vram_used_gb?: unknown };
  const vramUsedGb =
    typeof meta.vram_used_gb === "number" && Number.isFinite(meta.vram_used_gb) ? meta.vram_used_gb : null;

  return {
    jobId: data.jobId as string,
    status: data.status as DirectorJobStatus["status"],
    videoUrl: (data.videoUrl as string | null) ?? null,
    errorMessage: (data.errorMessage as string | null) ?? null,
    vramUsedGb,
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
