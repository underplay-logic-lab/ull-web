// Category-aware caption-prompt synthesis for LoRA Studio.
//
// The user picks one of four LoRA training TYPES and, in plain Japanese,
// describes:
//   - fixed   : the features that ARE the subject / must be learned into the
//               trigger token. These must NEVER appear in the captions
//               (blacklist) — if the model sees "black hair" in every caption
//               it learns "black hair" as a separate concept instead of
//               baking it into the trigger.
//   - varying : everything that changes from image to image (pose, lighting,
//               background, …). These MUST be described in rich detail so the
//               model learns they are NOT part of the trigger.
//
// buildCaptionMetaPrompt() turns that into a system instruction for Gemini,
// which returns the final English instruction handed to the Modal worker's
// Qwen-27B captioner as `caption_prompt`. buildCaptionFallbackPrompt() is the
// deterministic, no-LLM version used when Gemini is unavailable.
//
// Pure module — safe to import from both client components and route handlers.

export const LORA_CAPTION_CATEGORIES = ["person", "object", "scene", "style"] as const;
export type LoraCaptionCategory = (typeof LORA_CAPTION_CATEGORIES)[number];

export type LoraCaptionCategoryMeta = {
  /** JP label shown on the selector chip. */
  label: string;
  icon: string;
  /** How the type is named to Gemini / Qwen. */
  typeLabelEn: string;
  /** JP one-liner under the chip. */
  hint: string;
  fixedPlaceholder: string;
  varyingPlaceholder: string;
};

export const LORA_CAPTION_CATEGORY_META: Record<LoraCaptionCategory, LoraCaptionCategoryMeta> = {
  person: {
    label: "人物",
    icon: "👤",
    typeLabelEn: "character / person LoRA",
    hint: "特定の人物・キャラクターを学習",
    fixedPlaceholder: "例: 顔立ち、黒髪ロングストレート、青い制服、右目の泣きぼくろ",
    varyingPlaceholder: "例: 表情、ポーズ、手の位置、カメラアングル（バストアップ/全身）、背景、照明",
  },
  style: {
    label: "画風",
    icon: "🎨",
    typeLabelEn: "art-style LoRA",
    hint: "絵柄・タッチ・レンダリングを学習",
    fixedPlaceholder: "例: 厚塗り、彩度低めのくすんだ色調、太い主線、水彩のにじみ",
    varyingPlaceholder: "例: 描かれている被写体・物体、構図、シチュエーション、時間帯",
  },
  object: {
    label: "物質",
    icon: "📦",
    typeLabelEn: "object / product LoRA",
    hint: "特定のモノ・プロダクト・素材を学習",
    fixedPlaceholder: "例: 本体の形状、ロゴ、金属の質感、配色",
    varyingPlaceholder: "例: 置かれている場所、アングル、背景、光の当たり方、周囲の小物",
  },
  scene: {
    label: "風景",
    icon: "🏞️",
    typeLabelEn: "scene / environment LoRA",
    hint: "特定の場所・空間・世界観を学習",
    fixedPlaceholder: "例: 建物の外観、街並みのレイアウト、看板、特徴的なランドマーク",
    varyingPlaceholder: "例: 天候、時間帯、季節、写っている人物や乗り物、カメラ位置",
  },
};

export type LoraCaptionSpec = {
  category: LoraCaptionCategory;
  /** JP free text — features to LOCK IN (blacklisted from captions). */
  fixed: string;
  /** JP free text — features that VARY (described in captions). */
  varying: string;
};

export const CAPTION_SPEC_MAX_FIELD = 1500;

export function isLoraCaptionCategory(v: unknown): v is LoraCaptionCategory {
  return typeof v === "string" && (LORA_CAPTION_CATEGORIES as readonly string[]).includes(v);
}

// Coerces an arbitrary request/body value into a spec, or null when the
// category is missing/invalid. Empty fixed/varying are allowed here — use
// captionSpecHasInput() to decide whether it's worth acting on.
export function normalizeCaptionSpec(raw: unknown): LoraCaptionSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isLoraCaptionCategory(r.category)) return null;
  const str = (v: unknown) =>
    (typeof v === "string" ? v : "").replace(/\s+$/g, "").trim().slice(0, CAPTION_SPEC_MAX_FIELD);
  return { category: r.category, fixed: str(r.fixed), varying: str(r.varying) };
}

export function captionSpecHasInput(spec: LoraCaptionSpec | null | undefined): boolean {
  return Boolean(spec && (spec.fixed.trim().length > 0 || spec.varying.trim().length > 0));
}

