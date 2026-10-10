// 背景づくり（WorldGen・2026-10-10・許可制）の料金と上限。フロント表示と route で同じ関数を使う。
// 単価は knob（/admin の Pricing）。根拠は knobDefaults.ts の worldgen_* のコメント。

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";
import { parallelSurcharge } from "@/lib/pricing/parallelSurcharge";

// 説明の上限（2026-10-10）: FLUX の短い方の文章読み取り（CLIP）は英語で約 60 語（77 トークン）まで。日本語は英語に直すと長くなるので
// 150 文字に抑える（長い方の T5 は 512 トークンまで読むが、部屋全体の雰囲気を決める CLIP が途中で切れると後ろの物が効きにくい）。
export const WORLDGEN_PROMPT_MAX_LENGTH = 150;

export function worldgenCredits(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.ceil(knobs.worldgen_credits);
}

export function worldgenPriorityParallelSurcharge(knobs: PricingKnobs = DEFAULT_KNOBS, baseCost = 0): number {
  return parallelSurcharge(baseCost, knobs.worldgen_priority_parallel_rate, knobs.worldgen_priority_parallel_surcharge);
}
