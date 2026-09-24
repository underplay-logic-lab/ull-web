// LoRA キャプション解析（Gemini Vision）の指示文の組み立てと応答の整形。
// 2026-09-24 に src/app/api/studio/lora/caption/route.ts から移した（中身は無変更）。
// route と、モデル比較用のスクリプトが同じ指示文を使うため。純関数のみ。
import {
  matchLeadingSubjectTriggers,
  stripLeadingSubjectTriggers,
  type LoraSubject,
  type ResolvedCaptionMode,
} from "@/lib/loraCaptionSpec";

const NOISE_RE =
  /\b(?:masterpiece|best quality|high quality|ultra[- ]?detailed|highly detailed|extremely detailed|8k|4k|uhd|hdr|photorealistic|hyperrealistic|award[- ]?winning|stunning|beautiful|gorgeous|aesthetic|trending on artstation|sharp focus|bokeh quality)\b/gi;

// 2026-09-15: multiple distinct subjects (each with its own trigger word) in
// one dataset — e.g. two characters trained together. Only kicks in when the
// caller actually registered 2+ subjects; a single subject renders no block
// and every caller keeps the original single-trigger wording exactly.
function subjectClassificationLines(subjects: LoraSubject[]): string[] {
  if (subjects.length < 2) return [];
  return [
    "This dataset has MULTIPLE distinct subjects, each with its own trigger word. For each image, first decide which of the following it depicts — usually just one, but if TWO (or more) of these registered subjects appear TOGETHER in the same image (e.g. a couple/group shot), name ALL of them, not just one:",
    ...subjects.map((s) => `  - "${s.trigger}": ${s.description || "(no description given)"}`),
    "Start the caption with every matching subject's own trigger word — spelled exactly as above, one per subject actually present, each its own comma-separated tag, before anything else. Never substitute one subject's trigger for another, even if two sound similar. If genuinely unclear which subject it is, pick the closest match rather than omitting a trigger; never omit a trigger for a subject that IS visibly present just because two subjects are in frame.",
    // 腕や袖だけの写り込みで trigger が付く事故（2026-09-22、ホスト報告）。
    // クロップは duo 画像から片方を切り出すため、隣の人物の端が残りやすい。
    // 顔が見えない人物を数えると、その被写体は「首から下だけ」を学習し、
    // 比率も崩れる。顔を基準にする。
    // ⚠️ 「顔がはっきり見える人物だけ」と書いたら効きすぎた（2026-09-22）。
    // 横向き・後ろ向き・顔が小さい、といった理由で**実際に写っている被写体**が
    // 落とされ、duo 画像が片方だけのキャプションになった。本来の意図は
    // 「腕や袖だけの写り込みを除く」ことなので、除外の条件を身体の写り方で
    // 書き直す。顔の向きや見やすさは条件にしない。
    "IMPORTANT — a person counts as a subject when a meaningful part of their body is in frame: head plus torso, or a clearly recognisable figure. Name them even if they face away from the camera, are seen in profile, are partly overlapped by the other person, or their face is small or shadowed.",
    "Only IGNORE a person when they are a mere fragment at the edge of the frame — a hand, a forearm, a shoulder, or a strip of clothing or hair with no head and no torso. For such a fragment, do not output their trigger word, do not count them in the gender/count tag, and do not describe what they are wearing: it is background, not a subject.",
    "Every subject's own gender/age is FIXED — it never changes between images of the same subject. Once you judge a subject's Danbooru-style count/gender tag (e.g. 1girl vs 1woman, 1boy vs 1man) from their description, use that SAME tag every time that subject appears, even if a particular photo makes them look a little older or younger.",
  ];
}

function primaryTrigger(subjects: LoraSubject[]): string {
  return subjects[0]?.trigger.trim() ?? "";
}

