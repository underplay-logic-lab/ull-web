// Pricing/quality catalog for the Cinematic Video tab (MiniMax H3 on the
// Blackwell/B300 Modal deployment — see modal_wan_animate_blackwell.py and
// cinematicWorkflow.ts). No "server-only" guard: the mode cards, credit
// costs, and target dimensions are all shown directly in the client UI, not
// just used server-side.

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

export function isCinematicAspectRatio(value: unknown): value is CinematicAspectRatio {
  return CINEMATIC_ASPECT_RATIOS.some((a) => a.id === value);
}

// Floors to the nearest 16-multiple, never below 16 — the one hard
// constraint the backend's diffusion model requires (see the "16の倍数"
// requirement in cinematicWorkflow.ts).
function floorTo16(n: number): number {
  return Math.max(16, Math.floor(n / 16) * 16);
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

// Total-pixel budget (in megapixels) for the backend's ImageScaleToTotalPixels
// safety-net resize — see buildCinematicWorkflow.
export function cinematicMegapixels(mode: CinematicMode): number {
  return (mode.baseEdge * mode.baseEdge) / 1_000_000;
}
