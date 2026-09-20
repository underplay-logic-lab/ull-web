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

// Top of the steps slider (エキスパート mode)。
//
// 2026-09-20: 5,000 → 20,000。5,000 は根拠のない保守的な仮値で、CLAUDE.md §0
// の「裏付けのない保守的な上限は自己ブロック」に該当していた。実際の壁は
// Modal コンテナの 12時間（LORA_ABS_MAX_RUN_S）で、実測 s/it から逆算すると
//   minimax_h3 / 1024px / バッチ1 / 25枚 → 約  17,300 step
//   sdxl（sd-scripts / L40S）           → 約  50,000 step
// までは 12h に収まる（loraMaxSteps() の実値。ばらつき用の1.3倍を引いた後）。
// ⚠️ 2026-09-20（夜）: GUI 既定条件の実測（docs §14.15）で minimax_h3 の s/it が
// 0.90 → 1.80 になり、149,000 → 約 17,300 step へ下がった。**UI 上限 20,000 は
// もはや内側ではなく**、minimax_h3 で 17,300 超を選ぶと /api/studio/lora/train が
// 400 で拒否する。他 arch は余裕がある（wan22_14b 約21,600 / qwen_image 約43,300）。
// 12h の壁そのものは loraMaxSteps()（src/lib/pricing/loraRuntime.ts）が設定
// ごとに計算し、収まらない設定は /api/studio/lora/train が明示的に拒否する。
// 課金と損切りは推定GPU秒ベースなので、step を増やせば価格も許容時間も自動で
// 追従する（重い処理は高くなる＝CLAUDE.md §0）。
export const LORA_MAX_STEPS = 20000;

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
// 2026-09-20: LORA_MAX_STEPS への追従をやめて独立させた。オートの式
// （850 + 12×枚数）が 5,000 に達するのは 346 枚のときで、実質的には
// 「式が暴走していないか」の異常値ガードでしかない。エキスパートの
// スライダー上限を引き上げたからといって、オートが黙って 20,000 step の
// 高額ジョブを組めるようになるべきではない（枚数上限は 500 枚）。
export const LORA_AUTO_STEPS_MAX = 5000;

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
