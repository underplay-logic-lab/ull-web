// 超解像スタジオ（SeedVR2）のフロント / API 共通設定。
//
// - モデルレジストリは modal_seedvr2_worker.py の UPSCALER_REGISTRY のうち
//   enabled なものだけをミラー（v1 は SeedVR2 7B のみ）。
// - 解像度は **倍率（×2/×3/×4）** ＋ 大判用の絶対プリセット「8K」。倍率は
//   ESRGAN 等の一般的なアップスケーラーと同じメンタルモデル。内部で
//   target_short / max_edge に変換して worker へ渡す。
// - 課金は「出力の 100 万画素 × 単価 × モデル係数」。UI と API は必ず同じ
//   純関数（upscaleCostBreakdown）に同じ入力を通す。倍率モードも 8K も同じ式
//   （8K の追加係数 upscale_mult_power は 2026-09-10 に撤廃 — 純 MP 課金が
//   すでに「大きい出力ほど高い」を実現しており、上乗せは釣り合わなかった）。
// - ⚠️ SeedVR2 のノンタイル上限は B300 実測（同一入力・出力 MP を振った）:
//     27MP=85GB / 61MP=189GB / 79MP=244GB(OK) / 109MP=OOM(>274GB)。
//   フィット ~3.07 GB/MP + 1GB → 真の限界 ~85-88MP。コンテンツで VRAM が
//   ブレるので UPSCALE_MAX_OUTPUT_MP=75（予測 ~231GB・~43GB マージン）。

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";

export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_INPUT_BYTES_API = 20 * 1024 * 1024;

// SeedVR2 完全ノンタイルの安全上限（MP）。上記フィット参照。
export const UPSCALE_MAX_OUTPUT_MP = 75;

export type UpscaleModelKey = "seedvr2_7b";

export type UpscaleModel = {
  key: UpscaleModelKey;
  label: string;
  descJa: string;
  /** 課金のモデル係数（計算負荷連動）。SeedVR2 = 1.0、将来 ESRGAN 等は < 1。 */
  creditMult: number;
};

export const UPSCALE_MODELS: UpscaleModel[] = [
  {
    key: "seedvr2_7b",
    label: "SeedVR2 7B",
    descJa:
      "AI生成・アニメ向け。線画や質感を作り直す発明的なリファイン。顔・キャラの同一性は保ったまま解像感を大きく引き上げます。",
    creditMult: 1.0,
  },
];

export const DEFAULT_UPSCALE_MODEL: UpscaleModelKey = "seedvr2_7b";

export function getUpscaleModel(key: string): UpscaleModel {
  return UPSCALE_MODELS.find((m) => m.key === key) ?? UPSCALE_MODELS[0];
}

// --- アップスケールモード（倍率 + 8K） ------------------------------------
export type UpscaleModeId = "x2" | "x3" | "x4" | "8k";

export type UpscaleMode = {
  id: UpscaleModeId;
  label: string;
  subLabel: string;
  kind: "multiplier" | "absolute";
  /** kind === "multiplier": 入力の各辺に掛ける倍率。 */
  mult?: number;
  /** kind === "absolute": 出力の短辺目標 px。 */
  targetShort?: number;
  /** 長辺の上限 px（SeedVR2 の max_resolution）。 */
  maxEdge: number;
  /** パワーティア（大判・ネタ枠）。課金にパワー係数が乗る。 */
  powerTier?: boolean;
};

// maxEdge は「1 辺の絶対上限」（極端なアスペクト比の暴走防止 + WebP の
// 16383px 制限回避）。実効的な上限は UPSCALE_MAX_OUTPUT_MP（面積）の方で、
// maxEdge は普通のアスペクト比ではまず当たらない緩めの値にする。
export const UPSCALE_MODES: UpscaleMode[] = [
  { id: "x2", label: "×2", subLabel: "SNS・軽い底上げ", kind: "multiplier", mult: 2, maxEdge: 13000 },
  { id: "x3", label: "×3", subLabel: "高解像度・A4印刷", kind: "multiplier", mult: 3, maxEdge: 13000 },
  { id: "x4", label: "×4", subLabel: "4K・A3印刷", kind: "multiplier", mult: 4, maxEdge: 13000 },
  {
    id: "8k",
    label: "8K",
    subLabel: "完全ノンタイル・大判印刷向け",
    kind: "absolute",
    targetShort: 5000,
    maxEdge: 13000,
    powerTier: true,
  },
];

export const DEFAULT_UPSCALE_MODE: UpscaleModeId = "x2";

export function getUpscaleMode(id: string): UpscaleMode {
  return UPSCALE_MODES.find((m) => m.id === id) ?? UPSCALE_MODES[0];
}

