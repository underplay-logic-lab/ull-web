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

// アップロード先バケット・アップロード/ダウンロードのヘルパーは
// src/lib/studioUploads.ts（クライアント）/ studioUploads.server.ts
// （サーバー）に集約した — 超解像専用ではなく Studio 全体で共有する。

// 2026-09-12 以前は Vercel の約4.5MBボディ上限に収まるよう、この値も
// クライアント側の劣化圧縮（upscaleImage.ts）とセットで小さめに抑えていた。
// 直アップロード方式に変えたことでその制約が無くなったため、実用上十分
// 大きい値に引き上げた（Storage バケット自体の上限は500MB）。
export const MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const MAX_INPUT_BYTES_API = 100 * 1024 * 1024;

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

export type UpscaleModelKey =
  | "seedvr2_7b"
  | "real_esrgan_x4plus"
  | "real_esrgan_anime"
  | "swinir_l";

export type UpscaleModel = {
  key: UpscaleModelKey;
  label: string;
  descJa: string;
  /** 課金のモデル係数（計算負荷連動）。SeedVR2 = 1.0、軽量な ESRGAN/SwinIR 系は < 1。 */
  creditMult: number;
  /** modal_seedvr2_worker.py の UPSCALER_REGISTRY[key].kind をミラー。動画対応可否の判定に使う。 */
  kind: readonly ("image" | "video")[];
  /**
   * 固定倍率モデル（ESRGAN/SwinIR 系。worker 側は scale_by 固定で target_short
   * を見ない）。設定時は ×2/×4/×8 モード選択を UI 上で無視し、常にこの倍率
   * ・単発実行（カスケードなし）として扱う。SeedVR2 系は undefined のまま
   * （倍率ラダー + カスケードが有効）。
   */
  fixedScale?: number;
};

export const UPSCALE_MODELS: UpscaleModel[] = [
  {
    key: "seedvr2_7b",
    label: "SeedVR2 7B",
    descJa:
      "AI生成・アニメ向け。線画や質感を作り直す発明的なリファイン。顔・キャラの同一性は保ったまま解像感を大きく引き上げます。",
    creditMult: 1.0,
    kind: ["image", "video"],
  },
  {
    key: "real_esrgan_x4plus",
    label: "Real-ESRGAN x4plus",
    descJa:
      "実写・写真向けの素直な4倍拡大。SeedVR2と違いディテールを作り直さないので破綻せず爆速・低コスト。",
    creditMult: 0.25,
    kind: ["image"],
    fixedScale: 4,
  },
  {
    key: "swinir_l",
    label: "SwinIR-L",
    descJa:
      "実写のノイズ・JPEGブロックを除去しながら復元する4倍拡大。劣化した写真の補正に最も強い。",
    creditMult: 0.3,
    kind: ["image"],
    fixedScale: 4,
  },
  {
    key: "real_esrgan_anime",
    label: "Real-ESRGAN anime 6B",
    descJa: "アニメ・イラスト特化の4倍拡大。線をなめらかに保ったまま、SeedVR2より軽量・高速。",
    creditMult: 0.25,
    kind: ["image"],
    fixedScale: 4,
  },
];

/** 動画アップスケール（/api/studio/upscale/video）が受け付けてよいモデルだけに絞った一覧。 */
export const UPSCALE_VIDEO_MODELS: UpscaleModel[] = UPSCALE_MODELS.filter((m) =>
  m.kind.includes("video"),
);

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

/**
 * 固定倍率モデル（ESRGAN/SwinIR 系）が選ばれている場合、×2/×4/×8 の選択を
 * 無視して常に model.fixedScale・単発実行（カスケードなし）の合成モードを
 * 返す。SeedVR2 系（fixedScale 未設定）は渡された mode をそのまま返す。
 */
export function effectiveUpscaleMode(mode: UpscaleMode, model: UpscaleModel): UpscaleMode {
  if (!model.fixedScale) return mode;
  return {
    id: mode.id,
    label: `×${model.fixedScale}`,
    subLabel: "このモデルは固定倍率",
    mult: model.fixedScale,
    cascadeStages: 1,
    maxEdge: mode.maxEdge,
  };
}

// --- 出力寸法・課金 --------------------------------------------------------

