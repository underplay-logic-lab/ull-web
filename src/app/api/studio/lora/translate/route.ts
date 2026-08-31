import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI, SchemaType, type GenerationConfig } from "@google/generative-ai";

// Caption translation for the LoRA Studio dataset-curation UI. Uses Google
// AI Studio (Gemini) — the free tier needs no card / billing ($0). Set
// GEMINI_API_KEY (and optionally GEMINI_MODEL) in the env.
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

// Model notes (2026-08):
//  - gemini-1.5-flash / gemini-2.0-flash: retired, 404.
//  - gemini-2.5-flash / -lite: 404 "no longer available to new users" for
//    recently-created API keys.
//  - gemini-flash-latest: allowed, but frequently 503 "high demand".
//  - gemini-3.6-flash: reliable for new keys → default head.
// GEMINI_MODEL overrides the head of the list (recommended: pin one).
function modelCandidates(): string[] {
  const configured = process.env.GEMINI_MODEL?.trim();
  return [
    ...new Set(
      [configured, "gemini-3.6-flash", "gemini-flash-latest", "gemini-2.5-flash"].filter(Boolean),
    ),
  ] as string[];
}

const QUOTA_RE = /quota|rate limit|resource has been exhausted|\b429\b/i;
const BUSY_RE = /overloaded|high demand|unavailable|temporarily|\b503\b/i;
const MISSING_RE = /not found|not supported|unsupported|no longer available|\b404\b|does not exist/i;
const THINKING_RE = /thinking|thinkingbudget|thinkingconfig/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// gemini-2.x "think" by default and burn the output budget on hidden
// reasoning — thinkingBudget:0 turns it off. That knob is 2.x-only: 3.x
// rejects it (400, uses thinkingLevel instead), so only send it for a 2.x
// id or the flash-latest/-lite aliases (which currently point at 2.5).
// thinkingConfig isn't in this SDK version's types; the field is forwarded
// to v1beta verbatim. `dropThinking` is set on a 400-retry (see runGemini).
function genConfig(model: string, jsonArray: boolean, dropThinking: boolean): GenerationConfig {
  const cfg: Record<string, unknown> = { temperature: 0.2, maxOutputTokens: 8192 };
  if (!dropThinking) {
    if (/^gemini-3\./.test(model)) {
      // 3.x rejects thinkingBudget:0 (400); thinkingLevel LOW keeps latency
      // sane (a batch otherwise "thinks" for 20-30s).
      cfg.thinkingConfig = { thinkingLevel: "LOW" };
    } else if (/^gemini-2\.|^gemini-flash(-lite)?-latest$/.test(model)) {
      cfg.thinkingConfig = { thinkingBudget: 0 };
    }
  }
  if (jsonArray) {
    cfg.responseMimeType = "application/json";
    cfg.responseSchema = { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } };
  }
  return cfg as unknown as GenerationConfig;
}

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

type GemErr = { kind: "quota" | "busy" | "failed"; message: string };
const isGemErr = (e: unknown): e is GemErr =>
  typeof e === "object" && e !== null && "kind" in e && "message" in e;

// Runs the prompt against the model-candidate list with a 503 retry. Returns
// the raw response text; throws a GemErr on quota / persistent busy / failure.
async function runGemini(genAI: GoogleGenerativeAI, prompt: string, jsonArray: boolean): Promise<string> {
  let lastErr = "";
  let sawBusy = false;
  for (const modelId of modelCandidates()) {
    let dropThinking = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelId,
          generationConfig: genConfig(modelId, jsonArray, dropThinking),
        });
        const result = await model.generateContent(prompt);
        const resp = result.response;
        const cand = resp.candidates?.[0];
        let out = "";
        try {
          out = resp.text() ?? "";
        } catch {
          out =
            cand?.content?.parts
              ?.map((p) => (typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
              .join("") ?? "";
        }
        if (out.trim()) return out;
        lastErr = `empty response (${resp.promptFeedback?.blockReason ?? cand?.finishReason ?? "empty"})`;
        if (attempt === 0 && cand?.finishReason === "MAX_TOKENS") continue;
        break; // -> next candidate
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        if (QUOTA_RE.test(lastErr)) throw { kind: "quota", message: lastErr } satisfies GemErr;
        if (BUSY_RE.test(lastErr)) {
          sawBusy = true;
          if (attempt === 0) {
            await sleep(1500);
            continue;
          }
          console.warn(`[studio/lora/translate] ${modelId} overloaded, trying next`);
          break;
        }
        if (MISSING_RE.test(lastErr)) {
          console.warn(`[studio/lora/translate] ${modelId} unavailable, trying next: ${lastErr}`);
          break;
        }
        // A 3.x model rejecting thinkingBudget (or a repointed alias) — retry
        // the same model once with thinkingConfig dropped.
        if (!dropThinking && THINKING_RE.test(lastErr)) {
          dropThinking = true;
          console.warn(`[studio/lora/translate] ${modelId}: retrying without thinkingConfig`);
          continue;
        }
        throw { kind: "failed", message: lastErr } satisfies GemErr;
      }
    }
  }
  throw { kind: sawBusy ? "busy" : "failed", message: lastErr } satisfies GemErr;
}

function errorResponse(e: unknown): NextResponse {
  if (isGemErr(e)) {
    const status = e.kind === "quota" ? 429 : e.kind === "busy" ? 503 : 502;
    const error =
      e.kind === "quota"
        ? "翻訳の無料利用枠を超過しました。少し時間をおいて再試行してください。"
        : e.kind === "busy"
          ? "翻訳サービスが一時的に混雑しています。少し待って再試行してください。"
          : "翻訳に失敗しました。";
    console.error("[studio/lora/translate] Gemini failed:", e.message);
    return NextResponse.json({ error, reason: e.message }, { status });
  }
  const message = e instanceof Error ? e.message : String(e);
  console.error("[studio/lora/translate] unhandled:", message);
  return NextResponse.json({ error: "翻訳に失敗しました。", reason: message }, { status: 500 });
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

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "翻訳機能が未設定です。管理者に GEMINI_API_KEY の設定を依頼してください。" },
        { status: 501 },
      );
    }

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
        raw = await runGemini(genAI, buildBatchPrompt(action, items), true);
      } catch (e) {
        return errorResponse(e);
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
      raw = await runGemini(genAI, buildSinglePrompt(action, text), false);
    } catch (e) {
      return errorResponse(e);
    }
    return NextResponse.json({ translation: tidy(action, raw), action });
  } catch (err) {
    return errorResponse(err);
  }
}
