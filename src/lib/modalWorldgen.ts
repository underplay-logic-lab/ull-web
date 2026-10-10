import "server-only";

// 背景づくり（WorldGen・2026-10-10）のジョブを Modal（modal_worldgen_worker.py の worldgen_async）へ投げる。GPU の起動は待たない。
// URL は env MODAL_WORLDGEN_URL で上書きでき、無ければデプロイ済みの URL（<workspace>--<app>-<関数名>.modal.run）。

const DEFAULT_WORLDGEN_URL = "https://axelbh5--ull-worldgen-worldgen-async.modal.run";

/** 予約（studio_dispatch_specs.spec）にもそのまま保存する起動の引数。画像は studio_uploads の "<userId>/<file>"。 */
export type WorldgenDispatchSpec = {
  creditsCost: number;
  mode: "t2s" | "i2s";
  prompt: string;
  imagePath?: string | null;
};

export async function dispatchWorldgenJob(
  jobId: string,
  userId: string,
  spec: WorldgenDispatchSpec,
): Promise<{ callId: string | null }> {
  const url = process.env.MODAL_WORLDGEN_URL || DEFAULT_WORLDGEN_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!authToken) throw new Error("MODAL_AUTH_TOKEN が未設定です。");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-modal-secret": authToken },
    body: JSON.stringify({
      job_id: jobId,
      user_id: userId,
      credits_cost: spec.creditsCost,
      mode: spec.mode,
      prompt: spec.prompt,
      ...(spec.imagePath ? { image_path: spec.imagePath } : {}),
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
