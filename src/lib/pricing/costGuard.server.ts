import "server-only";
import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";

// Central computation of the "原価割れ損切り" (cost-guard) seconds handed to the
// Modal workers. Ported from modal_lora_worker.py's _credit_covered_seconds /
// _expected_run_floor_seconds / _cost_cap_seconds so the numbers live next to
// the credit price they are derived from and change together via the
// pricing_knobs table — no worker redeploy needed.
//
// The workers keep their own env-var overrides and the hard LORA_ABS_MAX_RUN_S
// ceiling as a last-resort safety net; when a payload carries the value
// computed here they use it directly.

// 12h Modal container timeout minus a 20-min graceful-stop margin. Must match
// LORA_ABS_MAX_RUN_S in modal_lora_worker.py.
export const LORA_ABS_MAX_RUN_S = 12 * 60 * 60 - 20 * 60;

// Measured seconds/iteration per ai-toolkit arch — floors the cost cap so a
// correctly-priced-but-slow heavy model always has runway to finish its
// declared step count. Mirrors LORA_SPI_BASELINE in modal_lora_worker.py.
// Unlisted arch -> knobs.lora_spi_baseline_default.
const LORA_SPI_BASELINE: Record<string, number> = {
  minimax_h3: 5.0,
  wan22_14b: 4.0,
  wan21: 3.5,
  ltx2: 3.5,
  hunyuan: 4.0,
  cogvideox: 4.0,
  flux2_klein_4b: 1.1,
  qwen_image: 2.0,
  krea2: 2.0,
  zimage: 1.2,
  anima: 1.4,
  sdxl: 0.9,
};

function creditCoveredSeconds(creditsCost: number, knobs: PricingKnobs): number {
  const revenueJpy = Math.max(0, creditsCost) * knobs.credit_to_jpy;
  const maxCostJpy = revenueJpy * knobs.lora_margin_target;
  const jpyPerSec = knobs.gpu_jpy_per_hour_b300 / 3600;
  const secs = jpyPerSec > 0 ? maxCostJpy / jpyPerSec : 0;
  return Math.floor(Math.max(1800, Math.min(secs, LORA_ABS_MAX_RUN_S)));
}

function expectedRunFloorSeconds(arch: string, totalSteps: number, knobs: PricingKnobs): number {
  if (totalSteps <= 0) return 0;
  const spi = LORA_SPI_BASELINE[arch] ?? knobs.lora_spi_baseline_default;
  const floor = knobs.lora_floor_prep_s + totalSteps * spi * 1.3;
  return Math.floor(Math.min(floor, LORA_ABS_MAX_RUN_S));
}

export type LoraCostCap = { seconds: number; reason: string };

export function loraCostCapSeconds(args: {
  creditsCost: number;
  arch: string;
  steps: number;
  knobs?: PricingKnobs;
}): LoraCostCap {
  const knobs = args.knobs ?? DEFAULT_KNOBS;
  const arch = (args.arch || "").trim().toLowerCase();
  const steps = Math.max(0, Math.round(args.steps || 0));

  const multiplier = Math.max(1.0, Math.min(knobs.lora_cost_guard_multiplier, 3.0));
  const base =
    args.creditsCost > 0 ? creditCoveredSeconds(args.creditsCost, knobs) : knobs.lora_safety_limit_s;
  const withMargin = base * multiplier;
  const archFloor = expectedRunFloorSeconds(arch, steps, knobs);
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