function round2(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * 入力寸法 + モード + モデル → worker へ渡す target_short（短辺目標 px）。
 * 倍率モードは inputShort × mult。全モードとも「推定出力 MP ≤
 * UPSCALE_MAX_OUTPUT_MP」になるよう最後にクランプする（ノンタイル OOM 回避）。
 * 固定倍率モデル（ESRGAN/SwinIR）では mode を effectiveUpscaleMode() で
 * model.fixedScale に差し替えてから同じ式を通す（worker 自体は target_short
 * を見ないが、課金額の算出はこの関数の出力に一致させる必要がある）。
 */
export function resolveTargetShort(
  inW: number,
  inH: number,
  mode: UpscaleMode,
  model: UpscaleModel = getUpscaleModel("seedvr2_7b"),
): number {
  const m = effectiveUpscaleMode(mode, model);
  const w = Math.max(1, Math.round(inW || 0));
  const h = Math.max(1, Math.round(inH || 0));
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  const aspect = long / short;

  let target = short * m.mult;

  // 長辺 maxEdge クランプ。
  if (target * aspect > m.maxEdge) target = m.maxEdge / aspect;
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
  model: UpscaleModel = getUpscaleModel("seedvr2_7b"),
): { width: number; height: number } {
  const w = Math.max(1, Math.round(inW || 0));
  const h = Math.max(1, Math.round(inH || 0));
  if (w <= 1 || h <= 1) return { width: 0, height: 0 };
  const short = Math.min(w, h);
  const target = resolveTargetShort(w, h, mode, model);
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
  const model = getUpscaleModel(args.modelKey);
  const mode = effectiveUpscaleMode(getUpscaleMode(args.modeId), model);

  const { width, height } = estimateOutputSize(args.inW, args.inH, mode, model);
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
// VHS_VideoCombine、時間一貫性はモデル側が担保）。カスケードなし・バッチなし・
// 単一動画のみ。
//
// 値は B300 実測（2026-09-12・modal_seedvr2_worker.py 参照）に基づく:
// VRAM は frame_count に対してほぼフラット（48f=17.8GB〜1800f=19.2GB、いずれも
// 832x1024出力）で OOM の軸ではない。1800frame(30fps換算60秒)は602sで完走。
// 旧値（6秒/90フレーム）は未実測の保守的仮値で、30fps動画で実質3秒・60fpsで
// 1.5秒しか受け付けられずコンセプトと矛盾していたため引き上げた
// （modal_seedvr2_worker.py の UPSCALE_VIDEO_MAX_SECONDS / _FRAMES と一致させる
// こと）。

/** 入力動画の尺上限（秒）。超過はアップロード前にクライアントで弾く。 */
export const UPSCALE_VIDEO_MAX_SECONDS = 60;
/** 入力動画のフレーム数上限。fps が高い動画はこちらで先に頭打ちになりうる。 */
export const UPSCALE_VIDEO_MAX_FRAMES = 1800;
/** 入力動画ファイルサイズ上限。 */
export const UPSCALE_VIDEO_MAX_BYTES = 60 * 1024 * 1024;

// --- 出力解像度プリセット（倍率ではなく絶対値） -----------------------------
// 2026-09-12: 「入力 × 倍率」から「HD/2K/4K の絶対解像度を選ぶ」方式に変更。
// 理由: 倍率固定だと「4Kの動画は何秒までいける？」に答えられない
// （出力サイズが入力サイズに引きずられて青天井になる）。絶対値にすることで
// 各プリセットの実処理コスト（VRAM・時間）を固定でき、上限設計・課金の
// 両方が成立する。
//
// B300 実測（2026-09-12, 1080p入力・×2相当）:
// - 2160x3840(4Kプリセット相当・8.29MP): 90f=333s/VRAM106.6GB、
//   300f=723s/VRAM97.8GB。VRAMはここでもフラット＝解像度軸ではOOMしない
//   （少なくとも8.29MPまでは）。ただし真の4K素材(2160x3840)を入力に使うと
//   出力8K(33MP)相当になり即OOM（`workflow finished but produced no output`
//   — バッチ超解像で確認済みの同一OOMシグネチャ）。そのため「入力側」の
//   4K以上は解像度に関わらず即座に却下する（UPSCALE_VIDEO_MAX_INPUT_SHORT_EDGE）。
export type UpscaleVideoPresetId = "hd" | "2k" | "4k";

export type UpscaleVideoPreset = {
  id: UpscaleVideoPresetId;
  label: string;
  subLabel: string;
  /** 出力の短辺目標 px（入力サイズに依存しない絶対値）。 */
  targetShort: number;
};

export const UPSCALE_VIDEO_PRESETS: UpscaleVideoPreset[] = [
  { id: "hd", label: "HD", subLabel: "軽量・高速", targetShort: 1280 },
  { id: "2k", label: "2K", subLabel: "バランス", targetShort: 1920 },
  { id: "4k", label: "4K", subLabel: "最高画質(低速)", targetShort: 2160 },
];

export const DEFAULT_UPSCALE_VIDEO_PRESET: UpscaleVideoPresetId = "hd";

export function getUpscaleVideoPreset(id: string): UpscaleVideoPreset {
  return UPSCALE_VIDEO_PRESETS.find((p) => p.id === id) ?? UPSCALE_VIDEO_PRESETS[0];
}

/** これ以上の入力（短辺基準）は解像度に関わらず即座に拒否する（実質4K以上）。
 * B300実測でVRAM 274GBを超えて即OOMするため（modal_seedvr2_worker.py参照）。 */
export const UPSCALE_VIDEO_MAX_INPUT_SHORT_EDGE = 2160;

/** 出力の安全上限（MP）。極端なアスペクト比（超ワイド/超縦長）で長辺が
 * 暴走するのを防ぐ。実測でVRAMが安全だった8.29MPに余裕を見た値。 */
export const UPSCALE_VIDEO_MAX_OUTPUT_MP = 12;

/** 入力動画の解像度を検証する。エラーメッセージ or 問題なければ null。 */
export function validateVideoInputResolution(inW: number, inH: number): string | null {
  const shortEdge = Math.min(inW || 0, inH || 0);
  if (shortEdge <= 0) return null;
  if (shortEdge >= UPSCALE_VIDEO_MAX_INPUT_SHORT_EDGE) {
    return "入力動画がすでに4K相当以上のため、このタブでは処理できません。すでに高解像度なので超解像の効果もありません。";
  }
  return null;
}

export function estimateVideoOutputSize(
  inW: number,
  inH: number,
  presetId: string,
): { width: number; height: number; outputMP: number } {
  const w = Math.max(1, Math.round(inW || 0));
  const h = Math.max(1, Math.round(inH || 0));
  const preset = getUpscaleVideoPreset(presetId);
  if (w <= 1 || h <= 1) return { width: 0, height: 0, outputMP: 0 };
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  const aspect = long / short;
  const targetShort = preset.targetShort;
  const targetLong = Math.round(targetShort * aspect);
  const outW = w <= h ? targetShort : targetLong;
  const outH = w <= h ? targetLong : targetShort;
  return { width: outW, height: outH, outputMP: (outW * outH) / 1_000_000 };
}

/** プリセットごとの課金係数（HD=1.0基準）。実測の処理コスト比に基づく
 * （HD 2.91MP / 2K 6.55MP / 4K 8.29MP、16:9換算）。knob で運用調整可能。 */
function videoResolutionMultiplier(presetId: string, knobs: PricingKnobs): number {
  if (presetId === "4k") return knobs.upscale_video_mult_res_4k;
  if (presetId === "2k") return knobs.upscale_video_mult_res_2k;
  return 1.0;
}

export type UpscaleVideoCostBreakdown = {
  credits: number;
  frameCount: number;
  perFrame: number;
  modelMult: number;
  resMult: number;
  outputMP: number;
  outputWidth: number;
  outputHeight: number;
};

/**
 * 純関数: 申告された尺・fps・寸法・プリセット + モデル → 消費クレジット。
 * 動画はサーバー側で正確な寸法を読める画像と違い、クライアント申告
 * （<video> 要素の loadedmetadata）を信用するしかない。Worker 側が ffprobe
 * 実測で上限超過を検知したら failed + 返金する（差額調整はしない、常に
 * 見積り以下の実測なら通す設計）。
 */
export function upscaleVideoCostBreakdown(args: {
  durationSec: number;
  fps: number;
  inW?: number;
  inH?: number;
  presetId: string;
  modelKey: string;
  knobs?: PricingKnobs;
}): UpscaleVideoCostBreakdown {
  const knobs = args.knobs ?? DEFAULT_KNOBS;
  const model = getUpscaleModel(args.modelKey);
  const resMult = videoResolutionMultiplier(args.presetId, knobs);

  const { width, height, outputMP } = estimateVideoOutputSize(
    args.inW || 0,
    args.inH || 0,
    args.presetId,
  );

  const duration = Math.max(0, Math.min(args.durationSec || 0, UPSCALE_VIDEO_MAX_SECONDS));
  const fps = Math.max(0, args.fps || 0);
  const frameCount = Math.min(UPSCALE_VIDEO_MAX_FRAMES, Math.round(duration * fps));

  if (frameCount <= 0) {
    return {
      credits: 0,
      frameCount: 0,
      perFrame: knobs.upscale_video_per_frame,
      modelMult: model.creditMult,
      resMult,
      outputMP,
      outputWidth: width,
      outputHeight: height,
    };
  }

  const raw = Math.ceil(knobs.upscale_video_per_frame * frameCount * model.creditMult * resMult);
  const floor = Math.max(1, Math.round(knobs.upscale_video_min_credits));
  return {
    credits: Math.max(floor, raw),
    frameCount,
    perFrame: knobs.upscale_video_per_frame,
    modelMult: model.creditMult,
    resMult,
    outputMP,
    outputWidth: width,
    outputHeight: height,
  };
}

/** 動画の寸法申告が壊れている等で見積り不能なときの上限課金（最も重い4K想定）。 */
export function upscaleVideoCreditsWorstCase(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.ceil(
    knobs.upscale_video_per_frame * UPSCALE_VIDEO_MAX_FRAMES * knobs.upscale_video_mult_res_4k,
  );
}
