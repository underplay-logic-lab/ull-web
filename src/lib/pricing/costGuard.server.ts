import "server-only";
import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";
import {
  LORA_ABS_MAX_RUN_S,
  LORA_RUNTIME_CUSHION,
  loraEstimatedSeconds,
  loraWorkerBackend,
} from "@/lib/pricing/loraRuntime";

// Central computation of the "原価割れ損切り" (cost-guard) seconds handed to the
// Modal workers. Ported from modal_lora_worker.py's _credit_covered_seconds /
// _expected_run_floor_seconds / _cost_cap_seconds so the numbers live next to
// the credit price they are derived from and change together via the
// pricing_knobs table — no worker redeploy needed.
//
// The workers keep their own env-var overrides and the hard LORA_ABS_MAX_RUN_S
// ceiling as a last-resort safety net; when a payload carries the value
// computed here they use it directly.

// 2026-09-20: LORA_ABS_MAX_RUN_S と arch 別 s/it テーブル（LORA_SPI_BASELINE）は
// src/lib/pricing/loraRuntime.ts へ移した。課金側（loraPricing.ts）と損切り側
// （このファイル）が別々に同じ表を持っていた状態を解消するため — 実際 sdxl の
// 値が課金側 1.4 / ワーカー側 0.9 で食い違っていた。再エクスポートは既存の
// import 元を壊さないため。
export { LORA_ABS_MAX_RUN_S } from "@/lib/pricing/loraRuntime";

// 2026-09-21: GPU tier をバックエンドに合わせるようにした。arch="sdxl" は
// sd-scripts ワーカー（modal_sdxl_lora_worker.py）で **L40S** で回るのに、
// ここは全 arch を B300 の時給で割っていた。L40S は B300 の約 1/4 の単価なので
// 許容秒が約 1/4 になり、しかも課金側は既に sdxl 専用の安い単価 knob
// （lora_credits_per_gpu_second_sdxl）を使っているため、二重に厳しくなって
// **正常なジョブを原価割れ判定で撃ち落とし得た**。実際には下の archFloor が
// 効いて救われていたが、それは偶然の保険であって設計ではない。
function creditCoveredSeconds(
  creditsCost: number,
  knobs: PricingKnobs,
  arch: string,
): number {
  const revenueJpy = Math.max(0, creditsCost) * knobs.credit_to_jpy;
  const maxCostJpy = revenueJpy * knobs.lora_margin_target;
  const usdPerHour =
    loraWorkerBackend(arch) === "sd_scripts"
      ? knobs.gpu_usd_per_hour_l40s
      : knobs.gpu_usd_per_hour_b300;
  const jpyPerSec = (usdPerHour * knobs.usd_jpy_rate) / 3600;
  const secs = jpyPerSec > 0 ? maxCostJpy / jpyPerSec : 0;
  return Math.floor(Math.max(1800, Math.min(secs, LORA_ABS_MAX_RUN_S)));
}

// 正しく課金されているが遅いジョブが、生成の途中で損切りに撃ち落とされない
// ようにするための下限。課金額の算出に使ったのと **同じ見積もり関数** を通す
// ので、価格と損切りが別々の想定にズレることが構造的に起きない。
// 見積もりに対する 1.3 倍は、実測のばらつきぶんの余裕（CLAUDE.md §0
// 「タイムアウトは多めに」）。
function expectedRunFloorSeconds(
  args: { arch: string; steps: number; resolution?: number; effectiveBatch?: number; imageCount?: number },
  knobs: PricingKnobs,
): number {
  if (args.steps <= 0) return 0;
  const estimate = loraEstimatedSeconds({ ...args, knobs });
  return Math.floor(Math.min(estimate.totalSeconds * LORA_RUNTIME_CUSHION, LORA_ABS_MAX_RUN_S));
}

export type LoraCostCap = { seconds: number; reason: string };

export function loraCostCapSeconds(args: {
  creditsCost: number;
  arch: string;
  steps: number;
  /** 課金時と同じ値を渡すこと（loraPriceBreakdown() の戻り値がそのまま使える）。 */
  resolution?: number;
  effectiveBatch?: number;
  imageCount?: number;
  knobs?: PricingKnobs;
}): LoraCostCap {
  const knobs = args.knobs ?? DEFAULT_KNOBS;
  const arch = (args.arch || "").trim().toLowerCase();
  const steps = Math.max(0, Math.round(args.steps || 0));

  const multiplier = Math.max(1.0, Math.min(knobs.lora_cost_guard_multiplier, 3.0));
  const base =
    args.creditsCost > 0
      ? creditCoveredSeconds(args.creditsCost, knobs, arch)
      : knobs.lora_safety_limit_s;
  const withMargin = base * multiplier;
  const archFloor = expectedRunFloorSeconds(
    {
      arch,
      steps,
      resolution: args.resolution,
      effectiveBatch: args.effectiveBatch,
      imageCount: args.imageCount,
    },
    knobs,
  );
  const capped = Math.floor(Math.min(Math.max(withMargin, archFloor), LORA_ABS_MAX_RUN_S));

  const reason =
    `${args.creditsCost}C -> base ${base}s x${multiplier.toFixed(2)} = ${Math.floor(withMargin)}s, ` +
    `arch-floor[${arch || "?"}, ${steps || "?"}st] ${archFloor}s -> ${capped}s ` +
    `(~${(capped / 3600).toFixed(2)}h)`;
  return { seconds: capped, reason };
}

// Multi-Angle Studio: the seconds the Modal angle worker's cost-guard
// watchdog counts against (payload.max_allowed_time). Replaces the
// ANGLE_TIME_PER_CREDIT / ANGLE_COLD_START_GRACE constants that used to live
// in the angle generate route.
export function angleMaxAllowedTime(args: { creditsCost: number; knobs?: PricingKnobs }): number {
  const knobs = args.knobs ?? DEFAULT_KNOBS;
  return Math.ceil(
    Math.max(0, args.creditsCost) * knobs.angle_time_per_credit_s + knobs.angle_cold_start_grace_s,
  );
}

// 超解像スタジオ（SeedVR2）: modal_seedvr2_worker.py の原価割れウォッチドッグへ
// 渡す許容最大 GPU 稼働秒（payload.max_allowed_time）。単一画像ジョブなので
// angle と同じ「消費C × 秒 + コールドスタート猶予」の素朴な式で十分。
export function upscaleMaxAllowedTime(args: { creditsCost: number; knobs?: PricingKnobs }): number {
  const knobs = args.knobs ?? DEFAULT_KNOBS;
  return Math.ceil(
    Math.max(0, args.creditsCost) * knobs.upscale_time_per_credit_s +
      knobs.upscale_cold_start_grace_s,
  );
}

// 動画超解像 v1（最小スコープ）: 同じ素朴な式だが動画専用 knob を使う
// （フレーム数課金なので秒/クレジットの実態が画像と異なる）。
export function upscaleVideoMaxAllowedTime(args: { creditsCost: number; knobs?: PricingKnobs }): number {
  const knobs = args.knobs ?? DEFAULT_KNOBS;
  return Math.ceil(
    Math.max(0, args.creditsCost) * knobs.upscale_video_time_per_credit_s +
      knobs.upscale_video_cold_start_grace_s,
  );
}
