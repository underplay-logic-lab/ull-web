// LoRA Studio model catalogue — shared by the client tab, the API route,
// and (mirrored) the Modal worker. No imports, so it's safe on both sides.
//
// Sealed to a fixed commercial lineup (see the "全面再編" pass): every model
// here is openly-licensed / permissive and has been verified to load in
// ai-toolkit. Qwen-Image (20B) is temporarily hidden below for Volume storage
// cost (its arch string / TARGET_MODELS entry stays). FLUX.2 [dev] was removed
// outright — non-commercial licence, now blocked by isBlockedLoraModel().
// Free-text "any HuggingFace repo id" entry
// is deliberately NOT exposed in the general UI any more (LoraStudioTab.tsx
// no longer renders the "⚙️ 上級者向け" custom-model option) — this array is
// the ONLY way an ordinary user reaches a base model.

export type LoraBaseArchitecture =
  | "wan21"
  | "wan22_14b"
  | "ltx2"
  | "minimax_h3"
  | "flux2_klein_4b"
  | "qwen_image"
  | "krea2"
  | "zimage"
  | "anima"
  | "sdxl";

export const LORA_BASE_ARCHITECTURES: LoraBaseArchitecture[] = [
  "wan21",
  "wan22_14b",
  "ltx2",
  "minimax_h3",
  "flux2_klein_4b",
  "qwen_image",
  "krea2",
  "zimage",
  "anima",
  "sdxl",
];

export type LoraPresetGroup = "video" | "photo" | "anime";

export type LoraPreset = {
  id: string;
  label: string;
  group: LoraPresetGroup;
  arch: LoraBaseArchitecture;
  note: string;
  // Pricing-only override for loraPriceBreakdown()'s modelMult — used when a
  // preset shares its real ai-toolkit `arch` (the loader class; must stay
  // correct for training) with a materially cheaper sibling. Currently only
  // WAN 2.1 1.3B needs this: it shares arch:"wan21" with the 14B (which prices
  // 3.0x as a HEAVY_LORA_ARCHES member) but is priced 1.0x. Omit to price
  // purely from `arch` membership in HEAVY_LORA_ARCHES (the normal case).
  pricingModelMult?: number;
  // The exact HuggingFace repo id the Modal worker resolves for this preset
  // (mirrors TARGET_MODELS[<id>].unet in modal_lora_worker.py). Informational
  // on the client; the worker is the source of truth.
  repo?: string;
  // Per-preset training-resolution recommendation; falls back to
  // recommendedResolution(arch) when omitted.
  recommendedResolution?: LoraResolution;
};

export const LORA_PRESET_GROUP_LABELS: Record<LoraPresetGroup, string> = {
  video: "🎬 動画",
  photo: "🎨 写真・汎用",
  anime: "🌸 アニメ・イラスト",
};

