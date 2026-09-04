// Category-aware caption-prompt synthesis for LoRA Studio.
//
// The user picks one of FIVE LoRA training TYPES and, in plain Japanese,
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
// When the user leaves BOTH boxes empty we do NOT fall back to "describe the
// whole image" — that hollows out the trigger word. Instead every category
// carries a built-in blacklist / whitelist (LORA_CATEGORY_CAPTION_RULES) that
// says which elements to lock into the trigger (never described) and which to
// peel off into the caption (always described).
//
// buildCaptionMetaPrompt() turns that into a system instruction for Gemini,
// which returns the final English instruction handed to the Modal worker's
// Qwen captioner as `caption_prompt`. buildCaptionFallbackPrompt() is the
// deterministic, no-LLM version used when Gemini is unavailable.
// buildCategoryDefaultInstruction() is the category-only policy used the
// moment the user has entered nothing at all.
//
// Pure module — safe to import from both client components and route handlers.

export const LORA_CAPTION_CATEGORIES = [
  "character",
  "outfit",
  "object",
  "background",
  "style",
] as const;
export type LoraCaptionCategory = (typeof LORA_CAPTION_CATEGORIES)[number];

// Legacy category ids from the previous 4-way split, mapped onto the new
// 5-way set so persisted form drafts / replayed job records keep working.
const LEGACY_CATEGORY_ALIAS: Record<string, LoraCaptionCategory> = {
  person: "character",
  character: "character",
  scene: "background",
  environment: "background",
  background: "background",
  object: "object",
  material: "object",
  outfit: "outfit",
  costume: "outfit",
  style: "style",
};

// --- caption FORMAT routing ------------------------------------------------
// Next-gen DiT backbones (Minimax H3, WAN 2.2, FLUX.2, Qwen-Image, LTX-2, …)
// carry an LLM/VLM text encoder that thrives on natural-language prose, while
// the SDXL family (Illustrious XL, Juggernaut XL, Pony, SD 1.5) uses a
// 77-token CLIP encoder that was trained on Danbooru-style comma tags.
// `resolveCaptionMode()` picks the right shape for the selected base model.
export type CaptionMode = "auto" | "dense" | "tags";
export type ResolvedCaptionMode = "dense" | "tags";

// modelKey fragments (matched case-insensitively) that force the CLIP / tag
// pipeline. Everything else is a next-gen DiT and gets dense prose.
const TAG_MODEL_HINTS = ["illustrious", "juggernaut", "sdxl", "sd15", "sd-1.5", "pony"] as const;

export function isCaptionMode(v: unknown): v is CaptionMode {
  return v === "auto" || v === "dense" || v === "tags";
}

// Resolve the effective caption format. A non-'auto' userMode always wins; on
// 'auto' the base model's key/label decides — a tag hint => 'tags', otherwise
// 'dense' (the safe default for the DiT-heavy lineup).
export function resolveCaptionMode(
  modelKey: string,
  userMode: CaptionMode = "auto",
): ResolvedCaptionMode {
  if (userMode === "dense" || userMode === "tags") return userMode;
  const hay = (modelKey || "").toLowerCase();
  return TAG_MODEL_HINTS.some((h) => hay.includes(h)) ? "tags" : "dense";
}

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
  character: {
    label: "人物・キャラクター",
    icon: "👤",
    typeLabelEn: "character / person LoRA",
    hint: "特定の人物・キャラクターを学習",
    fixedPlaceholder: "例: 顔立ち、青髪セミロング、赤い瞳、三日月の髪飾り、獣耳、固有の制服",
    varyingPlaceholder: "例: 表情、ポーズ、手の位置、カメラアングル（バストアップ/全身）、背景、照明",
  },
  outfit: {
    label: "衣装・コスチューム",
    icon: "👗",
    typeLabelEn: "outfit / costume LoRA",
    hint: "特定の衣装・コスチュームそのものを学習",
    fixedPlaceholder: "例: セーラー服の形、生地・素材、配色、リボン、ボタン、フリル、装飾パーツ",
    varyingPlaceholder: "例: 着用者の容姿・髪型、体型、ポーズ、表情、構図、背景、照明",
  },
  object: {
    label: "物体・アイテム",
    icon: "🗡️",
    typeLabelEn: "object / item LoRA",
    hint: "特定のモノ・プロダクト・アイテムを学習",
    fixedPlaceholder: "例: 本体の造形、構造、素材・質感、ロゴ、テクスチャ、配色",
    varyingPlaceholder: "例: 持っている手・人物、置かれている場所、周囲の背景、アングル、光の当たり方",
  },
  background: {
    label: "背景・風景",
    icon: "🏞️",
    typeLabelEn: "background / scenery LoRA",
    hint: "特定の場所・空間・風景を学習",
    fixedPlaceholder: "例: 建築物の構造、部屋のレイアウト、地形、恒久的な風景の配置、ランドマーク",
    varyingPlaceholder: "例: 写り込む人物、車などの動体、天候・時間帯・季節、カメラアングル",
  },
  style: {
    label: "画風・スタイル",
    icon: "🎨",
    typeLabelEn: "art-style LoRA",
    hint: "絵柄・タッチ・レンダリングだけを学習",
    fixedPlaceholder: "例: 筆致、線の質感、塗り方、色調、厚塗り、水彩のにじみ（＝画風そのもの）",
    varyingPlaceholder: "例: 描かれている人物・衣装・物体・ポーズ・背景・構図など全被写体",
  },
};

