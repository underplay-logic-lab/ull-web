import "server-only";
import { warmSettlePayload, type WarmSettle } from "@/lib/pricing/warmRefund";

// 顔入れ替え（2026-10-09）のジョブを Modal（modal_faceswap_worker.py の face_swap_async）へ投げる。GPU の起動は待たない（spawn して即返る）。
// URL は env MODAL_FACE_SWAP_URL で上書きでき、無ければデプロイ済みの URL（<workspace>--<app>-<関数名>.modal.run）。

const DEFAULT_FACE_SWAP_URL = "https://axelbh5--ull-face-swap-face-swap-async.modal.run";

/** 予約（studio_dispatch_specs.spec）にもそのまま保存する起動の引数。パスは studio_uploads の "<userId>/<file>"。 */
export type FaceSwapDispatchSpec = {
  creditsCost: number;
  seed: number;
  bodyPath: string;
  /** side は "" ＝写っているのが 1 人（位置を言わない）、それ以外はワーカーの SIDES のキー（left・second_left 等）。 */
  swaps: { facePath: string; side: string }[];
  /** 似せる強さ（BFS の LoRA の強さ）。無ければワーカーの既定（1.3）。 */
  strength?: number;
  /** 温まり返金（2026-10-10）: 温まったコンテナで動いたら、ワーカーが実際の秒数で計算し直して差額を返す（src/lib/pricing/warmRefund.ts）。 */
  warmSettle?: WarmSettle;
};

export async function dispatchFaceSwapJob(
  jobId: string,
  userId: string,
  spec: FaceSwapDispatchSpec,
): Promise<{ callId: string | null }> {
  const url = process.env.MODAL_FACE_SWAP_URL || DEFAULT_FACE_SWAP_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!authToken) throw new Error("MODAL_AUTH_TOKEN が未設定です。");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-modal-secret": authToken },
    body: JSON.stringify({
      job_id: jobId,
      user_id: userId,
      credits_cost: spec.creditsCost,
      seed: spec.seed,
      body_path: spec.bodyPath,
      swaps: spec.swaps.map((s) => ({ face_path: s.facePath, side: s.side })),
      ...(spec.strength ? { settings: { lora_strength: spec.strength } } : {}),
      ...(spec.warmSettle ? { warm_settle: warmSettlePayload(spec.warmSettle) } : {}),
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