// TAGS: compact Danbooru-style comma phrases for the 77-token CLIP encoder
// (Illustrious / Juggernaut / SDXL). This is the historical behaviour.
function buildTagsPrompt(count: number, subjects: LoraSubject[], captionPrompt: string): string {
  const instr = captionPrompt.trim();
  const trigger = primaryTrigger(subjects);
  const multi = subjects.length >= 2;
  const lines = [
    "You are an expert captioning engine that prepares training data for LoRA fine-tuning of image models.",
    `You are given ${count} image(s). Produce ONE caption per image.`,
    "",
    ...subjectClassificationLines(subjects),
    ...(multi ? [""] : []),
  ];
  if (instr) {
    // A category/spec instruction is present — it is AUTHORITATIVE. It carries
    // a "describe ONLY …" whitelist and a "NEVER mention …" blacklist; the
    // caption must not restate any blacklisted (trigger-bound) element.
    lines.push(
      "PRIMARY INSTRUCTIONS — authoritative, follow exactly:",
      instr.slice(0, 2000),
      "",
      "For each image, write compact comma-separated English phrases covering ONLY the elements the primary instructions allow (framing, pose, expression, background, lighting, and whatever else they whitelist). Obey the blacklist even when those features are clearly visible — never name them, never hint at them.",
      "",
      "Hard rules:",
      "- 20 to 45 words per caption. Facts only — no mood, story, intent, or opinion.",
      "- NEVER output quality/aesthetic words (masterpiece, best quality, ultra-detailed, 8k, beautiful, aesthetic, …).",
      "- NO markdown, NO quotes, NO numbering, NO line breaks inside a caption.",
      trigger
        ? `- Start every caption with "${multi ? "<the matching subject's trigger word(s)>" : trigger}, " followed immediately by a Danbooru-style subject-count/gender tag (e.g. "1girl", "1boy", "1man", "1woman", "solo", "2girls", "no humans") reflecting exactly how many people are in frame and their apparent gender. Include this even though it is not explicitly listed in the primary instructions' whitelist — it is scene-composition, not an identity/appearance detail, and Danbooru-tag-trained models expect it as the anchor tag.`
        : "- Do not invent a trigger token.",
      ...(trigger
        ? [
            "- A given trigger's gender/age tag (1girl vs 1woman, 1boy vs 1man) is a FIXED trait of that subject — decide it once and use the SAME one every time that trigger appears across this whole batch, regardless of how a particular photo makes them look.",
          ]
        : []),
    );
  } else {
    lines.push(
      "For each image, describe ONLY what is visually present, as compact comma-separated English phrases:",
      "- a Danbooru-style subject-count/gender tag first (e.g. \"1girl\", \"1boy\", \"1man\", \"1woman\", \"solo\", \"2girls\", \"no humans\"), reflecting exactly how many people are in frame and their apparent gender",
      "- the shot composition (e.g. \"upper body, looking at viewer\")",
      "- facial expression, then hairstyle and exact hair colour",
      "- clothing / outfit with colours and materials, and every accessory (hair ornament, ribbon, earrings, glasses, necklace, …)",
      "- pose / action, and the background / setting / lighting",
      "",
      "Hard rules:",
      "- 30 to 60 words per caption. Facts only — no mood, story, intent, or opinion.",
      "- NEVER output quality/aesthetic words (masterpiece, best quality, ultra-detailed, 8k, beautiful, aesthetic, …).",
      "- NO markdown, NO quotes, NO numbering, NO line breaks inside a caption.",
      trigger
        ? `- Start every caption with "${multi ? "<the matching subject's trigger word(s)>" : trigger}, " and nothing before it.`
        : "- Do not invent a trigger token.",
      ...(trigger
        ? [
            "- A given trigger's gender/age tag (1girl vs 1woman, 1boy vs 1man) is a FIXED trait of that subject — decide it once and use the SAME one every time that trigger appears across this whole batch, regardless of how a particular photo makes them look.",
          ]
        : []),
    );
  }
  lines.push(
    "",
    `Return a JSON array of exactly ${count} objects, in the same order as the images.`,
    'Each object is { "en": <the English caption>, "ja": <the SAME caption in natural Japanese, keeping the comma-separated structure; no romaji, no notes> }.',
    "Output only the JSON array.",
  );
  return lines.join("\n");
}

// DENSE: a natural-language English paragraph for the LLM/VLM text encoders of
// the next-gen DiT lineup (Minimax H3, WAN 2.2, FLUX.2, Qwen-Image, LTX-2, …).
function buildDensePrompt(count: number, subjects: LoraSubject[], captionPrompt: string): string {
  const instr = captionPrompt.trim();
  const trigger = primaryTrigger(subjects);
  const multi = subjects.length >= 2;
  const triggerPlaceholder = multi ? "<the matching subject's trigger word>" : trigger;
  const lines = [
    "You are an expert captioning engine that prepares training data for LoRA fine-tuning of modern diffusion transformers with LLM/VLM text encoders.",
    `You are given ${count} image(s). Produce ONE caption per image.`,
    "",
    ...subjectClassificationLines(subjects),
    ...(multi ? [""] : []),
  ];
  if (instr) {
    // A category/spec instruction is present — it is AUTHORITATIVE. It carries
    // a "describe ONLY …" whitelist and a "NEVER mention …" blacklist; the
    // paragraph must NOT describe any blacklisted (trigger-bound) element,
    // even though a dense caption would normally cover appearance.
    lines.push(
      "PRIMARY INSTRUCTIONS — authoritative, follow exactly:",
      instr.slice(0, 2000),
      "",
      `For each image, write a natural English paragraph (70 to 130 words) that describes — in concrete, specific detail — ONLY the elements the primary instructions allow. Obey the blacklist even when those features are clearly visible: do not describe them, do not allude to them, do not use them to identify the subject.`,
      trigger
        ? `Start the paragraph with "${triggerPlaceholder}" as the subject (e.g. "${triggerPlaceholder} is shown ...", "${triggerPlaceholder} stands ...") and nothing before it.`
        : "Do not invent a trigger token.",
      "",
      "Hard rules:",
      "- Flowing prose sentences (NOT a comma-separated tag list).",
      "- Facts only — describe what is visually present, not mood, story, or intent.",
      "- Do NOT use quality buzzwords (masterpiece, best quality, ultra-detailed, 8k, uhd, hdr, beautiful, aesthetic, …).",
      "- Output pure text: NO markdown, NO code fences, NO quotes, NO numbering, NO line breaks inside a caption.",
    );
  } else {
    lines.push(
      "For each image, write a highly detailed, natural English paragraph (100 to 150 words) describing the image. Describe character identity traits, precise clothing, accessories, pose, expression, lighting, and comprehensive background details.",
      trigger
        ? `Start the paragraph with "${triggerPlaceholder}" as the subject (e.g. "${triggerPlaceholder} is a ...") and nothing before it.`
        : "Do not invent a trigger token.",
      "",
      "Hard rules:",
      "- 100 to 150 words per caption, written as flowing prose sentences (NOT a comma-separated tag list).",
      "- Facts only — describe what is visually present, not mood, story, or intent.",
      "- Do NOT use quality buzzwords (masterpiece, best quality, ultra-detailed, 8k, uhd, hdr, beautiful, aesthetic, …).",
      "- Output pure text: NO markdown, NO code fences, NO quotes, NO numbering, NO line breaks inside a caption.",
    );
  }
  lines.push(
    "",
    `Return a JSON array of exactly ${count} objects, in the same order as the images.`,
    'Each object is { "en": <the English paragraph>, "ja": <the SAME description in natural Japanese prose; no romaji, no notes> }.',
    "Output only the JSON array.",
  );
  return lines.join("\n");
}

