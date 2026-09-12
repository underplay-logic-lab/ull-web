// 超解像スタジオ（SeedVR2）のフロント / API 共通設定。
//
// - モデルレジストリは modal_seedvr2_worker.py の UPSCALER_REGISTRY のうち
//   enabled なものだけをミラー（v1 は SeedVR2 7B のみ）。
// - 解像度は **倍率ラダー ×2 / ×4 / ×8**（すべて2の冪）。ESRGAN 等の一般的な
//   アップスケーラーと同じメンタルモデル。内部で target_short / max_edge に
//   変換して worker へ渡す。
// - 2026-09-12: ×3 と絶対プリセット「8K」を廃止し ×2/×4/×8 に統一した。
//   理由: (1) B300 実測（yukipas.png）で「単発直行より ×2 刻みの多段カスケード
//   の方が高画質」と確認済み（顔・エフェクト・髪の描き込みがシャープ）。
//   カスケードは前段の出力をそのまま次段の入力に渡す実装のため、2の冪の
//   倍率でないと段が綺麗に割れない（×3 は ×2 の繰り返しで作れない）。
//   (2) ローンチ前で実利用データが無く、×3 の需要を裏付ける根拠も無い状態
//   だったため、複雑な例外を残すより単純なラダーに倒した。
// - worker（modal_seedvr2_worker.py の `_do_upscale`）は target_short と
//   実際の入力短辺から必要な ×2 段数を自動算出し、×4/×8 は内部で複数回
//   SeedVR2 を通す（×2 はこれまで通り単発1回）。
// - 課金は「出力の 100 万画素 × 単価 × モデル係数 × カスケード係数」。UI と
//   API は必ず同じ純関数（upscaleCostBreakdown）に同じ入力を通す。カスケード
//   係数は実測の追加GPU秒（×4=2段で理論値~1.25倍、×8=3段で実測1.45倍）を
//   反映する knob（upscale_cascade_mult_2stage / _3stage）。
// - ⚠️ SeedVR2 のノンタイル上限は B300 実測（同一入力・出力 MP を振った）:
//     27MP=85GB / 61MP=189GB / 79MP=244GB(OK) / 109MP=OOM(>274GB)。
//   フィット ~3.07 GB/MP + 1GB → 真の限界 ~85-88MP。コンテンツで VRAM が
//   ブレるので UPSCALE_MAX_OUTPUT_MP=75（予測 ~231GB・~43GB マージン）。
//   カスケードの各段も最終段の出力MPは変わらないので、この上限はそのまま
//   適用できる（前段は必ず最終段より小さい）。

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";

export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_INPUT_BYTES_API = 20 * 1024 * 1024;

// SeedVR2 完全ノンタイルの安全上限（MP）。上記フィット参照。
export const UPSCALE_MAX_OUTPUT_MP = 75;

// --- バッチ（複数画像まとめて処理） ----------------------------------------
// 2026-09-12: 1コンテナ内で温まったまま順番に処理する（コールドスタート償却は
// バッチ全体で1回分だけ）。上限は「枚数」ではなく「推定合計処理秒数」と
// 「合計アップロードサイズ」で決める — ×8の大判なら数枚、×2の軽い出力なら
// 数十枚、というふうに入力サイズ・倍率次第で実際に処理できる枚数は変わる。
// これらは金額を動かす pricing knob ではなく、リクエストボディサイズ等の
// インフラ都合の安全上限なのでプレーンな定数にしてある。
export const UPSCALE_BATCH_MAX_ITEMS = 30;
export const UPSCALE_BATCH_MAX_TOTAL_BYTES = 40 * 1024 * 1024;

/**
 * バッチ全体（N枚）の推定処理秒数。コールドスタート猶予は1回分だけ加える
 * （2枚目以降は同じ温まったコンテナで処理されるため）。
 * upscale_time_per_credit_s / upscale_cold_start_grace_s は単発ジョブの
 * cost-guard（upscaleMaxAllowedTime）と共有する既存 knob。
 */
export function upscaleBatchEstimatedSeconds(
  totalCredits: number,
  knobs: PricingKnobs = DEFAULT_KNOBS,
): number {
  return Math.max(0, totalCredits) * knobs.upscale_time_per_credit_s + knobs.upscale_cold_start_grace_s;
}

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

// --- アップスケールモード（倍率ラダー ×2/×4/×8） --------------------------
export type UpscaleModeId = "x2" | "x4" | "x8";

export type UpscaleMode = {
  id: UpscaleModeId;
  label: string;
  subLabel: string;
  /** 入力の各辺に掛ける倍率（常に2の冪）。 */
  mult: number;
  /** worker 側で自動的に何段の ×2 カスケードにするか（1 = 単発）。 */
  cascadeStages: 1 | 2 | 3;
  /** 長辺の上限 px（SeedVR2 の max_resolution）。 */
  maxEdge: number;
};

// maxEdge は「1 辺の絶対上限」（極端なアスペクト比の暴走防止 + WebP の
// 16383px 制限回避）。実効的な上限は UPSCALE_MAX_OUTPUT_MP（面積）の方で、
// maxEdge は普通のアスペクト比ではまず当たらない緩めの値にする。
export const UPSCALE_MODES: UpscaleMode[] = [
  { id: "x2", label: "×2", subLabel: "SNS・軽い底上げ", mult: 2, cascadeStages: 1, maxEdge: 13000 },
  { id: "x4", label: "×4", subLabel: "4K・A3印刷・高画質(多段処理)", mult: 4, cascadeStages: 2, maxEdge: 13000 },
  { id: "x8", label: "×8", subLabel: "完全ノンタイル・大判印刷向け(多段処理)", mult: 8, cascadeStages: 3, maxEdge: 13000 },
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

  let target = short * mode.mult;

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
  cascadeStages: number;
  cascadeMult: number;
  clampedByMp: boolean;
};

