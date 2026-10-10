import { supabase } from "@/lib/supabaseClient";
import type { SongVoiceId } from "@/lib/songPricing";
import { warmRefundOf } from "@/lib/warmRefundNote";

// 曲づくり（2026-10-06）の画面側 API。生成は /api/song/generate、状態は共通の /api/jobs/[id]。

export type SongApiError = Error & { remainingCredits?: number; code?: string };
export type SongPlanView = { title: string; lyrics: string; tags: string; bpm: number; keyscale: string };

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("ログインが必要です。");
  return t;
}

export async function startSongJob(args: {
  mode: "idea" | "lyrics";
  idea?: string;
  lyrics?: string;
  style?: string;
  voice: SongVoiceId;
  voiceStyle?: string;
  count: number;
  parts?: number;
  priority?: boolean;
  queue?: boolean;
}): Promise<{ jobId: string; reserved: boolean; creditsCost: number; remainingCredits: number; plan: SongPlanView | null }> {
  const res = await fetch("/api/song/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e: SongApiError = new Error(data?.error || "曲づくりの開始に失敗しました。");
    if (typeof data?.remainingCredits === "number") e.remainingCredits = data.remainingCredits;
    if (typeof data?.code === "string") e.code = data.code;
    throw e;
  }
  return {
    jobId: data.jobId as string,
    reserved: data.reserved === true,
    creditsCost: data.creditsCost as number,
    remainingCredits: data.remainingCredits as number,
    plan: (data.plan as SongPlanView | undefined) ?? null,
  };
}

export type SongJobStatus = {
  jobId: string;
  status: "reserved" | "queued" | "processing" | "completed" | "failed" | "cancelled" | "failed_timeout";
  errorMessage: string | null;
  progressMessage: string | null;
  progressPercent: number | null;
  vramUsedGb: number | null;
  /** 温まり返金（2026-10-10）: 温まったコンテナで動いて、完了時に返した額（無ければ null）。 */
  warmRefundCredits: number | null;
  audioUrls: string[];
  /** WAV（無いジョブは空）。並びは audioUrls と同じ。 */
  audioWavUrls: string[];
  title: string | null;
  lyrics: string | null;
  /** 曲ごとのシード（保存するファイル名に入れる）。 */
  seeds: (number | null)[];
};

export class SongJobNotFoundError extends Error {
  constructor() {
    super("ジョブが見つかりません。");
    this.name = "SongJobNotFoundError";
  }
}

export async function pollSongJob(jobId: string): Promise<SongJobStatus> {
  const res = await fetch(`/api/jobs/${jobId}`, { headers: { Authorization: `Bearer ${await token()}` }, cache: "no-store" });
  if (res.status === 404) throw new SongJobNotFoundError();
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "ジョブ状態の取得に失敗しました。");
  const meta = (data.metadata ?? {}) as { vram_used_gb?: unknown };
  return {
    jobId: data.jobId as string,
    status: data.status as SongJobStatus["status"],
    errorMessage: (data.errorMessage as string | null) ?? null,
    progressMessage: (data.progressMessage as string | null) ?? null,
    progressPercent: typeof data.progressPercent === "number" ? data.progressPercent : null,
    vramUsedGb: typeof meta.vram_used_gb === "number" ? meta.vram_used_gb : null,
    warmRefundCredits: warmRefundOf(data.metadata),
    audioUrls: Array.isArray(data.audioUrls) ? (data.audioUrls as unknown[]).filter((u): u is string => typeof u === "string") : [],
    audioWavUrls: Array.isArray(data.audioWavUrls)
      ? (data.audioWavUrls as unknown[]).filter((u): u is string => typeof u === "string")
      : [],
    title: (data.songTitle as string | null) ?? null,
    lyrics: (data.songLyrics as string | null) ?? null,
    seeds: Array.isArray(data.songSeeds) ? (data.songSeeds as unknown[]).map((s) => (typeof s === "number" ? s : null)) : [],
  };
}

/** 署名付き URL を実ファイルとして保存させる（クロスオリジンの <a download> が効かないブラウザ対策、他タブと同じ fetch→blob）。 */
export async function downloadSong(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`曲の取得に失敗しました (${res.status})`);
  const objectUrl = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}
