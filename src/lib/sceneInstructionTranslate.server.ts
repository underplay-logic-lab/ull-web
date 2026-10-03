import "server-only";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { geminiApiKey, runGeminiText } from "@/lib/geminiText";
import { containsJapanese, translateToEnglish } from "@/lib/translate";

// 素材づくりの指示（英語の文に日本語の自由入力が混ざる）を英語にする（2026-10-03）。
//
// 以前は指示全体を無料の機械翻訳に通していたが、英文の中の日本語の語を丸ごと落としていた
// （"Make the character ピースする 桜並木, ..." → "Make the character, ..."）。自由入力のポーズ・場面は
// 一度も効いておらず、場面が消えた行は元画像の白い背景のまま出ていた（ホストの録画中に発覚）。
// 語だけ切り出して訳しても「ピースする → make a piece」と誤訳するので、文脈ごと Gemini で訳す。
// Gemini が使えないときだけ、日本語の部分だけを切り出して機械翻訳する（文ごと渡すと落ちるため）。

const JA_RUN = /[぀-ゟ゠-ヿ一-鿿＀-￯々〆、。「」・ー]+(?:[\s　]+[぀-ゟ゠-ヿ一-鿿＀-￯々〆、。「」・ー]+)*/g;

async function translateRuns(text: string): Promise<string> {
  const runs = [...new Set(text.match(JA_RUN) ?? [])];
  if (runs.length === 0) return text;
  const map = new Map(await Promise.all(runs.map(async (r) => [r, await translateToEnglish(r)] as const)));
  return text.replace(JA_RUN, (r) => map.get(r) ?? r);
}

function buildPrompt(items: string[]): string {
  return [
    "Each item below is an English instruction for an image-editing model, but some parts are written in Japanese",
    "(free text typed by a Japanese user: a pose, a place, an outfit or an extra request).",
    "Rewrite each item as fully natural English: translate the Japanese parts faithfully and specifically in context",
    "(for example ピースする = making a peace sign with one hand, 桜並木 = on a path lined with blooming cherry blossom trees),",
    "and keep every English part exactly as it is. Do not drop, soften or add any content.",
    "Return ONLY a JSON array of strings, one per item, in the same order.",
    "",
    JSON.stringify(items),
  ].join("\n");
}

/** 日本語を含む指示だけを英訳して返す（同じ順）。どの経路でも失敗した項目は原文のまま（生成は止めない）。 */
export async function translateSceneInstructions(instructions: string[], userId: string | null): Promise<string[]> {
  const uniq = [...new Set(instructions.filter((t) => containsJapanese(t)))];
  if (uniq.length === 0) return instructions;
  const done = new Map<string, string>();

  const key = geminiApiKey();
  if (key) {
    try {
      const raw = await runGeminiText(new GoogleGenerativeAI(key), buildPrompt(uniq), true, {
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
      if (Array.isArray(arr) && arr.length === uniq.length) {
        uniq.forEach((src, i) => {
          const t = typeof arr[i] === "string" ? (arr[i] as string).trim() : "";
          if (t && !containsJapanese(t)) done.set(src, t);
        });
      }
    } catch (err) {
      console.error("[sceneInstructionTranslate] gemini failed, falling back:", err);
    }
  }

  await Promise.all(
    uniq.filter((t) => !done.has(t)).map(async (t) => done.set(t, await translateRuns(t))),
  );
  return instructions.map((t) => done.get(t) ?? t);
}
