// Step-count constants for the LoRA Studio.
//
// Pricing itself moved to src/lib/loraPricing.ts (multi-dimensional:
// model / resolution / batch / rank multipliers). This file now only holds
// the shared step-count anchors the UI slider and the server-side defaults
// still need.

// エキスパートモードで生YAML/スライダーも使わない、ごく古い経路向けの
// フォールバック定数（現状ほぼ参照されない）。「オート」の実際の学習は
// autoLoraSteps() が画像枚数から動的に決める（下記）。
export const DEFAULT_LORA_STEPS = 2000;

// Top of the steps slider (エキスパート mode)。autoLoraSteps() の上限にも流用。
export const LORA_MAX_STEPS = 5000;

// 2026-09-14: 「オート」モードの学習stepを画像枚数に連動させる（ホスト判断）。
// それまでは画像15枚でも200枚でも一律2000stepの固定値だった —
// batch_size=1固定なので、15枚なら1枚あたり約133回、40枚なら約50回しか
// 見せておらず、枚数が少ないほど過学習・多いほど学習不足になりやすい
// リスクがあった（ホスト指摘）。
//
// REPEATS_PER_IMAGE=80 は新規の当てずっぽうではなく、「これまで実際に
// 使われてきた2000stepという値を、UI自身が推奨する枚数レンジ(15〜40枚)の
// 中央値である25枚でちょうど再現する」ように選んだ値（2000 ÷ 25 = 80）。
// LoRA学習コミュニティで一般的な「1枚あたり合計80〜160回程度の露出」という
// 経験則のレンジの下限寄りでもあり、無根拠な数字ではない。
// MIN/MAXは極端なデータセットで実質学習ゼロ・青天井課金になるのを防ぐガード。
export const LORA_AUTO_REPEATS_PER_IMAGE = 80;
export const LORA_AUTO_STEPS_MIN = 800;
export const LORA_AUTO_STEPS_MAX = LORA_MAX_STEPS;

export function autoLoraSteps(imageCount: number): number {
  const n = Math.max(1, Math.round(imageCount) || 1);
  const raw = n * LORA_AUTO_REPEATS_PER_IMAGE;
  return Math.min(LORA_AUTO_STEPS_MAX, Math.max(LORA_AUTO_STEPS_MIN, raw));
}
