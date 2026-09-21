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

// テンプレートリテラル内で改行を挟むためだけの定数（ソース上の見た目を壊さない）。
const NEWLINE = String.fromCharCode(10);

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
//
// 🚨 2026-09-21 修正（ホスト指摘で発覚）: 以前は `spec.fixed` に何か入力が
// あるとカテゴリ既定の forbid / describe を **丸ごと置き換えて**いた。
// つまり「髪飾りも固定したい」と1語足しただけで、顔・髪・目の色が
// ブラックリストから外れて VLM が描写し始め、キャラの identity が
// トリガーから剥がれる——**情報を足すほど結果が悪くなる**挙動だった。
// 利用者が気づける類の副作用ではないので、既定は常に効かせたうえで
// ユーザーの入力を **追記** する形に変えた。
// 「既定を無効にして自分の指定だけで焼きたい」需要が出たら、それは
// 明示的なトグルとして足すこと（暗黙の置き換えに戻さない）。
export function buildCaptionMetaPrompt(spec: LoraCaptionSpec, triggerWord: string): string {
  const meta = LORA_CAPTION_CATEGORY_META[spec.category];
  const rule = LORA_CATEGORY_CAPTION_RULES[spec.category];
  const trigger = (triggerWord || "").trim() || "the subject";
  return [
    "You are a senior dataset engineer who writes captioning instructions for LoRA fine-tuning.",
    `The user is training a ${meta.typeLabelEn}. The trigger word is "${trigger}".`,
    "",
    // 2026-09-21（宣言方式へ移行）: `fixed` は「画像から抽出 → ユーザーが
    // 取捨選択して確定したリスト」になった。空欄から書かせていた頃と違い
    // 書き漏らしが起きにくいので、**既定の forbid を置き換える**のが正しい。
    //
    // これで「全画像で眼鏡をかけているが眼鏡は学習したくない」が、リストから
    // 外すだけで表現できる（以前は既定の forbid に眼鏡が含まれてしまい、
    // 変化させたい側に書いても指示が矛盾していた）。
    // リストが空のときだけカテゴリ既定にフォールバックする。
    "The user has confirmed exactly which features define this subject:",
    `- FIXED / IDENTITY features (these ARE "${trigger}" and are being baked into the trigger token — treat this as the COMPLETE blacklist and NEVER write any of them in a caption, even when clearly visible):`,
    `  ${spec.fixed.trim() || rule.forbid}`,
    spec.fixed.trim()
      ? "  This list is exhaustive. Anything NOT on it — including the face, hairstyle, hair colour and eye colour — is a normal visible detail and SHOULD be described when visible."
      : "",
    `- VARIABLE features (these change between images and MUST be described in detail so the model learns they are not part of "${trigger}"):`,
    `  ${rule.describe}${spec.varying.trim() ? `${NEWLINE}  ADDITIONALLY, the user specifically listed: ${spec.varying.trim()}` : ""}`,
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

// --- multi-subject trigger words (2026-09-15) ------------------------------
// A single LoRA can teach several distinct subjects at once (e.g. two
// characters that appear separately across a dataset) — each needs its own
// trigger token. `subjects.length <= 1` is the original single-trigger
// behaviour everywhere (no classification, no UI change); `>= 2` activates
// the auto-vision classification path in /api/studio/lora/caption and the
// curation screen's per-card badge.
export type LoraSubject = {
  trigger: string;
  /** Short EN/JA description used to tell subjects apart in the vision prompt
   * (and shown to the user) — e.g. "silver-haired girl", "man in a black coat". */
  description: string;
  /**
   * Comma-separated tags FORCED into every solo-shot caption of this subject
   * (e.g. "1woman, solo, female" — 4 leading tokens with the trigger,
   * matching a kohya-ss/sd-scripts `keep_tokens=4` setup) — 2026-09-15, host
   * report: asking the vision model
   * to freely judge the Danbooru count/gender tag per image drifts across a
   * larger dataset (1girl vs 1woman for the same person) and sometimes omits
   * it outright (8 images missing "solo" in one real run). A per-subject
   * gender/count tag is a FIXED trait, not something that should be
   * re-judged per image — so when set, it's spliced in deterministically
   * (applySubjectFixedTags/normalizeSubjectTags), completely bypassing the
   * model's own guess. Left empty, the model's guess + majority-vote
   * normalization is used as before (legacy behaviour, unchanged).
   */
  fixedTags?: string;
  /**
   * この被写体の **identity タグ**（Danbooru 形式、カンマ区切り。例:
   * "bald, fat, glasses"）。2026-09-21 追加。
   *
   * キャプションに書く内容とちょうど **逆** の役割を持つ:
   *   - キャプション: identity は書かない（＝トリガーへ焼き込む）
   *   - LoRA の metadata: identity を **埋め込む**
   * ホストの ComfyUI 側に「LoRA を読み込んだら metadata のタグを
   * プロンプトへ自動追加する」機能があり、生成時にこれが戻ることで
   * 再現性が上がる、という運用。
   *
   * fixedTags（"1man, solo, male" のような数・性別タグ）とは別物。
   * あちらは全キャプションの先頭へ強制挿入されるが、こちらは
   * **キャプションには一切入らず metadata にだけ入る**。
   */
  identityTags?: string;
  /**
   * identityTags と同じ並びの日本語表示（カンマ区切り、2026-09-21）。
   * ユーザーが読むのは日本語、モデルへ渡すのは英タグ、という二層にするため。
   * 英側が正で、こちらは表示専用（欠けていれば英をそのまま出す）。
   */
  identityTagsJa?: string;
};

function escapeReSub(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds which of `subjects` the caption's LEADING token matches (exact, or a
 * short transliteration Gemini sometimes adds on a JA round-trip, e.g.
 * "yukipas" -> "yukipasu"). Returns the matching trigger string, or null if
 * the caption doesn't start with any of them (Gemini ignored the
 * classification instruction — the curation UI flags this for manual fix).
 */
export function matchLeadingSubjectTrigger(caption: string, subjects: LoraSubject[]): string | null {
  const firstToken = caption.trim().split(/\s*[,、]\s*/)[0]?.trim().toLowerCase() ?? "";
  if (!firstToken) return null;
  for (const s of subjects) {
    const t = s.trigger.trim().toLowerCase();
    if (!t) continue;
    if (firstToken === t || (firstToken.startsWith(t) && firstToken.length - t.length <= 2)) {
      return s.trigger.trim();
    }
  }
  return null;
}

/** Strips a leading `trigger,` (any of `subjects`) off `caption`, if present. */
export function stripLeadingSubjectTrigger(caption: string, subjects: LoraSubject[]): string {
  const matched = matchLeadingSubjectTrigger(caption, subjects);
  if (!matched) return caption.trim();
  const re = new RegExp(`^\\s*${escapeReSub(matched)}\\s*[,、]?\\s*`, "i");
  return caption.replace(re, "").trim();
}

function isSubjectToken(token: string, subject: LoraSubject): boolean {
  const t = token.trim().toLowerCase();
  const s = subject.trigger.trim().toLowerCase();
  if (!t || !s) return false;
  return t === s || (t.startsWith(s) && t.length - s.length <= 2);
}

/**
 * Two+ registered subjects can appear TOGETHER in one image (a couple/group
 * shot) — a single "which ONE subject" match silently drops everyone but the
 * first. Walks the caption's leading comma-separated tokens and collects
 * every one that matches a DIFFERENT registered subject, stopping at the
 * first token that matches none (that's the start of the actual caption
 * body). Returns them in `subjects`' own order (a stable, canonical order
 * regardless of what order the model happened to output them in).
 */
export function matchLeadingSubjectTriggers(caption: string, subjects: LoraSubject[]): LoraSubject[] {
  const tokens = caption.trim().split(/\s*[,、]\s*/);
  const present = new Set<string>();
  for (const tok of tokens) {
    if (!tok.trim()) break;
    const hit = subjects.find((s) => s.trigger.trim() && isSubjectToken(tok, s) && !present.has(s.trigger));
    if (!hit) break;
    present.add(hit.trigger);
  }
  return subjects.filter((s) => present.has(s.trigger));
}

/** Strips ALL leading subject triggers (see matchLeadingSubjectTriggers) off `caption`. */
export function stripLeadingSubjectTriggers(caption: string, subjects: LoraSubject[]): string {
  const tokens = caption.trim().split(/\s*[,、]\s*/);
  const present = new Set<string>();
  let i = 0;
  for (; i < tokens.length; i++) {
    if (!tokens[i].trim()) break;
    const hit = subjects.find((s) => s.trigger.trim() && isSubjectToken(tokens[i], s) && !present.has(s.trigger));
    if (!hit) break;
    present.add(hit.trigger);
  }
  return tokens
    .slice(i)
    .join(", ")
    .trim();
}

// Broad match for ANY Danbooru count/gender/solo-ish tag the model may have
// written on its own, OR that a previous applySubjectFixedTags() pass already
// spliced in (female/male) — used to STRIP a run of these right after a
// subject's trigger before splicing in that subject's fixedTags, so re-running
// this on an already-fixed caption is idempotent instead of duplicating
// ("1woman, solo, female, female, ...").
const COUNT_GENDER_TAG_RE =
  /^(?:\d+\s*(?:girls?|boys?|man|men|woman|women)|solo|female|male|no\s*humans?|multiple\s*(?:girls?|boys?|people|views))$/i;
// Narrower match used by the majority-vote fallback (only the 4 tags that
// can legitimately drift for the SAME person across images — "solo" and the
// count tags for 2+ people aren't a per-subject identity trait, so they're
// left to the model).
const GENDER_AGE_TAG_RE = /^(1girl|1boy|1man|1woman)$/i;

/**
 * Forces fixedTags into `caption`, for BOTH solo shots and group/duo shots
 * where every present registered subject has fixedTags configured:
 *   - SOLO (1 subject present): splices that subject's full fixedTags
 *     verbatim (e.g. "1woman, solo, female") — unchanged from the original
 *     design.
 *   - GROUP (2+ subjects present, e.g. a duo photo): "solo" obviously
 *     doesn't apply, and there's no single subject to attribute one fixed
 *     tag set to — but each present subject's own count/gender word (the
 *     FIRST token of their fixedTags, e.g. "1woman" out of "1woman, solo,
 *     female") CAN be deterministically attributed, since
 *     matchLeadingSubjectTriggers already identified exactly which
 *     registered subjects are in the leading trigger run (2026-09-15, host
 *     report: a duo photo of "hitozuma" (configured 1woman) and "kocho"
 *     (configured 1man) still came out as "hitozuma, kocho, 1girl, 1man, …"
 *     — the model's own free guess for hitozuma, never corrected, because
 *     group shots were previously left entirely untouched). Only fires when
 *     ALL present subjects have fixedTags — a mix of fixed/unfixed subjects
 *     has no reliable per-person attribution, so it's left as the model
 *     wrote it (matching the pre-2026-09-15 behaviour for that case).
 * A no-op when the caption matches no registered subject, or (group case)
 * when at least one present subject has no fixedTags configured.
 */
export function applySubjectFixedTags(caption: string, subjects: LoraSubject[]): string {
  const present = matchLeadingSubjectTriggers(caption, subjects);
  if (present.length === 0) return caption;
  if (!present.every((s) => s.fixedTags?.trim())) return caption;

  const tokens = caption.trim().split(/\s*[,、]\s*/);
  let i = present.length; // tokens[0..present.length-1] are the matched triggers
  while (i < tokens.length && COUNT_GENDER_TAG_RE.test(tokens[i]?.trim() ?? "")) i++;
  const rest = tokens.slice(i).join(", ").trim();

  const triggerBlock = present.map((s) => s.trigger).join(", ");
  const tagBlock =
    present.length === 1
      ? present[0].fixedTags!.trim()
      : present.map((s) => s.fixedTags!.trim().split(/\s*,\s*/)[0]).join(", ");

  return rest ? `${triggerBlock}, ${tagBlock}, ${rest}` : `${triggerBlock}, ${tagBlock}`;
}

/**
 * Post-hoc consistency pass over a whole batch of already-generated captions
 * (2026-09-15, host report: the same recurring character tagged 1girl in
 * some photos and 1woman in others; separately, some images missing any
 * count/gender tag at all; separately again, a duo/group photo of two
 * registered subjects still had the model's own free-guessed gender tags —
 * asking the vision model to freely (re-)judge this per image, across
 * independent API calls with no shared memory, isn't reliable enough on its
 * own). For each entry with 1+ registered subjects present:
 *   - if EVERY present subject has fixedTags configured, FORCE them
 *     (deterministic, same as applySubjectFixedTags — works for solo AND
 *     group/duo shots now, since matchLeadingSubjectTriggers already
 *     resolves exactly which subjects are in the leading trigger run);
 *   - otherwise, for a SOLO shot (exactly one subject, no fixedTags), fall
 *     back to majority-vote among that subject's OTHER AI-guessed
 *     1girl/1boy/1man/1woman tags (legacy best-effort behaviour for
 *     subjects nobody bothered to pin down explicitly);
 *   - a group/duo shot where at least one present subject has NO fixedTags
 *     is left untouched — there's no reliable way to attribute a tag to an
 *     unconfigured subject.
 *
 * Returns a Map of id -> corrected caption, containing ONLY the entries that
 * actually need to change — callers apply it as a sparse patch (both
 * LoraStudioTab.tsx's live `captions` state and DatasetCurationUI.tsx's
 * `CurationPair[]` reuse this one implementation).
 */
export function normalizeSubjectTags(
  entries: { id: string; caption: string }[],
  subjects: LoraSubject[],
): Map<string, string> {
  const fixes = new Map<string, string>();
  const counts = new Map<string, Map<string, number>>(); // trigger -> tag -> count
  const soloForVote = new Map<string, { trigger: string; tokens: string[] }>(); // id -> parsed

  for (const { id, caption } of entries) {
    if (!caption.trim()) continue;
    const present = matchLeadingSubjectTriggers(caption, subjects);
    if (present.length === 0) continue;

    if (present.every((s) => s.fixedTags?.trim())) {
      const fixed = applySubjectFixedTags(caption, subjects);
      if (fixed !== caption.trim()) fixes.set(id, fixed);
      continue;
    }
    if (present.length !== 1) continue; // group shot, not fully fixed-tagged — leave as-is
    const subject = present[0];

    const tokens = caption.trim().split(/\s*[,、]\s*/);
    const tag = tokens[1]?.trim();
    if (!tag || !GENDER_AGE_TAG_RE.test(tag)) continue;
    soloForVote.set(id, { trigger: subject.trigger, tokens });
    const m = counts.get(subject.trigger) ?? new Map<string, number>();
    const key = tag.toLowerCase();
    m.set(key, (m.get(key) ?? 0) + 1);
    counts.set(subject.trigger, m);
  }

  const majority = new Map<string, string>(); // trigger -> canonical tag
  for (const [trigger, tagCounts] of counts) {
    let bestKey = "";
    let bestN = -1;
    for (const [key, n] of tagCounts) {
      if (n > bestN) {
        bestN = n;
        bestKey = key;
      }
    }
    majority.set(trigger, bestKey);
  }
  for (const [id, info] of soloForVote) {
    const want = majority.get(info.trigger);
    if (!want || info.tokens[1]?.trim().toLowerCase() === want) continue;
    const tokens = [...info.tokens];
    tokens[1] = want;
    fixes.set(id, tokens.join(", "));
  }
  return fixes;
}


// ---------------------------------------------------------------------------
// LoRA の metadata へ埋め込むタグ（2026-09-21 追加）
//
// modal_sdxl_lora_worker.py の _parse_embed_tags が読む "tag:freq,tag,..."
// 形式の文字列を、登録済みの被写体情報から機械的に組み立てる。以前は
// ユーザーが手で書く欄しか無く、書式（頻度値の意味）も伝わっていなかった。
//
// 中身は「この LoRA を正しく呼び出すためのトークン」:
//   trigger + fixedTags（1man, solo, male）+ identityTags（bald, fat, glasses）
// ＝ **キャプションから意図的に除外したもの**。生成時にプロンプトへ戻すと
// 再現性が上がる、という対称性で使う。
// ---------------------------------------------------------------------------

/** 手入力の embed_tags と同じ既定頻度（fix_lora_metadata_gui.py 由来のダミー値）。 */
export const EMBED_TAG_DEFAULT_FREQ = 21;

function splitTags(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/\s*[,、]\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 被写体レジストリから embed_tags 文字列を組み立てる。重複は先勝ちで除去し、
 * 順序は「被写体ごとに trigger → 数/性別 → identity」。空なら "" を返す
 * （呼び出し側は空なら送らない＝ワーカー側で metadata 書き換えごとスキップ）。
 */
export function buildEmbedTagsFromSubjects(subjects: LoraSubject[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const key = t.toLowerCase();
    if (!t || seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  for (const s of subjects) {
    push(s.trigger.trim());
    for (const t of splitTags(s.fixedTags)) push(t);
    for (const t of splitTags(s.identityTags)) push(t);
  }
  return out.join(", ");
}

/**
 * キャプション先頭の「固定ブロック」のトークン数 = sd-scripts の keep_tokens。
 * shuffle_caption はこの数だけ先頭を固定してから後ろを混ぜるので、ここが
 * ズレると trigger や性別タグが本文に紛れ込む。
 *
 * applySubjectFixedTags がその固定ブロックを組み立てているので、値は
 * 入力させるのではなく **キャプションから数えられる**:
 *   solo  "kocho, 1man, solo, male, ..."          -> 4
 *   duo   "hitozuma, kocho, 1woman, 1man, ..."    -> 4
 *   trio  "A, B, C, 1girl, 1boy, 1man, ..."       -> 6
 * 被写体が1人も一致しないキャプション（未解析など）は fallback を返す。
 */
export function keepTokensForCaption(
  caption: string,
  subjects: LoraSubject[],
  fallback = 4,
): number {
  const present = matchLeadingSubjectTriggers(caption, subjects);
  if (present.length === 0) return fallback;
  const tokens = caption.trim().split(/\s*[,、]\s*/);
  let i = present.length; // 先頭は一致した trigger 群
  while (i < tokens.length && COUNT_GENDER_TAG_RE.test(tokens[i]?.trim() ?? "")) i++;
  return Math.max(1, i);
}
