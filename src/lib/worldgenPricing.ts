// 背景づくり（WorldGen・2026-10-10・許可制）の料金と上限。フロント表示と route で同じ関数を使う。
// 単価は knob（/admin の Pricing）。根拠は knobDefaults.ts の worldgen_* のコメント。

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";
import { parallelSurcharge } from "@/lib/pricing/parallelSurcharge";

export const WORLDGEN_PROMPT_MAX_LENGTH = 600;

export function worldgenCredits(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.ceil(knobs.worldgen_credits);
}

export function worldgenPriorityParallelSurcharge(knobs: PricingKnobs = DEFAULT_KNOBS, baseCost = 0): number {
  return parallelSurcharge(baseCost, knobs.worldgen_priority_parallel_rate, knobs.worldgen_priority_parallel_surcharge);
}
