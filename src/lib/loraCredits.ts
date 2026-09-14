// Training-hyperparameter defaults for the LoRA Studio's "オート" mode.
//
// Pricing itself lives in src/lib/loraPricing.ts (multi-dimensional:
// model / resolution / batch / rank multipliers). This file holds the
// shared step-count / rank-alpha policy the UI's live price estimate and
// the server-side authoritative defaults both need (kept in one place so
// they can never disagree — see /api/studio/lora/train).

import type { LoraCaptionCategory } from "@/lib/loraCaptionSpec";

// エキスパートモードで生YAML/スライダーも使わない、ごく古い経路向けの
// フォールバック定数（現状ほぼ参照されない）。「オート」の実際の学習は
// autoLoraSteps() が画像枚数から動的に決める（下記）。
export const DEFAULT_LORA_STEPS = 2000;

// Top of the steps slider (エキスパート mode)。autoLoraSteps() の安全上限にも流用。
export const LORA_MAX_STEPS = 5000;

// 2026-09-15: 「オート」モードの学習stepを画像枚数に連動させる線形式。
// 2026-09-14に「枚数×80(上限5000)」という式で一度出したが、これは
// 「以前の一律2000stepを推奨枚数レンジの中央値25枚で再現する」という
// 自己参照的な根拠しかなかった。ホスト指摘を受けて外部の一次情報を調査し
// 直した結果、fal.ai公式のMiniMax H3 LoRA学習ガイドに実測の2点が見つかった:
//   "Steps must scale with the dataset. 1,500 steps won on 53 clips;
//    the same recipe needed 3,000+ on 176 clips."
//   https://fal.ai/learn/devs/how-to-train-a-lora-for-minimax-h3
// この2点（53枚→1500step、176枚→3000step）を直線で結ぶと
//   slope   = (3000-1500) / (176-53) ≈ 12 step/枚
//   base    = 1500 - 12*53           ≈ 850 step（切片＝極小データセットでも
//             必要になる最低限の絶対学習量）
// になる。原点を通らない一次式にしたのは「枚数が少ないほど1枚あたりの
// 反復は増えるが、絶対step数そのものは0に近づいて良いわけではない」という
// 実務ガイド（Ostris ai-toolkit: 5〜15枚でも3000step程度を推奨）とも整合的
// なため。ホスト自身の納品実績（131枚・rank64・1500〜2000stepが良好）とも
// この式の予測値（131枚→約2422step）は近い範囲に収まる。
// MIN/MAXはあくまで異常値ガード（この式が現実的に生成する範囲の外側）。
export const LORA_AUTO_STEPS_BASE = 850;
export const LORA_AUTO_STEPS_PER_IMAGE = 12;
export const LORA_AUTO_STEPS_MIN = 500;
export const LORA_AUTO_STEPS_MAX = LORA_MAX_STEPS;

export function autoLoraSteps(imageCount: number): number {
  const n = Math.max(1, Math.round(imageCount) || 1);
  const raw = LORA_AUTO_STEPS_BASE + n * LORA_AUTO_STEPS_PER_IMAGE;
  return Math.min(LORA_AUTO_STEPS_MAX, Math.max(LORA_AUTO_STEPS_MIN, Math.round(raw)));
}

// 2026-09-15: Rank/AlphaをLoRAタイプ（人物 vs 画風寄り）で分岐させる
// （ホスト指摘・外部調査に基づく）。以前は一律rank=32/alpha=32
// （比率1.0）だったが、複数の外部ガイドが次の傾向で一致していた:
//   - 人物・キャラクターLoRA: 低めのrank（SDXL顔LoRAの定番はdim32）
//     https://aiofm.info/en/guides/lora-complete-guide
//   - 画風/衣装/物体/背景のような「特定の視覚的ディテールを忠実に再現する」
//     LoRA: 高めのrank（複雑なスタイルLoRAはdim64が定番）
//   - alpha = rank/2 が「事実上の標準」（α/rの実効スケールを一定に保つ）
//     という点も複数ソースで一致。ホスト自身の納品実績（rank64/alpha32、
//     まさに比率0.5）とも独立に一致している。
// characterのみ低rank、それ以外（outfit/object/background/style）は
// 「特定のディテールを忠実に再現したい」という点で画風LoRAに近いと判断し
// 高rank側にまとめた。captionSpec未選択（custom modelフロー等）は保守的に
// characterと同じ扱いにする。
export const LORA_AUTO_RANK_ALPHA: Record<"character" | "detail", { rank: number; alpha: number }> = {
  character: { rank: 32, alpha: 16 },
  detail: { rank: 64, alpha: 32 },
};

export function autoLoraRankAlpha(category: LoraCaptionCategory | undefined): { rank: number; alpha: number } {
  const bucket = category && category !== "character" ? "detail" : "character";
  return LORA_AUTO_RANK_ALPHA[bucket];
}
