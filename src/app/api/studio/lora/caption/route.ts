import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  geminiApiKey,
  geminiErrorResponse,
  geminiNotConfiguredResponse,
  isGemErr,
  runGeminiVision,
} from "@/lib/geminiText";
import {
  applySubjectFixedTags,
  buildCategoryDefaultInstruction,
  coerceLoraCaptionCategory,
  matchLeadingSubjectTriggers,
  stripLeadingSubjectTriggers,
  type LoraSubject,
  type ResolvedCaptionMode,
} from "@/lib/loraCaptionSpec";
import {
  CONTENT_POLICY_BLOCK_MESSAGE,
  evaluateContentPolicyMany,
  logContentPolicyBlock,
} from "@/lib/contentPolicy";

// Fast AI-vision auto-captioning for the LoRA Studio dataset.
//
// The browser downscales each training image to a small JPEG and POSTs a
// batch here (see src/lib/loraCaption.ts). ONE Gemini multimodal call
// captions the whole batch AND emits the Japanese working copy in the same
// response (structured { en, ja } objects) — no second translation round
// trip. The client fires 3-4 of these batches concurrently.
//
//   { images: [{ data(b64), mimeType }], trigger_word?, caption_prompt?,
//     caption_mode?: "dense" | "tags",
//     category?: "character"|"outfit"|"object"|"background"|"style" }
//     -> { captions: string[], captionsJa: string[] }   (aligned to images)
//
// `category` (with no `caption_prompt`) selects that training type's built-in
// blacklist/whitelist policy — see buildCategoryDefaultInstruction() — so an
// empty feature form still produces trigger-safe captions instead of a full
// indiscriminate description.
//
// caption_mode routes the prompt + sanitiser: "tags" (default) = compact
// comma-separated phrases for CLIP-encoder SDXL models; "dense" = a 100-150
// word natural-language paragraph for the LLM/VLM text encoders of the
// next-gen DiT lineup. The client picks it from the base model — see
// resolveCaptionMode() in src/lib/loraCaptionSpec.ts.
//
// The Modal worker's local VLM stays as a fallback for images this can't
// caption (quota / safety refusal) — the client sends the partial list and
// the worker fills the gaps.
export const maxDuration = 120;

// Gemini "empty response" reasons that mean the safety filter refused the
// content (a real NSFW/policy block) — distinct from a 429 rate limit. The
// client isolates these to a single image and hands only those to the VLM.
const SAFETY_REASON_RE = /safe|block|prohibited|recitation|spii|sexual|harm/i;

const MAX_IMAGES = 16;
// base64 is ~4/3 of the binary size — a 768px JPEG is well under this. The
// total stays under Vercel's ~4.5 MB request-body cap with JSON overhead.
const MAX_IMG_B64 = 600_000;
const MAX_TOTAL_B64 = 4_000_000;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

const ERR_MESSAGES = {
  tag: "studio/lora/caption",
  quota: "AI 解析が混み合っています。少し時間をおいて再試行してください（このまま学習すると、キャプションは学習側で自動補完されます）。",
  busy: "AI 解析が一時的に混雑しています。少し待って再試行してください。",
  failed: "画像の自動解析に失敗しました。",
} as const;

// Danbooru-ish quality/aesthetic noise the LoRA-training community explicitly
// does NOT want baked into captions — stripped from every result.
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

function buildVisionPrompt(
  count: number,
  subjects: LoraSubject[],
  captionPrompt: string,
  mode: ResolvedCaptionMode,
): string {
  return mode === "dense"
    ? buildDensePrompt(count, subjects, captionPrompt)
    : buildTagsPrompt(count, subjects, captionPrompt);
}

