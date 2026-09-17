import { supabase } from "@/lib/supabaseClient";
import { uploadStudioAsset } from "@/lib/studioUploads";
import type { DirectorQualityMode, DirectorScene } from "@/lib/directorPricing";

export type DirectorApiError = Error & { remainingCredits?: number };

export type DirectorStartResult = {
  jobId: string;
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
      /** 動画全体の音楽・環境音の指示（任意、シーンビルダー限定・2026-09-15追加）。 */
      musicDirection?: string;
    }
  | { userId: string; image: File; rawPrompt: string; rawDurationS: number; scenes?: undefined; musicDirection?: undefined }
) & {
  quality: DirectorQualityMode;
  /** true: 実行中のジョブを待たず並列で今すぐ実行（追加料金）。既定 false = 順番待ち。 */
  priority?: boolean;
};

export async function startDirectorJob(args: DirectorStartArgs): Promise<DirectorStartResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const { path: storagePath } = await uploadStudioAsset(args.userId, args.image);

  const priority = args.priority ?? false;
  const body =
    "rawPrompt" in args && args.rawPrompt !== undefined
      ? { storagePath, rawPrompt: args.rawPrompt, rawDurationS: args.rawDurationS, quality: args.quality, priority }
      : {
          storagePath,
          scenes: args.scenes,
          musicDirection: args.musicDirection,
          quality: args.quality,
          priority,
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
    creditsCost: data.creditsCost as number,
    remainingCredits: data.remainingCredits as number,
    totalDurationS: data.totalDurationS as number,
  };
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
  status: "queued" | "processing" | "completed" | "failed";
  videoUrl: string | null;
  errorMessage: string | null;
  vramUsedGb: number | null;
  combinedPrompt: string | null;
  combinedPromptJa: string | null;
  totalDurationS: number | null;
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

  const meta = (data.metadata ?? {}) as { vram_used_gb?: unknown; total_duration_s?: unknown };
  const vramUsedGb =
    typeof meta.vram_used_gb === "number" && Number.isFinite(meta.vram_used_gb) ? meta.vram_used_gb : null;

  return {
    jobId: data.jobId as string,
    status: data.status as DirectorJobStatus["status"],
    videoUrl: (data.videoUrl as string | null) ?? null,
    errorMessage: (data.errorMessage as string | null) ?? null,
    vramUsedGb,
    combinedPrompt: (data.combinedPrompt as string | null) ?? null,
    combinedPromptJa: (data.combinedPromptJa as string | null) ?? null,
    totalDurationS: typeof meta.total_duration_s === "number" ? meta.total_duration_s : null,
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
