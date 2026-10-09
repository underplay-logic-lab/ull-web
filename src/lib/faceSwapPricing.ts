// 顔入れ替え（2026-10-09・許可制）の料金と上限。フロント表示と route で同じ関数を使う。
// 単価は knob（/admin の Pricing）。根拠は knobDefaults.ts の face_swap_* のコメント。

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";
import { parallelSurcharge } from "@/lib/pricing/parallelSurcharge";

/** 1 回で入れ替えられる人数（2 人目は 1 人目の結果に重ねる。ワーカーの MAX_SWAPS と同じ）。 */
export const FACE_SWAP_MAX_PEOPLE = 2;

/** 写っている人の指定。"auto" は 1 人だけ写っている画像向け（左右を言わない）。 */
export const FACE_SWAP_SIDES = ["auto", "left", "right"] as const;
export type FaceSwapSide = (typeof FACE_SWAP_SIDES)[number];
export function isFaceSwapSide(v: unknown): v is FaceSwapSide {
  return typeof v === "string" && (FACE_SWAP_SIDES as readonly string[]).includes(v);
}

/** 似せる強さ（BFS の LoRA の強さ）。強いほど参照の顔・髪型に寄る。1.5 まで手元で崩れないのを確認済み（2026-10-09）。 */
export const FACE_SWAP_STRENGTHS = [
  { id: "weak", value: 1.0, label: "弱め", sub: "元の絵になじませる" },
  { id: "standard", value: 1.3, label: "標準", sub: "おすすめ" },
  { id: "strong", value: 1.5, label: "強め", sub: "参照に寄せる" },
] as const;
export type FaceSwapStrengthId = (typeof FACE_SWAP_STRENGTHS)[number]["id"];
export function faceSwapStrengthValue(id: unknown): number {
  return (FACE_SWAP_STRENGTHS.find((s) => s.id === id) ?? FACE_SWAP_STRENGTHS[1]).value;
}

export function faceSwapCredits(people: number, knobs: PricingKnobs = DEFAULT_KNOBS): number {
  const n = Math.max(1, Math.min(FACE_SWAP_MAX_PEOPLE, Math.floor(people) || 1));
  return Math.ceil(knobs.face_swap_base_credits + knobs.face_swap_per_person_credits * n);
}

export function faceSwapPriorityParallelSurcharge(knobs: PricingKnobs = DEFAULT_KNOBS, baseCost = 0): number {
  return parallelSurcharge(baseCost, knobs.face_swap_priority_parallel_rate, knobs.face_swap_priority_parallel_surcharge);
}
