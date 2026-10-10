// 顔入れ替え（2026-10-09・許可制）の料金と上限。フロント表示と route で同じ関数を使う。
// 単価は knob（/admin の Pricing）。根拠は knobDefaults.ts の face_swap_* のコメント。

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";
import { parallelSurcharge } from "@/lib/pricing/parallelSurcharge";

/** 1 回で入れ替えられる人数（2 人目以降は前の結果に重ねる。ワーカーの MAX_SWAPS と同じ）。 */
export const FACE_SWAP_MAX_PEOPLE = 4;

/** 写っている人の位置（ワーカーの SIDES のキー）。"auto" は 1 人だけ写っている画像向け（位置を言わない）。 */
export type FaceSwapSide = "auto" | "left" | "middle" | "right" | "far_left" | "second_left" | "second_right" | "far_right";
export type FaceSwapLayout = 1 | 2 | 3 | 4;

/** 横並びの人数ごとの位置（左から順。入れ替えもこの順に行う）。手元で 3 人・4 人とも取り違えなし（2026-10-09）。 */
export const FACE_SWAP_LAYOUTS: Record<FaceSwapLayout, { id: FaceSwapSide; label: string }[]> = {
  1: [{ id: "auto", label: "この人" }],
  2: [
    { id: "left", label: "左" },
    { id: "right", label: "右" },
  ],
  3: [
    { id: "left", label: "左" },
    { id: "middle", label: "真ん中" },
    { id: "right", label: "右" },
  ],
  4: [
    { id: "far_left", label: "左から 1 番目" },
    { id: "second_left", label: "左から 2 番目" },
    { id: "second_right", label: "左から 3 番目" },
    { id: "far_right", label: "左から 4 番目" },
  ],
};
export function isFaceSwapLayout(v: unknown): v is FaceSwapLayout {
  return v === 1 || v === 2 || v === 3 || v === 4;
}

/** 似せる強さ（BFS の LoRA の強さ）。強いほど参照の顔・髪型に寄る。1.5 まで手元で崩れないのを確認済み（2026-10-09）。 */
export const FACE_SWAP_STRENGTHS = [
  { id: "weak", value: 1.0, label: "弱め", sub: "入れ替え先になじませる" },
  { id: "standard", value: 1.3, label: "標準", sub: "おすすめ" },
  { id: "strong", value: 1.5, label: "強め", sub: "顔の画像に寄せる" },
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