// The confirmed commercial lineup — curated for licence safety and verified
// ai-toolkit compatibility. Deprecated / rights-risk / unverified models
// removed in an earlier pass: CogVideoX-5B, HunyuanVideo, SD 3.5 Large/
// Medium, PixArt-Σ, SD 1.5, FLUX.1 [schnell], SDXL 1.0 (base), Animagine XL
// 3.1 — FLUX.1 [dev] was never listed here (blocked outright below).
// FLUX.2 [dev] ("flux2") removed outright: FLUX Non-Commercial License, cannot
// be hosted by a commercial SaaS (same as FLUX.1 [dev] / FLUX.2 [klein] 9B).
// arch string, TARGET_MODELS entry and HF cache all deleted; blocked below.
export const LORA_PRESETS: LoraPreset[] = [
  // --- video (HEAVY_LORA_ARCHES -> 3.0x) ---
  // WAN 2.1 RETIRED — superseded by WAN 2.2 below. Kept commented for history.
  // { id: "wan21_14b", label: "WAN 2.1 (14B Video)", group: "video", arch: "wan21", note: "動画 T2V 大" },
  // {
  //   id: "wan21_1.3b",
  //   label: "WAN 2.1 (1.3B Video)",
  //   group: "video",
  //   arch: "wan21",
  //   note: "動画 T2V 軽量",
  //   pricingModelMult: 1.0,
  // },
  {
    id: "wan22_14b",
    label: "WAN 2.2 (14B Video)",
    group: "video",
    arch: "wan22_14b",
    note: "WAN 2.1の次世代進化版MoE動画基盤。最高精細ビデオ生成。",
  },
  {
    id: "ltx_video",
    label: "LTX-2 (Lightricks Video)",
    group: "video",
    arch: "ltx2",
    note: "Lightricks の次世代動画 DiT。高速・高精細な T2V LoRA。",
  },
  { id: "minimax_h3", label: "Minimax H3", group: "video", arch: "minimax_h3", note: "BF16 フル精度・動画" },
  // --- photo / general (1.0x) ---
  {
    id: "flux2_klein_4b",
    label: "FLUX.2 Klein (4B)",
    group: "photo",
    arch: "flux2_klein_4b",
    note: "超軽量・爆速FLUX後継モデル。低コストで高精度な静止画LoRAを高速生成。",
  },
  // FLUX.2 [klein] 9B ("flux2_klein_9b") — 完全撤去。9B は FLUX Non-Commercial
  // License（商用SaaSでのホスト禁止）のため ULL Studio（商用サービス）では
  // 提供不可。型・TARGET_MODELS・SPI ベースラインからも削除済みで、
  // isBlockedLoraModel() でも明示的にブロックする。FLUX 系の主力は
  // 商用フリー（Apache 2.0）の flux2_klein_4b に統一。
  // FLUX.2 [dev] ("flux2") — 完全撤去。FLUX Non-Commercial License のため商用
  // SaaS でホスト不可（FLUX.1 [dev] / FLUX.2 [klein] 9B と同じ）。arch union・
  // LORA_BASE_ARCHITECTURES・worker の TARGET_MODELS からも削除し、HF キャッシュ
  // （transformer + 24B Mistral TE, ~210GB）は admin_cleanup_volume でパージ済み。
  // isBlockedLoraModel() で明示ブロック。FLUX 系の主力は商用フリー（Apache 2.0）
  // の flux2_klein_4b に統一。
  // Qwen-Image (Alibaba 20B) ("qwen_image") — 一般ユーザー向けプリセットから
  // 一旦非表示。Comfy 単一ファイル transformer(~40GB) + Qwen2.5-VL TE で Volume
  // 実消費が大きく、需要も薄いため（Minimax H3 TE ベイク領域を 1TB 無料枠内で
  // 確保する対応）。arch:"qwen_image" 自体（型・API検証・worker 側 TARGET_MODELS）
  // は残しているので、再開時はこのブロックを戻すだけでよい。共有 HF snapshot
  // "Qwen/Qwen-Image" は krea2 が VAE で使うため物理パージ対象外。
  // {
  //   id: "qwen_image",
  //   label: "Qwen-Image (Alibaba 20B)",
  //   group: "photo",
  //   arch: "qwen_image",
  //   note: "Alibaba開発の最新DiT。卓越したプロンプト追従性とテキスト描画性能。",
  // },
  { id: "krea2", label: "Krea 2", group: "photo", arch: "krea2", note: "写実性に強い最新世代の汎用DiT。" },
  {
    id: "zimage",
    label: "Z-Image Turbo",
    group: "photo",
    arch: "zimage",
    note: "超高速ステップの軽量ターボモデル。",
  },
  {
    id: "juggernaut_xl",
    label: "Juggernaut XL (Photo/Real SDXL)",
    group: "photo",
    arch: "sdxl",
    note: "写実・実写系に強い定番SDXLファインチューン。",
    repo: "RunDiffusion/Juggernaut-XL-v9",
    recommendedResolution: 1024,
    pricingModelMult: 1.0,
  },
  // --- anime / illustration (1.0x) ---
  {
    id: "anima",
    label: "Anima Base v1.0 (Anime DiT)",
    group: "anime",
    arch: "anima",
    note: "アニメ・イラスト生成に特化した次世代2B DiTモデル。",
  },
  { id: "illustrious_xl", label: "Illustrious XL", group: "anime", arch: "sdxl", note: "イラスト SDXL" },
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
  1024: "1024 × 1024 — 超高精細 / 静止画 DiT 系",
};

// Recommended training resolution for an architecture — the still-image DiT
// backbones train at 1024; every video arch trains at 768.
const STILL_IMAGE_ARCHES: ReadonlySet<LoraBaseArchitecture> = new Set([
  "flux2_klein_4b",
  "qwen_image",
  "krea2",
  "zimage",
  "anima",
  "sdxl",
]);

export function recommendedResolution(arch: LoraBaseArchitecture): LoraResolution {
  return STILL_IMAGE_ARCHES.has(arch) ? 1024 : 768;
}

// FLUX.1 [dev] block — matches "flux dev", "flux-dev", "FLUX.1-dev",
// "black-forest-labs/FLUX.1-dev", "flux1_dev", … but never "flux schnell",
// "flux .1 schnell", or the commercial-OK FLUX.2 Klein 4B.
const FLUX_DEV_RE = /flux[\s._-]*(?:1[\s._-]*)?dev\b/i;
// FLUX.2 [dev] block — FLUX Non-Commercial License. matches "flux2dev",
// "flux.2-dev", "FLUX.2 dev", "black-forest-labs/FLUX.2-dev", … (the "2" is
// what separates it from FLUX_DEV_RE, which only reaches ".1"/bare).
const FLUX2_DEV_RE = /flux[\s._-]*2[\s._-]*dev\b/i;
// FLUX.2 [klein] 9B block — FLUX Non-Commercial License (商用SaaSでのホスト
// 禁止)。matches "flux2_klein_9b", "black-forest-labs/FLUX.2-klein-base-9B",
// "flux.2 klein 9b", … but never the Apache-2.0 4B variant.
const FLUX2_KLEIN_9B_RE = /flux[\s._-]*2[\s._-]*klein[\w\s.-]{0,24}9b\b/i;

export function isBlockedLoraModel(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return (
    FLUX_DEV_RE.test(value) ||
    FLUX2_DEV_RE.test(value) ||
    v === "flux_dev" ||
    v === "flux2" ||
    v === "flux2_dev" ||
    v === "flux2_klein_9b" ||
    FLUX2_KLEIN_9B_RE.test(value)
  );
}

export const BLOCKED_LORA_MODEL_MESSAGE =
  "FLUX.1 [dev] / FLUX.2 [dev] / FLUX.2 [klein] 9B は非商用ライセンスのため LoRA Studio では利用できません。FLUX.2 Klein (4B) などの商用可モデルをご利用ください。";