export function buildVisionPrompt(
  count: number,
  subjects: LoraSubject[],
  captionPrompt: string,
  mode: ResolvedCaptionMode,
): string {
  return mode === "dense"
    ? buildDensePrompt(count, subjects, captionPrompt)
    : buildTagsPrompt(count, subjects, captionPrompt);
}

export function tidyCaption(raw: string, subjects: LoraSubject[], mode: ResolvedCaptionMode = "tags"): string {
  const dense = mode === "dense";
  // Strip code fences + markdown glyphs and drop the quality-noise vocabulary
  // in BOTH modes. Line breaks become a space in dense (keep the sentence
  // flow) and a comma in tags (keep the phrase list).
  let out = (raw ?? "")
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/i, "")
    .replace(/\s*\n+\s*/g, dense ? " " : ", ")
    .replace(/[*_#>`]+/g, "")
    .replace(NOISE_RE, "");
  if (dense) {
    // Prose: preserve "." sentence structure — only normalise whitespace and
    // punctuation spacing, and heal the gaps a noise-word removal can leave.
    out = out
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/([,;:])(?=[^\s])/g, "$1 ")
      .replace(/([.!?])(?=[A-Za-z])/g, "$1 ")
      .replace(/(?:,\s*){2,}/g, ", ")
      .replace(/(?:^[,\s]+)|(?:[,\s]+$)/g, "")
      .trim();
  } else {
    out = out
      .replace(/\s*,\s*/g, ", ")
      .replace(/,\s*,/g, ",")
      .replace(/(?:^[,\s]+)|(?:[,\s]+$)/g, "")
      .trim();
  }
  const primary = subjects[0]?.trigger.trim() ?? "";
  if (subjects.length >= 2) {
    // Multi-subject: keep every trigger the model actually named at the front
    // (a group/couple shot can legitimately name 2+), re-serialised in the
    // registered subjects' own order for consistency across the dataset. Only
    // fall back to the primary subject if it ignored the instruction and
    // named none of them — a wrong-but-present trigger beats no trigger.
    const present = matchLeadingSubjectTriggers(out, subjects);
    const triggerBlock = present.length ? present.map((s) => s.trigger).join(", ") : primary;
    const body = stripLeadingSubjectTriggers(out, subjects);
    out = triggerBlock ? `${triggerBlock}, ${body}` : body;
  } else if (primary) {
    const re = new RegExp(`^\\s*${primary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,?\\s*`, "i");
    out = out.replace(re, "");
    out = out ? `${primary}, ${out}` : primary;
  }
  return out;
}

// Tolerant parse of the model's `[{ en, ja }, …]` response. Accepts a bare
// string entry (older/degraded output) as an en-only caption.
export function parseEnJaArray(raw: string, count: number): { en: string; ja: string }[] | null {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    const m = raw.match(/\[[\s\S]*\]/);
    try {
      arr = m ? JSON.parse(m[0]) : null;
    } catch {
      arr = null;
    }
  }
  if (!Array.isArray(arr)) return null;
  return Array.from({ length: count }, (_, i) => {
    const it = arr[i];
    if (typeof it === "string") return { en: it, ja: "" };
    if (it && typeof it === "object") {
      const o = it as Record<string, unknown>;
      return {
        en: typeof o.en === "string" ? o.en : typeof o.caption === "string" ? o.caption : "",
        ja: typeof o.ja === "string" ? o.ja : "",
      };
    }
    return { en: "", ja: "" };
  });
}