/** モードのカスケード段数 → 追加課金係数（1段=単発は1.0固定）。 */
function cascadeCreditMultiplier(stages: number, knobs: PricingKnobs): number {
  if (stages >= 3) return knobs.upscale_cascade_mult_3stage;
  if (stages === 2) return knobs.upscale_cascade_mult_2stage;
  return 1.0;
}

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
      cascadeStages: mode.cascadeStages,
      cascadeMult: cascadeCreditMultiplier(mode.cascadeStages, knobs),
      clampedByMp: false,
    };
  }

  const inShort = Math.min(args.inW, args.inH);
  const effectiveMult = Math.min(width, height) / inShort;

  // クランプ警告は「×N をリクエストしたのに maxEdge / MP 上限で ×N 未満に
  // なった」ときだけ。
  const clampedByMp = effectiveMult < mode.mult - 0.05;

  const cascadeMult = cascadeCreditMultiplier(mode.cascadeStages, knobs);
  const raw = Math.ceil(knobs.upscale_per_mp * outputMP * model.creditMult * cascadeMult);
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
    cascadeStages: mode.cascadeStages,
    cascadeMult,
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

/** 寸法パース不能時の上限（HEIC 等）。最大 MP × 最悪カスケード係数(×8/3段)。 */
export function upscaleCreditsWorstCase(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.ceil(
    knobs.upscale_per_mp * UPSCALE_MAX_OUTPUT_MP * knobs.upscale_cascade_mult_3stage,
  );
}

// --- 動画アップスケール v1（最小スコープ） ---------------------------------
// SeedVR2 ネイティブの動画モード（VHS_LoadVideo → SeedVR2VideoUpscaler →
// VHS_VideoCombine、時間一貫性はモデル側が担保）。倍率は ×2 固定・カスケード
// なし・バッチなし・単一動画のみ。
//
// 値は B300 実測（2026-09-12・modal_seedvr2_worker.py 参照）に基づく:
// VRAM は frame_count に対してほぼフラット（48f=17.8GB〜1800f=19.2GB）で
// OOM の軸ではない。1800frame(30fps換算60秒)は602sで完走・Modal関数の45分
// ハードキャップにも十分収まる。旧値（6秒/90フレーム）は未実測の保守的仮値
// で、30fps動画で実質3秒・60fpsで1.5秒しか受け付けられずコンセプトと矛盾
// していたため引き上げた（modal_seedvr2_worker.py の UPSCALE_VIDEO_MAX_SECONDS
// / _FRAMES と一致させること）。

/** 入力動画の尺上限（秒）。超過はアップロード前にクライアントで弾く。 */
export const UPSCALE_VIDEO_MAX_SECONDS = 60;
/** 入力動画のフレーム数上限。fps が高い動画はこちらで先に頭打ちになりうる。 */
export const UPSCALE_VIDEO_MAX_FRAMES = 1800;
/** 入力動画ファイルサイズ上限。 */
export const UPSCALE_VIDEO_MAX_BYTES = 60 * 1024 * 1024;
/** v1 は倍率固定（×2 のみ）。カスケード・倍率選択は将来の拡張。 */
export const UPSCALE_VIDEO_MULT = 2;

export type UpscaleVideoCostBreakdown = {
  credits: number;
  frameCount: number;
  perFrame: number;
  modelMult: number;
};

/**
 * 純関数: 申告された尺・fps + モデル → 消費クレジット。
 * 動画はサーバー側で正確な寸法を読める画像と違い、クライアント申告
 * （<video> 要素の loadedmetadata）を信用するしかない。Worker 側が ffprobe
 * 実測で上限超過を検知したら failed + 返金する（差額調整はしない、常に
 * 見積り以下の実測なら通す設計）。
 */
export function upscaleVideoCostBreakdown(args: {
  durationSec: number;
  fps: number;
  modelKey: string;
  knobs?: PricingKnobs;
}): UpscaleVideoCostBreakdown {
  const knobs = args.knobs ?? DEFAULT_KNOBS;
  const model = getUpscaleModel(args.modelKey);

  const duration = Math.max(0, Math.min(args.durationSec || 0, UPSCALE_VIDEO_MAX_SECONDS));
  const fps = Math.max(0, args.fps || 0);
  const frameCount = Math.min(UPSCALE_VIDEO_MAX_FRAMES, Math.round(duration * fps));

  if (frameCount <= 0) {
    return { credits: 0, frameCount: 0, perFrame: knobs.upscale_video_per_frame, modelMult: model.creditMult };
  }

  const raw = Math.ceil(knobs.upscale_video_per_frame * frameCount * model.creditMult);
  const floor = Math.max(1, Math.round(knobs.upscale_video_min_credits));
  return {
    credits: Math.max(floor, raw),
    frameCount,
    perFrame: knobs.upscale_video_per_frame,
    modelMult: model.creditMult,
  };
}

/** 動画の寸法申告が壊れている等で見積り不能なときの上限課金。 */
export function upscaleVideoCreditsWorstCase(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.ceil(knobs.upscale_video_per_frame * UPSCALE_VIDEO_MAX_FRAMES);
}
