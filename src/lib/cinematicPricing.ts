// Pricing/quality catalog for the Cinematic Video tab (MiniMax H3 on the
// Blackwell/B300 Modal deployment — see modal_wan_animate_blackwell.py and
// cinematicWorkflow.ts). No "server-only" guard: the mode cards, credit
// costs, and target dimensions are all shown directly in the client UI, not
// just used server-side.

import { DEFAULT_KNOBS, type KnobKey, type PricingKnobs } from "@/lib/pricing/knobDefaults";

export type CinematicAspectRatio = "16:9" | "9:16" | "1:1" | "4:3";

export const CINEMATIC_ASPECT_RATIOS: { id: CinematicAspectRatio; label: string; ratio: number }[] = [
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
];

export type CinematicModeId = "speed" | "standard" | "cinemaMaster";

export type CinematicMode = {
  id: CinematicModeId;
  label: string;
  tagline: string;
  credits: number;
  steps: number;
  // Applies the 4-step turbo LoRA baked into the shared Modal volume — only
  // sensible for a low step count; Cinema Master's 20-step full run skips it
  // (see buildCinematicWorkflow's loraEnabled branch).
  useTurboLora: boolean;
  // Square-equivalent edge length (px) — the actual per-aspect-ratio target
  // is derived from this via cinematicTargetDimensions, preserving this as
  // roughly the same total pixel budget across aspect ratios.
  baseEdge: number;
};

export const CINEMATIC_MODES: CinematicMode[] = [
  {
    id: "speed",
    label: "Speed Mode",
    tagline: "最速でサクッと確認",
    credits: 1,
    steps: 4,
    useTurboLora: true,
    baseEdge: 512,
  },
  {
    id: "standard",
    label: "Standard Mode",
    tagline: "画質と速度のバランス",
    credits: 2,
    steps: 4,
    useTurboLora: true,
    baseEdge: 768,
  },
  {
    id: "cinemaMaster",
    label: "Cinema Master",
    tagline: "最高画質・じっくり生成",
    credits: 5,
    steps: 20,
    useTurboLora: false,
    baseEdge: 1024,
  },
];

export const CINEMATIC_MODE_BY_ID: Record<CinematicModeId, CinematicMode> = Object.fromEntries(
  CINEMATIC_MODES.map((m) => [m.id, m]),
) as Record<CinematicModeId, CinematicMode>;

export function isCinematicModeId(value: unknown): value is CinematicModeId {
  return typeof value === "string" && value in CINEMATIC_MODE_BY_ID;
}

const CINEMATIC_MODE_KNOB: Record<CinematicModeId, KnobKey> = {
  speed: "cinematic_speed",
  standard: "cinematic_standard",
  cinemaMaster: "cinematic_cinema_master",
};

// Live per-mode credit cost. `CINEMATIC_MODES[].credits` is the hardcoded
// fallback shown before /api/studio/pricing responds; this is the
// admin-editable value both the UI and /api/generate/cinematic must use.
export function cinematicModeCredits(
  id: CinematicModeId,
  knobs: PricingKnobs = DEFAULT_KNOBS,
): number {
  return knobs[CINEMATIC_MODE_KNOB[id]];
}

export function isCinematicAspectRatio(value: unknown): value is CinematicAspectRatio {
  return CINEMATIC_ASPECT_RATIOS.some((a) => a.id === value);
}

// 2026-09-13: 当初「ピクセル ≡ 16 (mod 32)」という条件だと誤って結論したが
// （限られた実測データからの誤った逆算 — 496pxで成功した1点だけを見て
// 「+1オフセットがある」と誤診断していた）、ComfyUI 本体のノード実装
// （comfy_extras/nodes_minimax_h3.py、v0.33.3）のソースを直接確認した結果、
// 実際の式は単純だった: `latent = ピクセル // 16`（整数除算のみ、+1なし）。
// patchify（2ピクセル単位）が要求するのはこの latent が偶数であること、
// すなわち「ピクセル ≡ 0 (mod 32)」（＝32の倍数）だけ。ノード自身も
// width/height ウィジェットに `step: 32` を明記しており、これは単なるUI
// ヒントではなく実際にこの制約そのものだった。ComfyUI 標準の丸め方
// （nodes_minimax_h3.py の adapt_canvas 関数と同じ `round(n / 32) * 32`）
// に合わせて floor ではなく round にする。
function floorTo16(n: number): number {
  return Math.max(32, Math.round(n / 32) * 32);
}

// Target width/height for a given mode + aspect ratio: keeps the same total
// pixel budget as the mode's square baseEdge (e.g. speed's 512 -> 512*512
// px) while respecting the chosen aspect ratio exactly, then floors both
// dimensions to a multiple of 16. Shared by the client-side cropper (what
// size to render the crop into) and, implicitly, by the backend's
// ImageScaleToTotalPixels node (megapixels derived from the same baseEdge —
// see cinematicMegapixels below), so the two stay consistent.
export function cinematicTargetDimensions(
  mode: CinematicMode,
  aspect: CinematicAspectRatio,
): { width: number; height: number } {
  const ratioEntry = CINEMATIC_ASPECT_RATIOS.find((a) => a.id === aspect) ?? CINEMATIC_ASPECT_RATIOS[0];
  const targetPixels = mode.baseEdge * mode.baseEdge;
  const height = Math.sqrt(targetPixels / ratioEntry.ratio);
  const width = height * ratioEntry.ratio;
  return { width: floorTo16(width), height: floorTo16(height) };
}

/**
 * cinematicTargetDimensions は固定の4アスペクト比（CINEMATIC_ASPECT_RATIOS）
 * にしか対応していない。ULL Cinematic Director はユーザーがクロップせず
 * 任意アスペクト比の画像をそのままアップロードするため、実際の画像の
 * 生の幅・高さから同じ「ピクセル ≡ 0 (mod 32)」を満たす安全な目標解像度を
 * 直接計算する（2026-09-13 実障害: 正方形以外のアスペクト比で
 * ImageScaleToTotalPixels の動的サイズ決定に任せた結果、この条件を満たさない
 * 解像度になり patchify がクラッシュした）。width/height を個別に
 * floorTo16（実際は round-to-32）でスナップするため、必ずどちらも
 * 安全な値になる。
 */
export function cinematicSafeDimensions(
  rawWidth: number,
  rawHeight: number,
  targetMegapixels: number,
): { width: number; height: number } {
  const aspect = Math.max(1, rawWidth) / Math.max(1, rawHeight);
  const targetPixels = targetMegapixels * 1_000_000;
  const height = Math.sqrt(targetPixels / aspect);
  const width = height * aspect;
  return { width: floorTo16(width), height: floorTo16(height) };
}

// Total-pixel budget (in megapixels) for the backend's ImageScaleToTotalPixels
// safety-net resize — see buildCinematicWorkflow. Must derive from the SAME
// floorTo16-adjusted edge as cinematicTargetDimensions (not the raw
// baseEdge), otherwise the frontend's pre-crop target and the backend's
// safety-net resize target land on different pixel parities — exactly the
// mismatch that caused the 2026-09-13 patchify crash (see floorTo16's
// comment). Both must agree on the same "ピクセル ≡ 16 (mod 32)" edge.
export function cinematicMegapixels(mode: CinematicMode): number {
  const edge = floorTo16(mode.baseEdge);
  return (edge * edge) / 1_000_000;
}
