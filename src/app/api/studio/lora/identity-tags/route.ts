import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  geminiApiKey,
  geminiErrorResponse,
  geminiNotConfiguredResponse,
  runGeminiVision,
} from "@/lib/geminiText";

// 被写体の「見た目の固定特徴」を、実際の画像から Danbooru タグとして抽出する
// （2026-09-21）。
//
// これはキャプションと**ちょうど逆**の情報にあたる。キャプション側はこの手の
// identity をブラックリストで書かせない（トリガーへ焼き込むため）ので、同じ
// 結果からは取り出せない。よって被写体ごとに数枚だけ渡す専用の1パスを立てる。
//
// 用途: 完成した LoRA の metadata へ埋め込み、生成時にプロンプトへ戻すことで
// 再現性を上げる（ホストの ComfyUI 側にその機能がある）。
//
// ホスト方針（2026-09-21）:
//   「理想は、画像解析結果から抽出されるが、最終的には特徴として不要なら削除、
//     不足なら追加ということをする方式」
// なので**確定させずに候補を返すだけ**。取捨選択は UI 側で行う。
export const maxDuration = 60;

// 1被写体あたりに渡す枚数。多くしても精度は頭打ちで、無料枠のリクエストを
// 食うだけ。顔が見える数枚あれば identity は十分に拾える。
const MAX_IMAGES = 6;
const MAX_IMG_B64 = 600_000;
const MAX_TOTAL_B64 = 3_000_000;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

const ERR_MESSAGES = {
  tag: "studio/lora/identity-tags",
  quota: "AI 解析の無料利用枠を超過しました。少し時間をおいて再試行するか、手で入力してください。",
  busy: "AI 解析が一時的に混雑しています。少し待って再試行してください。",
  failed: "特徴の抽出に失敗しました。",
} as const;

function buildPrompt(trigger: string, hintJa: string): string {
  return [
    "You are building the identity tag list for a LoRA of a single recurring character.",
    `The character's trigger word is "${trigger}".`,
    hintJa ? `The user describes them in Japanese as: ${hintJa}` : "",
    "",
    "Look at the images and list ONLY this character's PERMANENT physical identity traits —",
    "the things that are true in EVERY image because they ARE this character:",
    "  body type, build, age range, skin tone, hair (colour / length / style) or baldness,",
    "  eye colour, facial hair, glasses, and any feature that never changes.",
    "",
    "Do NOT list anything that changes between images:",
    "  pose, camera angle, framing, expression, background, lighting,",
    "  and clothing UNLESS it is a signature outfit worn in every single image.",
    "If two people appear, describe ONLY the one matching the description above.",
    "",
    "Answer as a JSON array of lowercase Danbooru-style tags, at most 12, most",
    'distinctive first. Example: ["bald", "fat", "glasses", "old man"]',
    "Output ONLY the JSON array — no prose, no markdown fences.",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseTags(raw: string): string[] {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let arr: unknown = null;
  try {
    arr = JSON.parse(text);
  } catch {
    const m = text.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        arr = JSON.parse(m[0]);
      } catch {
        arr = null;
      }
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of Array.isArray(arr) ? arr : []) {
    const t = String(v ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 _'-]/g, "")
      .trim();
    if (!t || t.length > 40 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

export async function POST(request: Request) {
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
    const trigger = typeof body?.trigger === "string" ? body.trigger.trim().slice(0, 64) : "";
    const hintJa = typeof body?.hint_ja === "string" ? body.hint_ja.trim().slice(0, 300) : "";
    if (!trigger) {
      return NextResponse.json({ error: "トリガーワードが必要です。" }, { status: 400 });
    }

    const rawImages = Array.isArray(body?.images) ? body.images : [];
    const images: { mimeType: string; data: string }[] = [];
    let total = 0;
    for (const im of rawImages.slice(0, MAX_IMAGES)) {
      const mimeType = typeof im?.mimeType === "string" ? im.mimeType : "";
      const data = typeof im?.data === "string" ? im.data : "";
      if (!ALLOWED_MIME.has(mimeType) || !data || data.length > MAX_IMG_B64) continue;
      total += data.length;
      if (total > MAX_TOTAL_B64) break;
      images.push({ mimeType, data });
    }
    if (images.length === 0) {
      return NextResponse.json({ error: "画像が必要です。" }, { status: 400 });
    }

    const apiKey = geminiApiKey();
    if (!apiKey) return geminiNotConfiguredResponse();
    const genAI = new GoogleGenerativeAI(apiKey);

    let raw: string;
    try {
      raw = await runGeminiVision(genAI, buildPrompt(trigger, hintJa), images, true);
    } catch (e) {
      return geminiErrorResponse(e, ERR_MESSAGES);
    }

    const tags = parseTags(raw);
    if (tags.length === 0) {
      return NextResponse.json(
        { error: "特徴を抽出できませんでした。手で入力してください。", reason: raw.slice(0, 200) },
        { status: 502 },
      );
    }
    return NextResponse.json({ tags });
  } catch (err) {
    console.error("[studio/lora/identity-tags] failed:", err);
    return NextResponse.json({ error: "特徴の抽出に失敗しました。" }, { status: 500 });
  }
}
