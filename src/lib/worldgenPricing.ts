// 背景づくり（WorldGen・2026-10-10・許可制）の料金と上限。フロント表示と route で同じ関数を使う。
// 単価は knob（/admin の Pricing）。根拠は knobDefaults.ts の worldgen_* のコメント。

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";
import { parallelSurcharge } from "@/lib/pricing/parallelSurcharge";

// 説明の上限（2026-10-10）: 中身を読むのは FLUX の長い方（T5・512 トークン）。日本語 1 文字 ≒ 1.2 トークン（英訳後）なので約 400 文字が限界で、
// 余裕を見て 150 文字。短い方（CLIP・77 トークン＝日本語 60 文字前後）は雰囲気の補助で、そこが切れるのは FLUX では普通（影響は小さい）。
export const WORLDGEN_PROMPT_MAX_LENGTH = 150;

export function worldgenCredits(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.ceil(knobs.worldgen_credits);
}

export function worldgenPriorityParallelSurcharge(knobs: PricingKnobs = DEFAULT_KNOBS, baseCost = 0): number {
  return parallelSurcharge(baseCost, knobs.worldgen_priority_parallel_rate, knobs.worldgen_priority_parallel_surcharge);
}
