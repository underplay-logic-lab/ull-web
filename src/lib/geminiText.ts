import { NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType, type GenerationConfig } from "@google/generative-ai";

// Shared Google AI Studio (Gemini) text runner. The free tier needs no card
// / billing ($0) — this is the ONLY LLM client in the project (the Modal-side
// Qwen VLM aside). Set GEMINI_API_KEY (and optionally GEMINI_MODEL) in the env.
//
// Both /api/studio/lora/translate (caption round-trip translation) and
// /api/studio/lora/caption-prompt (category-aware Qwen instruction synthesis)
// go through runGeminiText() so the finicky model-id gating below lives in
// exactly one place.

// Model notes (2026-08):
//  - gemini-1.5-flash / gemini-2.0-flash: retired, 404.
//  - gemini-2.5-flash / -lite: 404 "no longer available to new users" for
//    recently-created API keys (this project's key is one).
//  - gemini-flash-latest: allowed, but frequently 503 "high demand".
//  - gemini-3.6-flash: reliable for new keys → default head.
// GEMINI_MODEL overrides the head of the list (recommended: pin one).
export function geminiModelCandidates(): string[] {
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
// to v1beta verbatim. `dropThinking` is set on a 400-retry (see runGeminiText).
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

export type GemErr = { kind: "quota" | "busy" | "failed"; message: string };
export const isGemErr = (e: unknown): e is GemErr =>
  typeof e === "object" && e !== null && "kind" in e && "message" in e;

// Returns the Gemini API key, or null when it isn't configured.
export function geminiApiKey(): string | null {
  return process.env.GEMINI_API_KEY?.trim() || null;
}

// The canonical 501 for "GEMINI_API_KEY not set on this deploy".
export function geminiNotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: "AI 機能が未設定です。管理者に GEMINI_API_KEY の設定を依頼してください。" },
    { status: 501 },
  );
}

// Runs `prompt` against the model-candidate list with a 503 retry. Returns
// the raw response text; throws a GemErr on quota / persistent busy / failure.
export async function runGeminiText(
  genAI: GoogleGenerativeAI,
  prompt: string,
  jsonArray = false,
): Promise<string> {
  let lastErr = "";
  let sawBusy = false;
  for (const modelId of geminiModelCandidates()) {
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
          console.warn(`[geminiText] ${modelId} overloaded, trying next`);
          break;
        }
        if (MISSING_RE.test(lastErr)) {
          console.warn(`[geminiText] ${modelId} unavailable, trying next: ${lastErr}`);
          break;
        }
        // A 3.x model rejecting thinkingBudget (or a repointed alias) — retry
        // the same model once with thinkingConfig dropped.
        if (!dropThinking && THINKING_RE.test(lastErr)) {
          dropThinking = true;
          console.warn(`[geminiText] ${modelId}: retrying without thinkingConfig`);
          continue;
        }
        throw { kind: "failed", message: lastErr } satisfies GemErr;
      }
    }
  }
  throw { kind: sawBusy ? "busy" : "failed", message: lastErr } satisfies GemErr;
}

// Maps a thrown GemErr (or any error) to a JSON NextResponse. `messages`
// overrides the user-facing copy per kind.
export function geminiErrorResponse(
  e: unknown,
  messages?: { quota?: string; busy?: string; failed?: string; tag?: string },
): NextResponse {
  const tag = messages?.tag ?? "geminiText";
  if (isGemErr(e)) {
    const status = e.kind === "quota" ? 429 : e.kind === "busy" ? 503 : 502;
    const error =
      e.kind === "quota"
        ? messages?.quota ?? "AI の無料利用枠を超過しました。少し時間をおいて再試行してください。"
        : e.kind === "busy"
          ? messages?.busy ?? "AI サービスが一時的に混雑しています。少し待って再試行してください。"
          : messages?.failed ?? "AI 処理に失敗しました。";
    console.error(`[${tag}] Gemini failed:`, e.message);
    return NextResponse.json({ error, reason: e.message }, { status });
  }
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[${tag}] unhandled:`, message);
  return NextResponse.json(
    { error: messages?.failed ?? "AI 処理に失敗しました。", reason: message },
    { status: 500 },
  );
}