function tidyCaption(raw: string, subjects: LoraSubject[], mode: ResolvedCaptionMode = "tags"): string {
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
function parseEnJaArray(raw: string, count: number): { en: string; ja: string }[] | null {
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

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const authHeader = request.headers.get("authorization");
    const accessToken = authHeader?.replace(/^Bearer\s+/i, "");
    if (!accessToken) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
    }
    const supabase = createClient(supabaseUrl, anonKey);
    const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const rawImages = Array.isArray(body?.images) ? body.images : null;
    if (!rawImages || rawImages.length === 0) {
      return NextResponse.json({ error: "画像が指定されていません。" }, { status: 400 });
    }
    if (rawImages.length > MAX_IMAGES) {
      return NextResponse.json(
        { error: `一度に解析できるのは ${MAX_IMAGES} 枚までです。` },
        { status: 400 },
      );
    }

    const images: { mimeType: string; data: string }[] = [];
    let totalB64 = 0;
    for (const it of rawImages) {
      const data = typeof it?.data === "string" ? it.data.replace(/^data:[^,]+,/, "") : "";
      const mimeType = typeof it?.mimeType === "string" ? it.mimeType : "image/jpeg";
      if (!data || !ALLOWED_MIME.has(mimeType) || data.length > MAX_IMG_B64) {
        return NextResponse.json({ error: "画像データが不正、または大きすぎます。" }, { status: 400 });
      }
      totalB64 += data.length;
      images.push({ mimeType, data });
    }
    if (totalB64 > MAX_TOTAL_B64) {
      return NextResponse.json({ error: "画像の合計サイズが大きすぎます。枚数を減らしてください。" }, { status: 400 });
    }

    const triggerWord =
      typeof body?.trigger_word === "string" ? body.trigger_word.trim().slice(0, 60) : "";
    // Multiple distinct subjects (2026-09-15) — each with its own trigger word
    // and a short description used to tell them apart in the vision prompt.
    // Falls back to the single legacy `trigger_word` when absent/too short, so
    // every existing caller (and the single-subject case, the overwhelming
    // majority) is completely unaffected.
    const rawSubjects = Array.isArray(body?.subjects) ? body.subjects : [];
    const parsedSubjects: LoraSubject[] = rawSubjects
      .map((s: unknown) => {
        const o = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
        return {
          trigger: typeof o.trigger === "string" ? o.trigger.trim().slice(0, 60) : "",
          description: typeof o.description === "string" ? o.description.trim().slice(0, 300) : "",
          fixedTags: typeof o.fixedTags === "string" ? o.fixedTags.trim().slice(0, 200) : "",
        };
      })
      .filter((s: LoraSubject) => s.trigger.length > 0)
      .slice(0, 8);
    // A single entry (not just 2+) is still meaningful — it may carry
    // fixedTags for the one default subject — so it's never discarded here.
    // subjectClassificationLines()/tidyCaption() key the actual
    // "multi-subject classification" behaviour off subjects.length >= 2, not
    // off whether this array happened to come from the client at all.
    const subjects: LoraSubject[] =
      parsedSubjects.length >= 1 ? parsedSubjects : [{ trigger: triggerWord, description: "", fixedTags: "" }];
    // Explicit instruction wins (manual override or the client's synthesised
    // category+spec prompt). If none was sent but a training CATEGORY was,
    // fall back to that category's built-in blacklist/whitelist policy — never
    // to "describe the whole image", which would hollow out the trigger word.
    const category = coerceLoraCaptionCategory(body?.category ?? body?.learning_type);
    let captionPrompt =
      typeof body?.caption_prompt === "string" ? body.caption_prompt.slice(0, 4000) : "";
    if (!captionPrompt.trim() && category) {
      captionPrompt = buildCategoryDefaultInstruction(category, triggerWord);
    }

    const policyResult = evaluateContentPolicyMany([
      triggerWord,
      captionPrompt,
      ...subjects.flatMap((s) => [s.trigger, s.description, s.fixedTags ?? ""]),
    ]);
    if (policyResult.blocked) {
      logContentPolicyBlock("lora/caption", policyResult, userData.user.id);
      return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
    }
    // Caption FORMAT. The client resolves this from the selected base model
    // (resolveCaptionMode); default 'tags' preserves the legacy behaviour for
    // any caller that doesn't send it.
    const captionMode: ResolvedCaptionMode = body?.caption_mode === "dense" ? "dense" : "tags";

    const apiKey = geminiApiKey();
    if (!apiKey) return geminiNotConfiguredResponse();
    const genAI = new GoogleGenerativeAI(apiKey);

    // --- single multimodal pass: English caption + Japanese copy ----------
    // One call per batch returns [{ en, ja }, …] — no separate translation
    // round trip. The client fires several of these concurrently.
    let raw: string;
    try {
      raw = await runGeminiVision(
        genAI,
        buildVisionPrompt(images.length, subjects, captionPrompt, captionMode),
        images,
        "enja",
        { feature: "lora_caption", userId: userData.user.id },
      );
    } catch (e) {
      // Safety-filter refusal → 200 with empty captions + safety:true so the
      // client can pin it to one image and route it to the VLM (NOT retry it
      // as a rate limit). Everything else keeps its 429 / 503 / 502 status so
      // the client's exponential backoff kicks in.
      if (isGemErr(e) && e.kind === "failed" && SAFETY_REASON_RE.test(e.message)) {
        return NextResponse.json(
          {
            captions: images.map(() => ""),
            captionsJa: images.map(() => ""),
            safety: true,
            reason: e.message.slice(0, 200),
          },
          { status: 200 },
        );
      }
      return geminiErrorResponse(e, ERR_MESSAGES);
    }
    const parsed = parseEnJaArray(raw, images.length);
    if (!parsed) {
      return NextResponse.json(
        { error: "解析結果を解釈できませんでした。", reason: raw.slice(0, 300) },
        { status: 502 },
      );
    }
    const captions = parsed.map((p) => applySubjectFixedTags(tidyCaption(p.en, subjects, captionMode), subjects));
    const captionsJa = parsed.map((p, i) =>
      captions[i].trim()
        ? (p.ja ?? "").trim().replace(/\s*\n+\s*/g, captionMode === "dense" ? " " : "、")
        : "",
    );

    return NextResponse.json({ captions, captionsJa, safety: false });
  } catch (err) {
    return geminiErrorResponse(err, ERR_MESSAGES);
  }
}
