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
  buildCategoryDefaultInstruction,
  coerceLoraCaptionCategory,
  type ResolvedCaptionMode,
} from "@/lib/loraCaptionSpec";

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
  quota: "AI 解析の無料利用枠を超過しました。少し時間をおいて再試行するか、キャプションは学習側で自動補完されます。",
  busy: "AI 解析が一時的に混雑しています。少し待って再試行してください。",
  failed: "画像の自動解析に失敗しました。",
} as const;

// Danbooru-ish quality/aesthetic noise the LoRA-training community explicitly
// does NOT want baked into captions — stripped from every result.
const NOISE_RE =
  /\b(?:masterpiece|best quality|high quality|ultra[- ]?detailed|highly detailed|extremely detailed|8k|4k|uhd|hdr|photorealistic|hyperrealistic|award[- ]?winning|stunning|beautiful|gorgeous|aesthetic|trending on artstation|sharp focus|bokeh quality)\b/gi;

// TAGS: compact Danbooru-style comma phrases for the 77-token CLIP encoder
// (Illustrious / Juggernaut / SDXL). This is the historical behaviour.
function buildTagsPrompt(count: number, trigger: string, captionPrompt: string): string {
  const instr = captionPrompt.trim();
  const lines = [
    "You are an expert captioning engine that prepares training data for LoRA fine-tuning of image models.",
    `You are given ${count} image(s). Produce ONE caption per image.`,
    "",
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
        ? `- Start every caption with "${trigger}, " and nothing before it.`
        : "- Do not invent a trigger token.",
    );
  } else {
    lines.push(
      "For each image, describe ONLY what is visually present, as compact comma-separated English phrases:",
      "- the subject and shot composition (e.g. \"1girl, upper body, looking at viewer\")",
      "- facial expression, then hairstyle and exact hair colour",
      "- clothing / outfit with colours and materials, and every accessory (hair ornament, ribbon, earrings, glasses, necklace, …)",
      "- pose / action, and the background / setting / lighting",
      "",
      "Hard rules:",
      "- 30 to 60 words per caption. Facts only — no mood, story, intent, or opinion.",
      "- NEVER output quality/aesthetic words (masterpiece, best quality, ultra-detailed, 8k, beautiful, aesthetic, …).",
      "- NO markdown, NO quotes, NO numbering, NO line breaks inside a caption.",
      trigger
        ? `- Start every caption with "${trigger}, " and nothing before it.`
        : "- Do not invent a trigger token.",
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
function buildDensePrompt(count: number, trigger: string, captionPrompt: string): string {
  const instr = captionPrompt.trim();
  const lines = [
    "You are an expert captioning engine that prepares training data for LoRA fine-tuning of modern diffusion transformers with LLM/VLM text encoders.",
    `You are given ${count} image(s). Produce ONE caption per image.`,
    "",
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
        ? `Start the paragraph with "${trigger}" as the subject (e.g. "${trigger} is shown ...", "${trigger} stands ...") and nothing before it.`
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
        ? `Start the paragraph with "${trigger}" as the subject (e.g. "${trigger} is a ...") and nothing before it.`
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
  trigger: string,
  captionPrompt: string,
  mode: ResolvedCaptionMode,
): string {
  return mode === "dense"
    ? buildDensePrompt(count, trigger, captionPrompt)
    : buildTagsPrompt(count, trigger, captionPrompt);
}

function tidyCaption(raw: string, trigger: string, mode: ResolvedCaptionMode = "tags"): string {
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
  if (trigger) {
    const re = new RegExp(`^\\s*${trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,?\\s*`, "i");
    out = out.replace(re, "");
    out = out ? `${trigger}, ${out}` : trigger;
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
        buildVisionPrompt(images.length, triggerWord, captionPrompt, captionMode),
        images,
        "enja",
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
    const captions = parsed.map((p) => tidyCaption(p.en, triggerWord, captionMode));
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