// --- 出力寸法・課金 --------------------------------------------------------

function round2(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * 入力寸法 + モード → SeedVR2 へ渡す target_short（短辺目標 px）。
 * 倍率モードは inputShort × mult。全モードとも「推定出力 MP ≤
 * UPSCALE_MAX_OUTPUT_MP」になるよう最後にクランプする（ノンタイル OOM 回避）。
 */
export function resolveTargetShort(inW: number, inH: number, mode: UpscaleMode): number {
  const w = Math.max(1, Math.round(inW || 0));
  const h = Math.max(1, Math.round(inH || 0));
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  const aspect = long / short;

  let target =
    mode.kind === "multiplier" ? short * (mode.mult ?? 2) : mode.targetShort ?? 1920;

  // 長辺 maxEdge クランプ。
  if (target * aspect > mode.maxEdge) target = mode.maxEdge / aspect;
  // ノンタイル安全上限（MP）クランプ。out = target × (target×aspect) = target² × aspect
  const mpCapTarget = Math.sqrt((UPSCALE_MAX_OUTPUT_MP * 1_000_000) / aspect);
  if (target > mpCapTarget) target = mpCapTarget;
  // 入力より小さくは縮小しない（倍率 ×2 で入力がすでに大きい場合の下限）。
  target = Math.max(target, short);

  return Math.round(target);
}

export function estimateOutputSize(
  inW: number,
  inH: number,
  mode: UpscaleMode,
): { width: number; height: number } {
  const w = Math.max(1, Math.round(inW || 0));
  const h = Math.max(1, Math.round(inH || 0));
  if (w <= 1 || h <= 1) return { width: 0, height: 0 };
  const short = Math.min(w, h);
  const target = resolveTargetShort(w, h, mode);
  const scale = target / short;
  return { width: round2(w * scale), height: round2(h * scale) };
}

export type UpscaleCostBreakdown = {
  credits: number;
  outputMP: number;
  outputWidth: number;
  outputHeight: number;
  effectiveMult: number;
  perMp: number;
  modelMult: number;
  clampedByMp: boolean;
};

/**
 * 純関数: 入力寸法 + モード + モデル + knob → 消費クレジット。
 * UI 表示と API 検証は必ずこれに同じ引数を渡す。入力寸法不明（0）は credits=0。
 * 8K も倍率モードも同じ式（`per_mp × 出力MP × モデル係数`）。
 */
export function upscaleCostBreakdown(args: {
  inW: number;
  inH: number;
  modeId: string;
  modelKey: string;
  knobs?: PricingKnobs;
}): UpscaleCostBreakdown {
  const knobs = args.knobs ?? DEFAULT_KNOBS;
  const mode = getUpscaleMode(args.modeId);
  const model = getUpscaleModel(args.modelKey);

  const { width, height } = estimateOutputSize(args.inW, args.inH, mode);
  const outputMP = (width * height) / 1_000_000;

  if (!args.inW || !args.inH || outputMP <= 0) {
    return {
      credits: 0,
      outputMP: 0,
      outputWidth: 0,
      outputHeight: 0,
      effectiveMult: 0,
      perMp: knobs.upscale_per_mp,
      modelMult: model.creditMult,
      clampedByMp: false,
    };
  }

  const inShort = Math.min(args.inW, args.inH);
  const effectiveMult = Math.min(width, height) / inShort;

  // クランプ警告は「倍率モードで ×N をリクエストしたのに maxEdge / MP 上限で
  // ×N 未満になった」ときだけ。8K（絶対モード）は入力サイズ次第で実効倍率が
  // 上下するのが仕様なので警告しない。
  const clampedByMp =
    mode.kind === "multiplier" && effectiveMult < (mode.mult ?? 2) - 0.05;

  const raw = Math.ceil(knobs.upscale_per_mp * outputMP * model.creditMult);
  const floor = Math.max(1, Math.round(knobs.upscale_min_credits));
  const credits = Math.max(floor, raw);

  return {
    credits,
    outputMP,
    outputWidth: width,
    outputHeight: height,
    effectiveMult,
    perMp: knobs.upscale_per_mp,
    modelMult: model.creditMult,
    clampedByMp,
  };
}

export function upscaleCredits(args: {
  inW: number;
  inH: number;
  modeId: string;
  modelKey: string;
  knobs?: PricingKnobs;
}): number {
  return upscaleCostBreakdown(args).credits;
}

/** 寸法パース不能時の上限（HEIC 等）。最大 MP 相当。 */
export function upscaleCreditsWorstCase(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.ceil(knobs.upscale_per_mp * UPSCALE_MAX_OUTPUT_MP);
}
