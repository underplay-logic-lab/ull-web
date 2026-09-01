// LoRA Studio model catalogue — shared by the client tab, the API route,
// and (mirrored) the Modal worker. No imports, so it's safe on both sides.

export type LoraBaseArchitecture =
  | "flux"
  | "sdxl"
  | "wan21"
  | "minimax_h3"
  | "sd3"
  | "sd15"
  | "hunyuan"
  | "cogvideox"
  | "ltx2"
  | "qwen_image"
  | "flux2_klein_4b"
  | "wan22_14b"
  | "anima";

export const LORA_BASE_ARCHITECTURES: LoraBaseArchitecture[] = [
  "flux",
  "sdxl",
  "wan21",
  "minimax_h3",
  "sd3",
  "sd15",
  "hunyuan",
  "cogvideox",
  "ltx2",
  "qwen_image",
  "flux2_klein_4b",
  "wan22_14b",
  "anima",
];

export type LoraPresetGroup = "video" | "photo" | "anime";

export type LoraPreset = {
  id: string;
  label: string;
  group: LoraPresetGroup;
  arch: LoraBaseArchitecture;
  note: string;
};

export const LORA_PRESET_GROUP_LABELS: Record<LoraPresetGroup, string> = {
  video: "🎬 動画",
  photo: "🎨 写真・汎用",
  anime: "🌸 アニメ・イラスト",
};

// FLUX.1 [dev] is deliberately absent — it is blocked outright (non-commercial
// licence). Everything else here is an openly-licensed / permissive model.
export const LORA_PRESETS: LoraPreset[] = [
  // --- video ---
  { id: "minimax_h3", label: "MiniMax H3 (33B)", group: "video", arch: "minimax_h3", note: "BF16 フル精度・動画" },
  {
    id: "wan22_14b",
    label: "WAN 2.2 (14B Video)",
    group: "video",
    arch: "wan22_14b",
    note: "WAN 2.1の次世代進化版MoE動画基盤。最高精細ビデオ生成。",
  },
  { id: "wan2_1_14b", label: "Wan 2.1 (14B)", group: "video", arch: "wan21", note: "動画 T2V 大" },
  { id: "wan2_1_1_3b", label: "Wan 2.1 (1.3B)", group: "video", arch: "wan21", note: "動画 T2V 軽量" },
  { id: "hunyuan_video", label: "HunyuanVideo", group: "video", arch: "hunyuan", note: "動画 T2V" },
  { id: "cogvideox_5b", label: "CogVideoX-5B", group: "video", arch: "cogvideox", note: "動画 T2V" },
  {
    id: "ltx_video",
    label: "LTX-2 (Lightricks Video)",
    group: "video",
    arch: "ltx2",
    note: "Lightricks の次世代動画 DiT。高速・高精細な T2V LoRA。",
  },
  // --- photo / general ---
  {
    id: "qwen_image",
    label: "Qwen-Image (Alibaba DiT)",
    group: "photo",
    arch: "qwen_image",
    note: "Alibaba開発の最新DiT。卓越したプロンプト追従性とテキスト描画性能。",
  },
  {
    id: "flux2_klein_4b",
    label: "FLUX.2 Klein (4B)",
    group: "photo",
    arch: "flux2_klein_4b",
    note: "超軽量・爆速FLUX後継モデル。低コストで高精度な静止画LoRAを高速生成。",
  },
  { id: "flux_schnell", label: "FLUX.1 [schnell]", group: "photo", arch: "flux", note: "高速画像・Apache-2.0" },
  { id: "sdxl_10", label: "SDXL 1.0", group: "photo", arch: "sdxl", note: "汎用画像" },
  { id: "sd35_large", label: "SD 3.5 Large", group: "photo", arch: "sd3", note: "高品質画像" },
  { id: "sd35_medium", label: "SD 3.5 Medium", group: "photo", arch: "sd3", note: "画像・軽量" },
  { id: "pixart_sigma", label: "PixArt-Σ", group: "photo", arch: "sdxl", note: "高解像度画像" },
  // --- anime / illustration ---
  {
    id: "anima",
    label: "Anima Base v1.0 (Anime DiT)",
    group: "anime",
    arch: "anima",
    note: "アニメ・イラスト生成に特化した次世代2B DiTモデル。",
  },
  { id: "pony_v6_xl", label: "Pony Diffusion V6 XL", group: "anime", arch: "sdxl", note: "アニメ SDXL" },
  { id: "illustrious_xl", label: "Illustrious-XL", group: "anime", arch: "sdxl", note: "イラスト SDXL" },
  { id: "animagine_xl_31", label: "Animagine XL 3.1", group: "anime", arch: "sdxl", note: "アニメ SDXL" },
  { id: "sd15", label: "SD 1.5", group: "anime", arch: "sd15", note: "軽量・LoRA 定番" },
];

export const LORA_PRESET_IDS = new Set(LORA_PRESETS.map((p) => p.id));

export function loraPresetById(id: string): LoraPreset | undefined {
  return LORA_PRESETS.find((p) => p.id === id);
}

export const LORA_RESOLUTIONS = [512, 768, 1024] as const;
export type LoraResolution = (typeof LORA_RESOLUTIONS)[number];
export const DEFAULT_LORA_RESOLUTION: LoraResolution = 768;

export const LORA_RESOLUTION_LABELS: Record<LoraResolution, string> = {
  512: "512 × 512 — 高速・軽量",
  768: "768 × 768 — 標準・推奨 / 動画モデル",
  1024: "1024 × 1024 — 超高精細 / FLUX・SDXL・Qwen-Image・DiT 系",
};

// Recommended training resolution for an architecture — the still-image DiT
// backbones (FLUX/SDXL/Qwen-Image/FLUX.2 Klein/Anima) train at 1024, SD 1.5 at
// 512, everything else (video + SD3) at 768.
export function recommendedResolution(arch: LoraBaseArchitecture): LoraResolution {
  if (
    arch === "flux" ||
    arch === "sdxl" ||
    arch === "qwen_image" ||
    arch === "flux2_klein_4b" ||
    arch === "anima"
  ) {
    return 1024;
  }
  if (arch === "sd15") return 512;
  return 768;
}

// FLUX.1 [dev] block — matches "flux dev", "flux-dev", "FLUX.1-dev",
// "black-forest-labs/FLUX.1-dev", "flux1_dev", … but never "flux schnell"
// or "flux .1 schnell".
const FLUX_DEV_RE = /flux[\s._-]*(?:1[\s._-]*)?dev\b/i;

export function isBlockedLoraModel(value: string | null | undefined): boolean {
  if (!value) return false;
  return FLUX_DEV_RE.test(value) || value.trim().toLowerCase() === "flux_dev";
}

export const BLOCKED_LORA_MODEL_MESSAGE =
  "FLUX.1 [dev] は非商用ライセンスのため LoRA Studio では利用できません。FLUX.1 [schnell]（Apache-2.0）をご利用ください。";
