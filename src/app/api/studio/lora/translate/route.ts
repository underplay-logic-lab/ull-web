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
//   action "to_ja": English tag list / prose -> natural Japanese
//   action "to_en": the user's edited Japanese -> a Danbooru-style
//                   comma-separated English tag list for LoRA training
//
// Two request shapes:
//   { action, text }            -> { translation }
//   { action, items: string[] } -> { translations: string[] }  (batch — one
//        Gemini call for the whole chunk, so the 15 RPM free tier is easy
//        to stay under even for a 100-image dataset)
export const maxDuration = 45;

const MAX_TEXT = 4000;
const MAX_BATCH = 40;
const MAX_BATCH_CHARS = 24000;
type Action = "to_ja" | "to_en";

const TRANSLATE_ERR_MESSAGES = {
  tag: "studio/lora/translate",
  quota: "翻訳の無料利用枠を超過しました。少し時間をおいて再試行してください。",
  busy: "翻訳サービスが一時的に混雑しています。少し待って再試行してください。",
  failed: "翻訳に失敗しました。",
} as const;

function taskLine(action: Action): string {
  return action === "to_ja"
    ? "Translate the English caption into natural Japanese, keeping any comma-separated tag structure. No romaji, no notes."
    : "Turn the Japanese text into a comma-separated list of English anime/image tagging style tags (like \"1girl, long hair, blue shirt\"). Tags only, no notes.";
}

function buildSinglePrompt(action: Action, text: string): string {
  return [
    "You translate AI image-training dataset captions.",
    taskLine(action),
    "Output ONLY the result — no preamble, no explanations, no quotes.",
    "",
    `Input: ${text}`,
  ].join("\n");
}

function buildBatchPrompt(action: Action, items: string[]): string {
  return [
    "You translate AI image-training dataset captions.",
    taskLine(action),
    `Process EACH element of the input JSON array. Return a JSON array of strings of the SAME length and order (${items.length} elements) — results only.`,
    "",
    "Input:",
    JSON.stringify(items),
  ].join("\n");
}

function tidy(action: Action, raw: string): string {
  let out = (raw ?? "").trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
  if (out.length > 1 && ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("「") && out.endsWith("」")))) {
    out = out.slice(1, -1).trim();
  }
  if (action === "to_en") {
    out = out
      .replace(/\s*\n+\s*/g, ", ")
      .replace(/\s*,\s*/g, ", ")
      .replace(/(?:^,\s*)|(?:,\s*$)/g, "")
      .replace(/,\s*,/g, ",")
      .trim();
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
        raw = await runGeminiText(genAI, buildBatchPrompt(action, items), true);
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
        src ? tidy(action, typeof arr[i] === "string" ? (arr[i] as string) : "") : "",
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
      raw = await runGeminiText(genAI, buildSinglePrompt(action, text), false);
    } catch (e) {
      return geminiErrorResponse(e, TRANSLATE_ERR_MESSAGES);
    }
    return NextResponse.json({ translation: tidy(action, raw), action });
  } catch (err) {
    return geminiErrorResponse(err, TRANSLATE_ERR_MESSAGES);
  }
}