// The system instruction for Gemini. Gemini must return ONLY the English
// instruction block (no preamble) — that block is embedded verbatim into the
// worker's [User Instructions] slot before Qwen-27B captions each image.
export function buildCaptionMetaPrompt(spec: LoraCaptionSpec, triggerWord: string): string {
  const meta = LORA_CAPTION_CATEGORY_META[spec.category];
  const trigger = (triggerWord || "").trim() || "the subject";
  return [
    "You are a senior dataset engineer who writes captioning instructions for LoRA fine-tuning.",
    `The user is training a ${meta.typeLabelEn}. The trigger word is "${trigger}".`,
    "",
    "The user describes, in Japanese, two groups of features:",
    `- FIXED / IDENTITY features (these ARE "${trigger}" and are being baked into the trigger token — they must be treated as a hard blacklist and NEVER written in any caption, even when clearly visible):`,
    `  ${spec.fixed.trim() || "(none specified — infer the obvious identity traits of this subject type and blacklist them)"}`,
    `- VARIABLE features (these change between images and MUST be described in detail so the model learns they are not part of "${trigger}"):`,
    `  ${spec.varying.trim() || "(none specified — describe every non-identity attribute: pose/orientation, composition/crop, background, lighting, and incidental objects)"}`,
    "",
    "Write a single English instruction block for the image-captioning VLM (Qwen). Requirements:",
    `1. Tell it to output ONE line of comma-separated English, starting with "${trigger}," and nothing before it.`,
    "2. Translate the user's Japanese feature lists into concrete English wording inside the instruction.",
    "3. State the blacklist explicitly: list the fixed/identity attributes and forbid mentioning them (hair colour, outfit, face shape, logo, layout, etc. — whatever the user fixed).",
    "4. Tell it to describe ONLY the variable features that are actually visible in each image, in specific detail.",
    "5. Forbid chain-of-thought, preamble, and meta commentary — the entire response must be the caption itself.",
    `6. Keep it tuned to a ${meta.typeLabelEn}: ${captionCategoryFocusHint(spec.category)}`,
    "",
    "Output ONLY the instruction block — no headings like 'Instruction:', no explanation, no markdown fences.",
  ].join("\n");
}

function captionCategoryFocusHint(category: LoraCaptionCategory): string {
  switch (category) {
    case "person":
      return "keep framing/composition tags separate from any appearance detail, and never restate the person's fixed looks.";
    case "style":
      return "describe the depicted subject matter and scene only; the artistic style/technique itself is the fixed part and must not be described.";
    case "object":
      return "describe placement, viewing angle, surroundings and lighting; the object's own shape/markings/material are fixed and must not be described.";
    case "scene":
      return "describe weather, time of day, season, camera position and any transient people/vehicles; the permanent architecture/layout is fixed and must not be described.";
  }
}

// Deterministic fallback used when Gemini is unavailable. The Modal worker's
// wrapper already tells Qwen the instruction "may be in Japanese or English",
// so we can hand the user's raw JP text straight through with an English
// blacklist frame around it.
export function buildCaptionFallbackPrompt(spec: LoraCaptionSpec, triggerWord: string): string {
  const meta = LORA_CAPTION_CATEGORY_META[spec.category];
  const trigger = (triggerWord || "").trim() || "the subject";
  const lines = [
    `Caption each image for training a ${meta.typeLabelEn}. Trigger word: "${trigger}".`,
    `Output ONE line of comma-separated English, starting with "${trigger}, ".`,
  ];
  if (spec.fixed.trim()) {
    lines.push(
      `NEVER mention these fixed / identity features (hard blacklist), even when visible — they are being learned into "${trigger}": ${spec.fixed.trim()}`,
    );
  } else {
    lines.push(
      `NEVER mention the intrinsic identity features of "${trigger}" (its permanent appearance) — they are being learned into the trigger.`,
    );
  }
  if (spec.varying.trim()) {
    lines.push(`Describe ONLY these variable features, in detail, when visible: ${spec.varying.trim()}`);
  } else {
    lines.push(
      "Describe ONLY the variable features actually visible: pose/orientation, composition and crop, background, lighting, and incidental objects.",
    );
  }
  lines.push(
    "Do not output any thinking, reasoning or preamble — the entire response must be the caption itself.",
  );
  return lines.join("\n");
}

// Strips markdown fences / stray leading labels from Gemini's reply.
export function tidyCaptionPrompt(raw: string): string {
  let out = (raw ?? "").trim();
  out = out.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
  out = out.replace(/^(?:instruction|prompt|output|caption prompt)\s*[:：]\s*/i, "").trim();
  return out;
}
