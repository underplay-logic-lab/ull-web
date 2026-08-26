import { supabase } from "@/lib/supabaseClient";
import type { CinematicModeId } from "@/lib/cinematicPricing";

export type CinematicGenerateParams = {
  image: Blob;
  mode: CinematicModeId;
  prompt: string;
};

// generateCinematicVideo now only starts the job (see
// /api/generate/cinematic) — it no longer waits for the render itself, so
// this returns a jobId to poll rather than a playable video URL. Use
// pollCinematicJob below to watch it through to completion.
export type CinematicStartResult = {
  jobId: string;
  remainingCredits: number;
};

export type CinematicApiError = Error & { remainingCredits?: number };

export async function generateCinematicVideo(
  params: CinematicGenerateParams,
): Promise<CinematicStartResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;

  if (!accessToken) {
    throw new Error("ログインが必要です。");
  }

  const formData = new FormData();
  formData.append("image", params.image, "reference.png");
  formData.append("mode", params.mode);
  formData.append("prompt", params.prompt);

  const res = await fetch("/api/generate/cinematic", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: formData,
  });

  const data = await res.json();

  if (!res.ok) {
    const error: CinematicApiError = new Error(data?.error || "動画生成に失敗しました。");
    if (typeof data?.remainingCredits === "number") {
      error.remainingCredits = data.remainingCredits;
    }
    throw error;
  }

  return { jobId: data.jobId as string, remainingCredits: data.remainingCredits as number };
}

export type CinematicJobStatus = {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  videoUrl: string | null;
  errorMessage: string | null;
};

// Single poll of a job's current state — see /api/jobs/[id]. The caller
// (CinematicVideoTab.tsx) drives the actual polling interval/loop; this is
// deliberately just one fetch so that loop stays fully in the component
// where it can be cancelled cleanly on unmount.
export async function pollCinematicJob(jobId: string): Promise<CinematicJobStatus> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new Error("ログインが必要です。");
  }

  const res = await fetch(`/api/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error || "ジョブ状態の取得に失敗しました。");
  }

  return {
    jobId: data.jobId as string,
    status: data.status as CinematicJobStatus["status"],
    videoUrl: (data.videoUrl as string | null) ?? null,
    errorMessage: (data.errorMessage as string | null) ?? null,
  };
}
