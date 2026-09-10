// 超解像スタジオ（SeedVR2）のフロント / API 共通設定。
//
// - モデルレジストリは modal_seedvr2_worker.py の UPSCALER_REGISTRY のうち
//   enabled なものだけをミラー（v1 は SeedVR2 7B のみ）。worker の GET /models
//   でも取れるが、価格計算と UI 初期表示のためコード側にも SSOT を置く。
// - 解像度はプリセット選択（AskUserQuestion で確定）。内部で target_short /
//   max_edge に変換して worker へ渡す。
// - 課金は「出力の 100 万画素 × 単価 × モデル係数」。UI と API は必ずこの
//   同じ純関数（upscaleCredits）に同じ入力を通し、表示と課金が食い違わない
//   ようにする（loraPricing.ts / angleStudio.ts と同じ原則）。

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";

// 生ファイルのガード（クライアント）。SeedVR2 の入力正規化レイヤーは
// worker 側（ull_image_prep）にあるので、ここは「明らかに大きすぎる」だけ弾く。
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
// API 経路（base64）で受ける 1 枚の上限。
export const MAX_INPUT_BYTES_API = 20 * 1024 * 1024;

export type UpscaleModelKey = "seedvr2_7b";

export type UpscaleModel = {
  key: UpscaleModelKey;
  label: string;
  descJa: string;
  /** 課金のモデル係数（計算負荷連動）。SeedVR2 = 1.0、将来 ESRGAN 等は < 1。 */
  creditMult: number;
};

// worker の UPSCALER_REGISTRY で enabled=True のものだけ。ESRGAN / SwinIR は
// worker 側で enabled=False なのでここにも出さない（有効化と同時に追記）。
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

// --- 解像度プリセット --------------------------------------------------------
// targetShort = 出力の短辺目標 px（SeedVR2 の resolution 入力）。
// maxEdge     = 長辺の上限 px（縦横比が極端なとき両辺を縮小。SeedVR2 の
//               max_resolution 入力）。
// v1 は 4K/8K を出さない（実測が 1920×2806 までで、それ以上の VRAM / 時間が
//   未検証のため。テスト後に追加する）。
export type ResolutionPresetId = "hd" | "2k" | "qhd";

export type ResolutionPreset = {
  id: ResolutionPresetId;
  label: string;
  subLabel: string;
  targetShort: number;
  maxEdge: number;
};

export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { id: "hd", label: "HD", subLabel: "短辺 1280px 相当", targetShort: 1280, maxEdge: 3200 },
  { id: "2k", label: "2K", subLabel: "短辺 1920px 相当", targetShort: 1920, maxEdge: 4800 },
  { id: "qhd", label: "QHD", subLabel: "短辺 2560px 相当", targetShort: 2560, maxEdge: 5120 },
];

export const DEFAULT_RESOLUTION_PRESET: ResolutionPresetId = "2k";

export function getResolutionPreset(id: string): ResolutionPreset {
  return RESOLUTION_PRESETS.find((p) => p.id === id) ?? RESOLUTION_PRESETS[1];
}

// --- 出力寸法・課金 --------------------------------------------------------

/** 入力寸法 + プリセットから、SeedVR2 が出す概算の出力寸法（偶数丸め）。 */
export function estimateOutputSize(
  inW: number,
  inH: number,
  preset: ResolutionPreset,
): { width: number; height: number } {
  const w = Math.max(1, Math.round(inW || 0));
  const h = Math.max(1, Math.round(inH || 0));
  const short = Math.min(w, h);
  let scale = preset.targetShort / short;
  // 長辺が maxEdge を超えるならさらに縮小。
  const longAfter = Math.max(w, h) * scale;
  if (longAfter > preset.maxEdge) scale = preset.maxEdge / Math.max(w, h);
  const round2 = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: round2(w * scale), height: round2(h * scale) };
}

/** 出力の 100 万画素数。 */
export function estimateOutputMP(inW: number, inH: number, preset: ResolutionPreset): number {
  const { width, height } = estimateOutputSize(inW, inH, preset);
  return (width * height) / 1_000_000;
}

export type UpscaleCostBreakdown = {
  credits: number;
  outputMP: number;
  outputWidth: number;
  outputHeight: number;
  perMp: number;
  modelMult: number;
  hitFloor: boolean;
};

/**
 * 純関数: 入力寸法 + プリセット + モデル + knob から消費クレジットを出す。
 * UI（消費クレジット表示）と API 検証は必ずこれに同じ引数を渡す。
 * 入力寸法が不明（0）のときは credits=0 を返し、UI 側で「画像を選択」を促す。
 */
export function upscaleCostBreakdown(args: {
  inW: number;
  inH: number;
  presetId: string;
  modelKey: string;
  knobs?: PricingKnobs;
}): UpscaleCostBreakdown {
  const knobs = args.knobs ?? DEFAULT_KNOBS;
  const preset = getResolutionPreset(args.presetId);
  const model = getUpscaleModel(args.modelKey);
  const { width, height } = estimateOutputSize(args.inW, args.inH, preset);
  const outputMP = (width * height) / 1_000_000;

  if (!args.inW || !args.inH || outputMP <= 0) {
    return {
      credits: 0,
      outputMP: 0,
      outputWidth: 0,
      outputHeight: 0,
      perMp: knobs.upscale_per_mp,
      modelMult: model.creditMult,
      hitFloor: false,
    };
  }

  const raw = Math.ceil(knobs.upscale_per_mp * outputMP * model.creditMult);
  const floor = Math.max(1, Math.round(knobs.upscale_min_credits));
  const credits = Math.max(floor, raw);
  return {
    credits,
    outputMP,
    outputWidth: width,
    outputHeight: height,
    perMp: knobs.upscale_per_mp,
    modelMult: model.creditMult,
    hitFloor: credits === floor && raw < floor,
  };
}

export function upscaleCredits(args: {
  inW: number;
  inH: number;
  presetId: string;
  modelKey: string;
  knobs?: PricingKnobs;
}): number {
  return upscaleCostBreakdown(args).credits;
}

/** 生 YAML 相当が無いので、寸法パース不能時の上限だけ簡易に持つ。 */
export function upscaleCreditsWorstCase(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  // QHD・16:9 極端縦横比の上限 ~ 5120 x 5120 = 26MP 相当を上限とする。
  return Math.ceil(knobs.upscale_per_mp * 27);
}
