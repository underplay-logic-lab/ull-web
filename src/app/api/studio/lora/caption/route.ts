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
  type LoraSubject,
  type ResolvedCaptionMode,
} from "@/lib/loraCaptionSpec";
import { buildVisionPrompt, parseEnJaArray, tidyCaption } from "@/lib/loraCaptionVision";
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
