// 動画の部分修正（2026-10-07〜）の窓の計算・GPU の振り分け・料金。画面（予告）と API（課金）で同じ関数を使う。
// 窓の計算は ull_video_fix.py の plan_window と同じ（ワーカーが元の動画を読んで同じ計算をし直す。料金を決めた窓の秒数を
// 上限として渡すので、申告の長さが違っても料金を超えて処理することはない）。片方を変えたらもう片方も揃える。

import { CINEMATIC_MAX_MEGAPIXEL_SECONDS } from "@/lib/cinematicPricing";
import { directorExtraRefSurcharge } from "@/lib/directorPricing";
import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";

export const VIDEO_FIX_FPS = 24;
/** 整えた後の画素数の上限（Director 高速モードの解像度・1024×1024 相当）。Director の動画はそのままの寸法。 */
export const VIDEO_FIX_MAX_PIXELS = 1024 * 1024;
/** 元の動画の最長（秒）。窓だけを処理するので長くてもよいが、取り込み・整える処理（CPU）の時間を抑える。 */
export const VIDEO_FIX_MAX_SOURCE_S = 300;
/** なじませる側に渡す、元の映像の手がかり（秒）。 */
export const VIDEO_FIX_PREROLL_S = 3;
export const VIDEO_FIX_POSTROLL_S = 2;
/** 指示文の最長（文字）。 */
export const VIDEO_FIX_PROMPT_MAX_LENGTH = 2000;
/** 作り直す区間の最短（秒）。 */
export const VIDEO_FIX_MIN_REGEN_S = 1;

export type VideoFixSeam = "blend" | "cut";
export type VideoFixGpu = "RTX-PRO-6000" | "H200" | "B300";

export function isVideoFixSeam(v: unknown): v is VideoFixSeam {
  return v === "blend" || v === "cut";
}

function alignFrameCount(n: number): number {
  let f = Math.max(5, n);
  while (f % 17 !== 5) f += 1;
  return f;
}

/** 縦横比を保ち maxPixels 以下で 32 の倍数に（拡大はしない）。ull_video_fix.safe_dims と同じ。 */
export function videoFixDims(width: number, height: number, maxPixels = VIDEO_FIX_MAX_PIXELS): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, width * height)));
  const snap = (n: number) => Math.max(32, Math.floor(Math.floor(n * scale) / 32) * 32);
  return { width: snap(width), height: snap(height) };
}

/** 窓の最長（秒）。knob と、Director 全体のメガピクセル秒の上限（B300 実測）の小さい方。 */
export function videoFixMaxWindowS(megapixels: number, knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.min(knobs.video_fix_max_window_s, CINEMATIC_MAX_MEGAPIXEL_SECONDS / Math.max(0.01, megapixels));
}

export type VideoFixPlan = {
  totalFrames: number;
  regenStart: number;
  regenEnd: number;
  toEnd: boolean;
  winStart: number;
  winFrames: number;
  winSeconds: number;
  /** 窓の上限で、作り直す区間の終わりを手前に詰めたか。 */
  truncated: boolean;
};

/** ull_video_fix.plan_window と同じ（フレーム単位）。不正な指定は Error（文面はそのまま画面に出せる）。 */
export function planVideoFixWindow(args: {
  totalFrames: number;
  startS: number;
  endS: number | null;
  maxWindowS: number;
  seamStart: VideoFixSeam;
  seamEnd: VideoFixSeam;
}): VideoFixPlan {
  const n = args.totalFrames;
  const fps = VIDEO_FIX_FPS;
  if (n < fps) throw new Error("動画が短すぎます（1 秒以上）。");
  const rs = Math.round(args.startS * fps);
  if (rs < 0 || rs >= n - 1) throw new Error(`開始秒は動画の長さ（${(n / fps).toFixed(1)} 秒）より前にしてください。`);
  let re = args.endS == null || args.endS < 0 ? n : Math.min(n, Math.round(args.endS * fps));
  if (re <= rs) throw new Error("終了秒は開始秒より後にしてください。");
  const requestedEnd = re;
  const preF = args.seamStart === "cut" ? 0 : Math.round(VIDEO_FIX_PREROLL_S * fps);
  const postF = args.seamEnd === "cut" ? 0 : Math.round(VIDEO_FIX_POSTROLL_S * fps);
  const maxF = Math.floor(args.maxWindowS * fps);
  const ws = Math.max(0, rs - preF);
  let frames: number;
  for (;;) {
    const we = re === n ? n : Math.min(n, re + postF);
    frames = alignFrameCount(we - ws);
    if (frames <= maxF || re - rs <= fps) break;
    re = rs + Math.max(fps, re - rs - (frames - maxF) - 1);
  }
  if (frames > maxF) throw new Error("作り直す区間が短すぎます。");
  return {
    totalFrames: n,
    regenStart: rs,
    regenEnd: re,
    toEnd: re === n,
    winStart: ws,
    winFrames: frames,
    winSeconds: frames / fps,
    truncated: re < requestedEnd,
  };
}

/** 窓の大きさ（メガピクセル秒）から GPU を選ぶ。一番安い GPU から、収まる所。 */
export function videoFixGpu(megapixelSeconds: number, knobs: PricingKnobs = DEFAULT_KNOBS): VideoFixGpu {
  if (megapixelSeconds <= knobs.video_fix_pro6000_max_mps) return "RTX-PRO-6000";
  if (megapixelSeconds <= knobs.video_fix_h200_max_mps) return "H200";
  return "B300";
}

export type VideoFixQuote = VideoFixPlan & {
  width: number;
  height: number;
  megapixelSeconds: number;
  baseCredits: number;
  credits: number;
};

/** 料金の見積もり（画面の予告と API の課金で共通）。durationS・width・height は元の動画（Director の記録か画面が測った値）。 */
export function videoFixQuote(args: {
  durationS: number;
  width: number;
  height: number;
  startS: number;
  endS: number | null;
  seamStart: VideoFixSeam;
  seamEnd: VideoFixSeam;
  extraRefCount: number;
  knobs?: PricingKnobs;
}): VideoFixQuote {
  const knobs = args.knobs ?? DEFAULT_KNOBS;
  const dims = videoFixDims(args.width, args.height);
  const mp = (dims.width * dims.height) / 1_000_000;
  const plan = planVideoFixWindow({
    totalFrames: Math.round(args.durationS * VIDEO_FIX_FPS),
    startS: args.startS,
    endS: args.endS,
    maxWindowS: videoFixMaxWindowS(mp, knobs),
    seamStart: args.seamStart,
    seamEnd: args.seamEnd,
  });
  const base = Math.max(Math.round(knobs.director_min_credits), Math.ceil(plan.winSeconds * knobs.video_fix_per_second));
  return {
    ...plan,
    ...dims,
    megapixelSeconds: plan.winSeconds * mp,
    baseCredits: base,
    credits: base + directorExtraRefSurcharge(base, args.extraRefCount, knobs),
  };
}
