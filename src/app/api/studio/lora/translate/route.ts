import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  geminiApiKey,
  geminiErrorResponse,
  geminiNotConfiguredResponse,
  runGeminiText,
} from "@/lib/geminiText";

// Caption translation for the LoRA Studio dataset-curation UI. Uses Google
// AI Studio (Gemini) — the free tier needs no card / billing ($0). The
// finicky model-id gating + retry logic lives in src/lib/geminiText.ts.
//
//   action "to_ja": English caption -> natural Japanese
//   action "to_en": the user's edited Japanese -> English caption for LoRA
//                   training, in the FORMAT the base model wants:
//     caption_type "tags"  (default) -> Danbooru-style comma-separated tags
//                                       for the 77-token CLIP encoder (SDXL)
//     caption_type "dense"           -> a natural-language English sentence /
//                                       paragraph for the LLM/VLM text
//                                       encoders (Minimax H3, WAN 2.2, …).
//                                       NEVER collapsed to a tag list.
//
// Two request shapes (both accept an optional `caption_type`):
//   { action, text, caption_type? }            -> { translation }
//   { action, items: string[], caption_type? } -> { translations: string[] }
//        (batch — one Gemini call for the whole chunk, so the 15 RPM free
//        tier is easy to stay under even for a 100-image dataset)
export const maxDuration = 45;

const MAX_TEXT = 4000;
const MAX_BATCH = 40;
const MAX_BATCH_CHARS = 24000;
type Action = "to_ja" | "to_en";
type CaptionType = "dense" | "tags";

const TRANSLATE_ERR_MESSAGES = {
  tag: "studio/lora/translate",
  quota: "翻訳の無料利用枠を超過しました。少し時間をおいて再試行してください。",
  busy: "翻訳サービスが一時的に混雑しています。少し待って再試行してください。",
  failed: "翻訳に失敗しました。",
} as const;

function taskLine(action: Action, captionType: CaptionType): string {
  if (action === "to_ja") {
    return captionType === "dense"
      ? "Translate the English description into natural Japanese prose, keeping the sentence structure and every modifier relationship. No romaji, no notes."
      : "Translate the English caption into natural Japanese, keeping the comma-separated tag structure. No romaji, no notes.";
  }
  // to_en
  return captionType === "dense"
    ? [
        "Translate the Japanese text into a natural, concise English description written as flowing prose sentences.",
        "You MUST NOT convert it into a comma-separated tag list — keep it as real sentences.",
        "Preserve the context and every modifier relationship exactly as written; do not add, drop, compress, or reorder information.",
        "Keep roughly the same length as the input. No notes, no quotes.",
      ].join(" ")
    : "Turn the Japanese text into a comma-separated list of English anime/image tagging style tags (like \"1girl, long hair, blue shirt\"). Tags only, no notes.";
}

function buildSinglePrompt(action: Action, text: string, captionType: CaptionType): string {
  return [
    "You translate AI image-training dataset captions.",
    taskLine(action, captionType),
    "Output ONLY the result — no preamble, no explanations, no quotes.",
    "",
    `Input: ${text}`,
  ].join("\n");
}

function buildBatchPrompt(action: Action, items: string[], captionType: CaptionType): string {
  return [
    "You translate AI image-training dataset captions.",
    taskLine(action, captionType),
    `Process EACH element of the input JSON array. Return a JSON array of strings of the SAME length and order (${items.length} elements) — results only.`,
    "",
    "Input:",
    JSON.stringify(items),
  ].join("\n");
}

function tidy(action: Action, raw: string, captionType: CaptionType): string {
  let out = (raw ?? "").trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
  if (out.length > 1 && ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("「") && out.endsWith("」")))) {
    out = out.slice(1, -1).trim();
  }
  if (action === "to_en" && captionType === "tags") {
    // Tag list: newlines -> commas, normalise comma spacing, drop empties.
    out = out
      .replace(/\s*\n+\s*/g, ", ")
      .replace(/\s*,\s*/g, ", ")
      .replace(/(?:^,\s*)|(?:,\s*$)/g, "")
      .replace(/,\s*,/g, ",")
      .trim();
  } else if (action === "to_en") {
    // Dense prose: keep sentence structure — only fold hard line breaks into
    // spaces and squeeze runs of whitespace. NEVER comma-join.
    out = out.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  }
  return out;
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

    const apiKey = geminiApiKey();
    if (!apiKey) return geminiNotConfiguredResponse();

    const body = await request.json().catch(() => null);
    const action = (body?.action === "to_en" ? "to_en" : body?.action === "to_ja" ? "to_ja" : null) as Action | null;
    if (!action) {
      return NextResponse.json({ error: "action は to_ja / to_en のいずれかを指定してください。" }, { status: 400 });
    }
    // Caption FORMAT. Default "tags" preserves the legacy behaviour for any
    // caller that doesn't send it; "dense" keeps the result as prose.
    const captionType: CaptionType = body?.caption_type === "dense" ? "dense" : "tags";
    const genAI = new GoogleGenerativeAI(apiKey);

    // ---- batch ----
    if (Array.isArray(body?.items)) {
      const items = (body.items as unknown[]).map((x) => (typeof x === "string" ? x.trim() : ""));
      if (items.length === 0) return NextResponse.json({ translations: [], action });
      if (items.length > MAX_BATCH) {
        return NextResponse.json({ error: `一度に翻訳できるのは ${MAX_BATCH} 件までです。` }, { status: 400 });
      }
      if (items.reduce((s, t) => s + t.length, 0) > MAX_BATCH_CHARS) {
        return NextResponse.json({ error: "テキスト量が多すぎます。件数を減らしてください。" }, { status: 400 });
      }
      if (items.every((t) => !t)) {
        return NextResponse.json({ translations: items.map(() => ""), action });
      }

      let raw: string;
      try {
        raw = await runGeminiText(genAI, buildBatchPrompt(action, items, captionType), true);
      } catch (e) {
        return geminiErrorResponse(e, TRANSLATE_ERR_MESSAGES);
      }
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
      if (!Array.isArray(arr)) {
        return NextResponse.json(
          { error: "翻訳結果を解釈できませんでした。もう一度お試しください。", reason: raw.slice(0, 300) },
          { status: 502 },
        );
      }
      const translations = items.map((src, i) =>
        src ? tidy(action, typeof arr[i] === "string" ? (arr[i] as string) : "", captionType) : "",
      );
      return NextResponse.json({ translations, action });
    }

    // ---- single ----
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return NextResponse.json({ translation: "", action });
    if (text.length > MAX_TEXT) {
      return NextResponse.json({ error: `テキストが長すぎます（最大 ${MAX_TEXT} 文字）。` }, { status: 400 });
    }
    let raw: string;
    try {
      raw = await runGeminiText(genAI, buildSinglePrompt(action, text, captionType), false);
    } catch (e) {
      return geminiErrorResponse(e, TRANSLATE_ERR_MESSAGES);
    }
    return NextResponse.json({ translation: tidy(action, raw, captionType), action });
  } catch (err) {
    return geminiErrorResponse(err, TRANSLATE_ERR_MESSAGES);
  }
}
