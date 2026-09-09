import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  geminiApiKey,
  geminiErrorResponse,
  geminiNotConfiguredResponse,
  runGeminiText,
} from "@/lib/geminiText";
import {
  buildCaptionMetaPrompt,
  captionSpecHasInput,
  normalizeCaptionSpec,
  tidyCaptionPrompt,
} from "@/lib/loraCaptionSpec";

// Category-aware Qwen-27B caption-prompt synthesis for LoRA Studio.
//
// Given the LoRA training TYPE (人物 / 衣装 / 物体 / 背景 / 画風) and the user's
// Japanese description of the fixed vs. varying features, Gemini builds the
// English instruction that the Modal worker feeds to its Qwen captioner as
// `caption_prompt`. The browser calls this when the user advances past the
// form (see LoraStudioTab), so the generated prompt can be shown / edited
// before the paid training job is dispatched.
//
//   { category, fixed, varying, trigger_word }  ->  { captionPrompt }
export const maxDuration = 45;

const ERR_MESSAGES = {
  tag: "studio/lora/caption-prompt",
  quota: "AI プロンプト生成の無料利用枠を超過しました。少し時間をおいて再試行してください。",
  busy: "AI が一時的に混雑しています。少し待って再試行してください。",
  failed: "キャプションプロンプトの自動生成に失敗しました。",
} as const;

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
    const spec = normalizeCaptionSpec(body);
    if (!spec) {
      return NextResponse.json(
        { error: "category は character / outfit / object / background / style のいずれかを指定してください。" },
        { status: 400 },
      );
    }
    if (!captionSpecHasInput(spec)) {
      return NextResponse.json(
        { error: "固定したい特徴・変化させたい特徴のいずれかを入力してください。" },
        { status: 400 },
      );
    }

    const triggerWord =
      typeof body?.trigger_word === "string" ? body.trigger_word.trim().slice(0, 60) : "";

    const apiKey = geminiApiKey();
    if (!apiKey) return geminiNotConfiguredResponse();

    const genAI = new GoogleGenerativeAI(apiKey);
    let raw: string;
    try {
      raw = await runGeminiText(genAI, buildCaptionMetaPrompt(spec, triggerWord), false);
    } catch (e) {
      return geminiErrorResponse(e, ERR_MESSAGES);
    }

    const captionPrompt = tidyCaptionPrompt(raw).slice(0, 4000);
    if (!captionPrompt) {
      return NextResponse.json(
        { error: ERR_MESSAGES.failed, reason: raw.slice(0, 300) },
        { status: 502 },
      );
    }
    return NextResponse.json({ captionPrompt, category: spec.category });
  } catch (err) {
    return geminiErrorResponse(err, ERR_MESSAGES);
  }
}
