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
  | "cogvideox";

export const LORA_BASE_ARCHITECTURES: LoraBaseArchitecture[] = [
  "flux",
  "sdxl",
  "wan21",
  "minimax_h3",
  "sd3",
  "sd15",
  "hunyuan",
  "cogvideox",
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
  { id: "wan2_1_14b", label: "Wan 2.1 (14B)", group: "video", arch: "wan21", note: "動画 T2V 大" },
  { id: "wan2_1_1_3b", label: "Wan 2.1 (1.3B)", group: "video", arch: "wan21", note: "動画 T2V 軽量" },
  { id: "hunyuan_video", label: "HunyuanVideo", group: "video", arch: "hunyuan", note: "動画 T2V" },
  { id: "cogvideox_5b", label: "CogVideoX-5B", group: "video", arch: "cogvideox", note: "動画 T2V" },
  { id: "ltx_video", label: "LTX-Video", group: "video", arch: "cogvideox", note: "高速動画" },
  // --- photo / general ---
  { id: "flux_schnell", label: "FLUX.1 [schnell]", group: "photo", arch: "flux", note: "高速画像・Apache-2.0" },
  { id: "sdxl_10", label: "SDXL 1.0", group: "photo", arch: "sdxl", note: "汎用画像" },
  { id: "sd35_large", label: "SD 3.5 Large", group: "photo", arch: "sd3", note: "高品質画像" },
  { id: "sd35_medium", label: "SD 3.5 Medium", group: "photo", arch: "sd3", note: "画像・軽量" },
  { id: "pixart_sigma", label: "PixArt-Σ", group: "photo", arch: "sdxl", note: "高解像度画像" },
  // --- anime / illustration ---
  { id: "pony_v6_xl", label: "Pony Diffusion V6 XL", group: "anime", arch: "sdxl", note: "アニメ SDXL" },
  { id: "illustrious_xl", label: "Illustrious-XL", group: "anime", arch: "sdxl", note: "イラスト SDXL" },
  { id: "animagine_xl_31", label: "Animagine XL 3.1", group: "anime", arch: "sdxl", note: "アニメ SDXL" },
  { id: "sd15", label: "SD 1.5", group: "anime", arch: "sd15", note: "軽量・LoRA 定番" },
];

export const LORA_PRESET_IDS = new Set(LORA_PRESETS.map((p) => p.id));

export function loraPresetById(id: string): LoraPreset | undefined {
  return LORA_PRESETS.find((p) => p.id === id);
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
