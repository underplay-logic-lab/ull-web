import "server-only";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { geminiApiKey, runGeminiText } from "@/lib/geminiText";
import { containsJapanese, translateToEnglish } from "@/lib/translate";

// 素材づくりの指示（英語の文に日本語の自由入力が混ざる）を英語にする（2026-10-03）。
//
// 以前は指示全体を無料の機械翻訳に通していたが、英文の中の日本語の語を丸ごと落としていた
// （"Make the character ピースする 桜並木, ..." → "Make the character, ..."）。語だけ機械翻訳すると
// 「ピースする → make a piece」と誤訳するので Gemini で訳す。
//
// 2026-10-03 夕: 指示を 16 行まとめて渡したら Gemini が 3 モデルとも空応答（安全ブロックの形）で、
// 予備の機械翻訳も弾かれ、日本語の「ピースする」のままワーカーへ渡ってピースが 1 枚も出なかった（ジョブ 5834d0ca）。
// → 指示の全文ではなく、日本語の語句（自由入力の部分）だけを訳す（短く文脈が薄いのでブロックされにくい・速い）。
// → それでも日本語が残るなら throw する（呼び出し側が課金前にエラーで止める。黙って日本語のまま送らない）。

const JA_RUN = /[぀-ゟ゠-ヿ一-鿿＀-￯々〆、。「」・ー]+(?:[\s　]+[぀-ゟ゠-ヿ一-鿿＀-￯々〆、。「」・ー]+)*/g;

export class SceneTranslateError extends Error {
  constructor(public readonly phrases: string[]) {
    super(`ポーズ・場面などの自由入力を英語にできませんでした（${phrases.join("・")}）。少し待ってもう一度お試しください。`);
    this.name = "SceneTranslateError";
  }
}

function buildPrompt(phrases: string[]): string {
  return [
    "Translate each short Japanese phrase below into natural, specific English for an image-editing instruction.",
    "They were typed by a user describing a character's pose, a place, an outfit or an extra request.",
    "Be faithful and concrete (for example ピースする = making a peace sign with one hand,",
    "桜並木 = a path lined with blooming cherry blossom trees). Do not add or drop content.",
    "Return ONLY a JSON array of strings, one per phrase, in the same order.",
    "",
    JSON.stringify(phrases),
  ].join("\n");
}

async function geminiPhrases(phrases: string[], userId: string | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const key = geminiApiKey();
  if (!key || phrases.length === 0) return out;
  try {
    const raw = await runGeminiText(new GoogleGenerativeAI(key), buildPrompt(phrases), true, {
      feature: "scene_translate",
      userId,
    });
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch {
      const m = raw.match(/\[[\s\S]*\]/);
      arr = m ? JSON.parse(m[0]) : null;
    }
    if (Array.isArray(arr) && arr.length === phrases.length) {
      phrases.forEach((src, i) => {
        const t = typeof arr[i] === "string" ? (arr[i] as string).trim() : "";
        if (t && !containsJapanese(t)) out.set(src, t);
      });
    }
  } catch (err) {
    console.error("[sceneInstructionTranslate] gemini failed:", err);
  }
  return out;
}

/**
 * 指示の中の日本語の語句を英訳して差し替える（同じ順）。日本語を含まない指示はそのまま。
 * 訳せない語句が残ったら SceneTranslateError を投げる（日本語のまま生成に回すと指定が黙って無視されるため）。
 */
export async function translateSceneInstructions(instructions: string[], userId: string | null): Promise<string[]> {
  const phrases = [...new Set(instructions.flatMap((t) => t.match(JA_RUN) ?? []))];
  if (phrases.length === 0) return instructions;

  const done = await geminiPhrases(phrases, userId);
  // 一度でまとめて断られたときは 1 語句ずつ取り直す（どれか 1 つに引っ張られて全部落ちないように）。
  const missing = phrases.filter((p) => !done.has(p));
  if (missing.length > 1) {
    for (const p of missing) for (const [k, v] of await geminiPhrases([p], userId)) done.set(k, v);
  }
  // 最後の手段: 語句だけ機械翻訳（文ごと渡すと語が落ちるため）。訳せなければ日本語のまま返ってくる。
  await Promise.all(
    phrases
      .filter((p) => !done.has(p))
      .map(async (p) => {
        const t = (await translateToEnglish(p)).trim();
        if (t && !containsJapanese(t)) done.set(p, t);
      }),
  );

  const failed = phrases.filter((p) => !done.has(p));
  if (failed.length > 0) throw new SceneTranslateError(failed);
  return instructions.map((t) => t.replace(JA_RUN, (r) => done.get(r) ?? r));
}