// --- per-category default policy -----------------------------------------
// When the user hasn't typed a fixed/varying spec, this is what a caption for
// each category MAY describe (`describe` — the varying elements, peeled off
// the trigger) and MUST NEVER mention (`forbid` — the identity elements,
// baked into the trigger). Written as concrete English so it can be dropped
// straight into the VLM instruction.
export type CategoryCaptionRule = {
  describe: string;
  forbid: string;
};

export const LORA_CATEGORY_CAPTION_RULES: Record<LoraCaptionCategory, CategoryCaptionRule> = {
  character: {
    describe:
      "the shot framing and camera angle (full body, upper body, bust shot, close-up, from above, from below, from the side), the pose and action (standing, sitting, walking, lying down, arms crossed, looking at viewer, looking away), the facial expression (neutral, smiling, laughing, surprised, crying, eyes closed), the background and location (plain white background, plain grey background, indoors, bedroom, classroom, outdoors, city street, forest), and the lighting (soft daylight, backlight, harsh shadow, warm indoor light)",
    forbid:
      "the face and facial features, the hairstyle, hair length and hair colour, the eye colour, the ear shape or any non-human ears, and any recurring hair ornament, accessory, headwear or signature-outfit detail that belongs to this character",
  },
  outfit: {
    describe:
      "the wearer's face and facial features, their hairstyle and hair colour, their body type and skin tone, the pose and gesture, the facial expression, the shot framing and camera angle, the background and location, and the lighting",
    forbid:
      "the garment itself — its silhouette and cut, its length, its fabric and material, its colour and colour scheme, its patterns, and every trim or fastening such as buttons, ribbons, frills, belts, zippers, collars and cuffs",
  },
  object: {
    describe:
      "the hand or person holding or using it, the surface or place it rests on and the surrounding environment, the viewing angle and distance, and the lighting and cast shadows",
    forbid:
      "the object's own shape and construction, its parts and proportions, its material and surface texture, its colour, and any logo, emblem, text or marking on it",
  },
  background: {
    describe:
      "any people in the frame, any vehicles or moving objects (cars, trains, boats, bicycles), the weather, season and time of day, and the camera position and angle",
    forbid:
      "the built structures and their architecture, the room layout and furniture arrangement, the terrain and landforms, and the fixed, permanent placement of any scenery element",
  },
  style: {
    describe:
      "every subject visible in the image in full concrete detail — the people and their appearance, their clothing and accessories, their pose and expression, the objects, the background and setting, and the overall composition and framing",
    forbid:
      "the drawing and rendering style itself — brushwork and stroke texture, line weight and line quality, shading and colouring technique, colour palette and colour grading, overall level of detail, and any medium or artist-style label",
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

// Accepts the new ids AND the legacy 4-way ids (person / scene / material),
// returning null only for genuine garbage. Use this wherever a value may come
// from an older persisted draft or a replayed job record.
export function coerceLoraCaptionCategory(v: unknown): LoraCaptionCategory | null {
  if (typeof v !== "string") return null;
  return LEGACY_CATEGORY_ALIAS[v.trim().toLowerCase()] ?? null;
}

// Coerces an arbitrary request/body value into a spec, or null when the
// category is missing/invalid. Empty fixed/varying are allowed here — use
// captionSpecHasInput() to decide whether it's worth acting on.
export function normalizeCaptionSpec(raw: unknown): LoraCaptionSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const category = coerceLoraCaptionCategory(r.category);
  if (!category) return null;
  const str = (v: unknown) =>
    (typeof v === "string" ? v : "").replace(/\s+$/g, "").trim().slice(0, CAPTION_SPEC_MAX_FIELD);
  return { category, fixed: str(r.fixed), varying: str(r.varying) };
}

export function captionSpecHasInput(spec: LoraCaptionSpec | null | undefined): boolean {
  return Boolean(spec && (spec.fixed.trim().length > 0 || spec.varying.trim().length > 0));
}

// The category-only policy: the instruction handed to the VLM when the user
// has typed NOTHING. It never says "describe the whole image" — the blacklist
// keeps the identity elements out of the caption so they stay welded to the
// trigger token.
export function buildCategoryDefaultInstruction(
  category: LoraCaptionCategory,
  triggerWord: string,
): string {
  const meta = LORA_CAPTION_CATEGORY_META[category];
  const rule = LORA_CATEGORY_CAPTION_RULES[category];
  const trigger = (triggerWord || "").trim() || "the subject";
  return [
    `No specific features were listed, so apply the default captioning policy for a ${meta.typeLabelEn}. The trigger word is "${trigger}".`,
    `Describe ONLY the following, and only when actually visible, in concrete and specific detail: ${rule.describe}.`,
    `NEVER mention the following, even when it is clearly visible — it defines "${trigger}" and is being baked into the trigger token: ${rule.forbid}.`,
  ].join("\n");
}

// The system instruction for Gemini. Gemini must return ONLY the English
// instruction block (no preamble) — that block is embedded verbatim into the
// worker's [User Instructions] slot before Qwen captions each image.
export function buildCaptionMetaPrompt(spec: LoraCaptionSpec, triggerWord: string): string {
  const meta = LORA_CAPTION_CATEGORY_META[spec.category];
  const rule = LORA_CATEGORY_CAPTION_RULES[spec.category];
  const trigger = (triggerWord || "").trim() || "the subject";
  return [
    "You are a senior dataset engineer who writes captioning instructions for LoRA fine-tuning.",
    `The user is training a ${meta.typeLabelEn}. The trigger word is "${trigger}".`,
    "",
    "The user describes, in Japanese, two groups of features:",
    `- FIXED / IDENTITY features (these ARE "${trigger}" and are being baked into the trigger token — they must be treated as a hard blacklist and NEVER written in any caption, even when clearly visible):`,
    `  ${spec.fixed.trim() || `(none specified — use the default blacklist for a ${meta.typeLabelEn}: ${rule.forbid})`}`,
    `- VARIABLE features (these change between images and MUST be described in detail so the model learns they are not part of "${trigger}"):`,
    `  ${spec.varying.trim() || `(none specified — describe only these: ${rule.describe})`}`,
    "",
    "Write a single English instruction block for the image-captioning VLM (Qwen). Requirements:",
    `1. Tell it to output ONE line of comma-separated English, starting with "${trigger}," and nothing before it.`,
    "2. Translate the user's Japanese feature lists into concrete English wording inside the instruction.",
    "3. State the blacklist explicitly: list the fixed/identity attributes and forbid mentioning them (hair colour, outfit, face shape, logo, layout, etc. — whatever is fixed for this category).",
    "4. Tell it to describe ONLY the variable features that are actually visible in each image, in specific detail.",
    "5. Forbid chain-of-thought, preamble, and meta commentary — the entire response must be the caption itself.",
    `6. Keep it tuned to a ${meta.typeLabelEn}: ${captionCategoryFocusHint(spec.category)}`,
    "",
    "Output ONLY the instruction block — no headings like 'Instruction:', no explanation, no markdown fences.",
  ].join("\n");
}

function captionCategoryFocusHint(category: LoraCaptionCategory): string {
  switch (category) {
    case "character":
      return "keep framing/composition/pose/expression/background separate from appearance, and never restate the character's face, hair, eyes, ears or signature accessories.";
    case "outfit":
      return "describe the wearer, their pose and the scene; the garment's own shape, fabric, colours and every button/ribbon/frill are fixed and must not be described.";
    case "object":
      return "describe who holds it, where it sits, the angle and the lighting; the object's own form, structure, material, colour and markings are fixed and must not be described.";
    case "background":
      return "describe transient people, vehicles, weather, season, time of day and camera angle; the permanent architecture, layout and terrain are fixed and must not be described.";
    case "style":
      return "describe every depicted subject in full detail; the artistic style/technique itself — linework, brushwork, shading, palette — is the fixed part and must not be described.";
  }
}

// Deterministic fallback used when Gemini is unavailable. The Modal worker's
// wrapper already tells Qwen the instruction "may be in Japanese or English",
// so we can hand the user's raw JP text straight through with an English
// blacklist frame around it.
export function buildCaptionFallbackPrompt(spec: LoraCaptionSpec, triggerWord: string): string {
  const meta = LORA_CAPTION_CATEGORY_META[spec.category];
  const rule = LORA_CATEGORY_CAPTION_RULES[spec.category];
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
      `NEVER mention the following, even when visible — it is being learned into "${trigger}": ${rule.forbid}`,
    );
  }
  if (spec.varying.trim()) {
    lines.push(`Describe ONLY these variable features, in detail, when visible: ${spec.varying.trim()}`);
  } else {
    lines.push(`Describe ONLY the following, in detail, when visible: ${rule.describe}`);
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
