import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  geminiApiKey,
  geminiErrorResponse,
  geminiNotConfiguredResponse,
  runGeminiText,
  runGeminiVision,
} from "@/lib/geminiText";

// Fast AI-vision auto-captioning for the LoRA Studio dataset.
//
// The browser downscales each training image to a small JPEG and POSTs a
// batch here (see src/lib/loraCaption.ts). Gemini's multimodal free tier
// captions the whole batch in one call (~5-8s for 12 images), then a second
// text call renders the Japanese working copies the curation UI shows.
//
//   { images: [{ data(b64), mimeType }], trigger_word?, caption_prompt? }
//     -> { captions: string[], captionsJa: string[] }   (aligned to images)
//
// The Modal worker's local VLM stays as a fallback for images this can't
// caption (quota / safety refusal) — the client sends the partial list and
// the worker fills the gaps.
export const maxDuration = 60;

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

function buildVisionPrompt(count: number, trigger: string, captionPrompt: string): string {
  const lines = [
    "You are an expert captioning engine that prepares training data for LoRA fine-tuning of image models.",
    `You are given ${count} image(s). Produce ONE caption per image.`,
    "",
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
  ];
  if (captionPrompt.trim()) {
    lines.push(
      "",
      "Additional user instructions (follow them, especially any 'do NOT mention' / blacklist of fixed features):",
      captionPrompt.trim().slice(0, 2000),
    );
  }
  lines.push(
    "",
    `Return a JSON array of exactly ${count} strings, in the same order as the images. Captions only.`,
  );
  return lines.join("\n");
}

function tidyCaption(raw: string, trigger: string): string {
  let out = (raw ?? "")
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/i, "")
    .replace(/\s*\n+\s*/g, ", ")
    .replace(/[*_#>`]+/g, "")
    .replace(NOISE_RE, "")
    .replace(/\s*,\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/(?:^[,\s]+)|(?:[,\s]+$)/g, "")
    .trim();
  if (trigger) {
    const re = new RegExp(`^\\s*${trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,?\\s*`, "i");
    out = out.replace(re, "");
    out = out ? `${trigger}, ${out}` : trigger;
  }
  return out;
}

function parseJsonArray(raw: string, count: number): string[] | null {
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
  return Array.from({ length: count }, (_, i) => (typeof arr[i] === "string" ? (arr[i] as string) : ""));
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
    const captionPrompt =
      typeof body?.caption_prompt === "string" ? body.caption_prompt.slice(0, 4000) : "";

    const apiKey = geminiApiKey();
    if (!apiKey) return geminiNotConfiguredResponse();
    const genAI = new GoogleGenerativeAI(apiKey);

    // --- vision pass: English captions --------------------------------------
    let rawEn: string;
    try {
      rawEn = await runGeminiVision(
        genAI,
        buildVisionPrompt(images.length, triggerWord, captionPrompt),
        images,
        true,
      );
    } catch (e) {
      return geminiErrorResponse(e, ERR_MESSAGES);
    }
    const parsedEn = parseJsonArray(rawEn, images.length);
    if (!parsedEn) {
      return NextResponse.json(
        { error: "解析結果を解釈できませんでした。", reason: rawEn.slice(0, 300) },
        { status: 502 },
      );
    }
    const captions = parsedEn.map((c) => tidyCaption(c, triggerWord));

    // --- text pass: Japanese working copies -------------------------------
    // Non-fatal: the JA copies are only for the curation UI's confirmation
    // view. On failure we return blanks and the UI's own translate buttons
    // still work.
    const captionsJa: string[] = captions.map(() => "");
    const nonEmpty = captions.map((c, i) => ({ c, i })).filter((x) => x.c.trim());
    if (nonEmpty.length) {
      try {
        const jaPrompt = [
          "Translate each English AI-image training caption into natural Japanese.",
          "Keep the comma-separated structure. No romaji, no notes, no markdown.",
          `Return a JSON array of exactly ${nonEmpty.length} strings, same order.`,
          "",
          "Input:",
          JSON.stringify(nonEmpty.map((x) => x.c)),
        ].join("\n");
        const rawJa = await runGeminiText(genAI, jaPrompt, true);
        const parsedJa = parseJsonArray(rawJa, nonEmpty.length);
        if (parsedJa) {
          nonEmpty.forEach((x, k) => {
            captionsJa[x.i] = (parsedJa[k] ?? "").trim();
          });
        }
      } catch (e) {
        console.warn("[studio/lora/caption] JA translation failed (non-fatal):", e);
      }
    }

    return NextResponse.json({ captions, captionsJa });
  } catch (err) {
    return geminiErrorResponse(err, ERR_MESSAGES);
  }
}
