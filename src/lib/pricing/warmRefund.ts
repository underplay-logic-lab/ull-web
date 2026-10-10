import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";
import type { DirectorGpu } from "@/lib/directorPricing";

/**
 * 温まり返金（2026-10-10・ホスト判断）: 送信時は今までどおり全額を引き、同じモデルを載せたままのコンテナで動いたら
 * （続けて作った・予約の順番が来た）、完了時にワーカーが「実際にかかった秒数 × 単価」で計算し直して差額を返す。
 *
 * 固定額で返すのはやめた（2026-10-10）: 温まっていても文章 AI（Qwen 27B）・TE は OOM を避けるため毎回降ろしていて読み直しになる。
 * Photo の冷えた状態は、AI を通さないと 111〜126 秒、AI が書くと 196〜357 秒（本番の記録）で、固定 45C だと返しすぎる。
 * 実際の秒数で比べれば、読み直しで遅くなった分は自動で返す額が減る。返した後の料金は「実際の秒数 × 単価」なので掛け率も保てる。
 *
 * - compareCredits: 料金のうち時間で決まる部分（並列の追加料金を除いた通常料金）。
 * - creditsPerS: 1 秒あたりの単価（料金の元になっている単価そのもの）。
 * - cap: 返す上限（基本料のうち起動・読み込みの分）。見積もりより早く終わっても返しすぎない。
 * ワーカー: 温まっていたら min(cap, max(0, compareCredits − 実際の秒数 × creditsPerS)) を返す。失敗は全額返金なので関係しない。
 */
export type WarmSettle = { cap: number; compareCredits: number; creditsPerS: number };

function settle(cap: number, compareCredits: number, creditsPerS: number): WarmSettle | undefined {
  const c = Math.max(0, Math.floor(cap));
  if (c <= 0 || !(creditsPerS > 0) || !(compareCredits > 0)) return undefined;
  return { cap: c, compareCredits: Math.floor(compareCredits), creditsPerS };
}

export function directorCreditsPerS(knobs: PricingKnobs, gpu: DirectorGpu): number {
  return gpu === "RTX-PRO-6000"
    ? knobs.director_credits_per_gpu_s_pro6000
    : gpu === "H200"
      ? knobs.director_credits_per_gpu_s_h200
      : knobs.director_credits_per_gpu_s;
}

/** Director（動画）: 上限は起動・読み込みの秒数 × その GPU の単価。 */
export function directorWarmSettle(compareCredits: number, gpu: DirectorGpu, knobs: PricingKnobs = DEFAULT_KNOBS): WarmSettle | undefined {
  const rate = directorCreditsPerS(knobs, gpu);
  return settle(knobs.director_warm_refund_s * rate, compareCredits, rate);
}

/** Photo Director（H200）: 単価は Director の H200 と同じ（基本 45C ≒ 117 秒 × 0.388）。 */
export function photoDirectorWarmSettle(compareCredits: number, knobs: PricingKnobs = DEFAULT_KNOBS): WarmSettle | undefined {
  return settle(knobs.photo_director_warm_refund_credits, compareCredits, knobs.director_credits_per_gpu_s_h200);
}

export function faceSwapWarmSettle(compareCredits: number, knobs: PricingKnobs = DEFAULT_KNOBS): WarmSettle | undefined {
  return settle(knobs.face_swap_warm_refund_credits, compareCredits, knobs.face_swap_credits_per_gpu_s);
}

export function songWarmSettle(compareCredits: number, knobs: PricingKnobs = DEFAULT_KNOBS): WarmSettle | undefined {
  return settle(knobs.song_warm_refund_credits, compareCredits, knobs.song_credits_per_gpu_s);
}

/** ワーカーへ渡す形（snake_case）。 */
export function warmSettlePayload(w: WarmSettle): { cap: number; compare_credits: number; credits_per_s: number } {
  return { cap: w.cap, compare_credits: w.compareCredits, credits_per_s: w.creditsPerS };
}

/**
 * 動画の超解像: SeedVR2 は「基本料＋コマ数」× モデル係数 × 解像度係数なので、上限は基本料の部分（同じ係数を掛けた分）。
 * Real-ESRGAN（固定倍率）は基本 20C に終わった後の待機も入っているので、上限は読み込み分の knob（既定 10C）。
 * 単価は実際に動く GPU（worker の UPSCALE_VIDEO_PRESET_GPU: HD/2K と Real-ESRGAN は RTX PRO 6000、SeedVR2 の 4K は B300）。
 */
export function upscaleVideoWarmSettle(
  args: { compareCredits: number; presetId: string; fixedScale: boolean; modelMult: number; resMult: number },
  knobs: PricingKnobs = DEFAULT_KNOBS,
): WarmSettle | undefined {
  const gpu: DirectorGpu = !args.fixedScale && args.presetId === "4k" ? "B300" : "RTX-PRO-6000";
  const cap = args.fixedScale
    ? knobs.upscale_video_esrgan_warm_refund_credits
    : Math.ceil(knobs.upscale_video_base_credits * args.modelMult * args.resMult);
  return settle(cap, args.compareCredits, directorCreditsPerS(knobs, gpu));
}

/**
 * 画像の超解像（2026-10-10 組み替え後）: 上限は起動・読み込みの分（upscaleImageRates の warmCap）。単価は動く GPU。
 * まとめて出すときは基本料を乗せた先頭の 1 枚だけに渡す（2 枚目以降は基本料を取っていないので精算しない）。
 */
export function upscaleImageWarmSettle(
  compareCredits: number,
  gpu: "RTX-PRO-6000" | "B300",
  warmCap: number,
  knobs: PricingKnobs = DEFAULT_KNOBS,
): WarmSettle | undefined {
  return settle(warmCap, compareCredits, directorCreditsPerS(knobs, gpu));
}
