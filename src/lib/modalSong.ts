import "server-only";

// 曲づくり（2026-10-06）のジョブを Modal（modal_ace_worker.py の song_async）へ投げる。GPU の起動は待たない（spawn して即返る）。
// URL は env MODAL_SONG_URL で上書きでき、無ければデプロイ済みの URL（<workspace>--<app>-<関数名>.modal.run）。

const DEFAULT_SONG_URL = "https://axelbh5--ull-ace-step-song-async.modal.run";

export type SongJobParams = {
  tags: string;
  lyrics: string;
  bpm: number;
  keyscale: string;
  language: string;
  timesignature?: string;
};

/** 予約（studio_dispatch_specs.spec）にもそのまま保存する起動の引数。 */
export type SongDispatchSpec = {
  creditsCost: number;
  count: number;
  seed: number;
  params: SongJobParams;
};

export async function dispatchSongJob(jobId: string, userId: string, spec: SongDispatchSpec): Promise<{ callId: string | null }> {
  const url = process.env.MODAL_SONG_URL || DEFAULT_SONG_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!authToken) throw new Error("MODAL_AUTH_TOKEN が未設定です。");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-modal-secret": authToken },
    body: JSON.stringify({
      job_id: jobId,
      user_id: userId,
      credits_cost: spec.creditsCost,
      count: spec.count,
      seed: spec.seed,
      params: { timesignature: "4", ...spec.params },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Modal dispatch failed (${res.status}): ${text.slice(0, 1000)}`);
  }
  const data = (await res.json()) as { call_id?: string };
  return { callId: data.call_id ?? null };
}
