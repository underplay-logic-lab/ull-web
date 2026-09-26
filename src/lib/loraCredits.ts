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

// 2026-09-23: SDXL（sd-scripts ワーカー）は別の式。実案件 WAI v7（220枚・LoCon 既定込み・
// 3,000step）をホストが中間チェックポイントで見比べた結果、ベストは step 1,750 で、
// 3,000 まで回す意味が無かった。ただし「毎回 1,750 が最良とは限らないので最低 2,000 は
// 回す」（ホスト）。上の式（850 + 12×枚数）だと 220 枚で 3,490 なので、220 枚で約 2,000
// になるよう 600 + 6.5×枚数 にする（100 枚 → 1,250、50 枚 → 925。MIN/MAX は共通）。
// ai-toolkit 系（動画・FLUX 等）は実測が無いので従来の式のまま。
export const LORA_AUTO_STEPS_BASE_SDXL = 600;
export const LORA_AUTO_STEPS_PER_IMAGE_SDXL = 6.5;

// 2026-09-26: minimax_h3 は別の式（prodigy＋cosine、worker の PRODIGY_COSINE_ARCHES とセット）。実験（hitozuma+kocho・
// 88 枚、倍率込みで実質約 104 枚）で、上の共通式の 1,906 step（prodigy 定数）は 1,000 付近の 1 点だけ当たって崩れ、
// prodigy＋cosine で 3,000 step にすると 2,250〜2,750 が安定して似た（docs/STATUS.md、LoRA 既定値の検証）。
// 88 枚で約 2,800 になる 1,000 + 20×枚数（53 枚 → 2,060、176 枚 → 4,520）。fal ガイドの「176 本で 3,000+」とも矛盾しない。
export const LORA_AUTO_STEPS_BASE_MINIMAX = 1000;
export const LORA_AUTO_STEPS_PER_IMAGE_MINIMAX = 20;

export function autoLoraSteps(imageCount: number, arch?: string | null): number {
  const n = Math.max(1, Math.round(imageCount) || 1);
  const a = String(arch ?? "").trim().toLowerCase();
  const raw =
    a === "sdxl"
      ? LORA_AUTO_STEPS_BASE_SDXL + n * LORA_AUTO_STEPS_PER_IMAGE_SDXL
      : a === "minimax_h3"
        ? LORA_AUTO_STEPS_BASE_MINIMAX + n * LORA_AUTO_STEPS_PER_IMAGE_MINIMAX
        : LORA_AUTO_STEPS_BASE + n * LORA_AUTO_STEPS_PER_IMAGE;
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
// 2026-09-23: 人物は alpha = rank（32/32）へ（ホスト判断）。実案件 WAI v7 で alpha=rank に
// 揃えた構成が良好で、ai-toolkit の既定も alpha=rank。rank は所要時間・価格に効かない
// （docs/gpu-benchmarks.md §14.25）ので 32 のまま（64 はファイルが 2 倍になるだけ）。
// detail 側（64/32）は未検証のため据え置き。
export const LORA_AUTO_RANK_ALPHA: Record<"character" | "detail", { rank: number; alpha: number }> = {
  character: { rank: 32, alpha: 32 },
  detail: { rank: 64, alpha: 32 },
};

export function autoLoraRankAlpha(category: LoraCaptionCategory | undefined): { rank: number; alpha: number } {
  const bucket = category && category !== "character" ? "detail" : "character";
  return LORA_AUTO_RANK_ALPHA[bucket];
}
