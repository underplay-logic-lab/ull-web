import "server-only";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { geminiApiKey, isSafetyRefusal, runGeminiText, type GemErr } from "@/lib/geminiText";
import { directorCameraLabel, type DirectorScene } from "@/lib/directorPricing";

// Phase 1 (プロンプト拡張): 複数シーンブロック（カメラワーク＋短いアイデア）を
// MiniMax H3 向けの1本の連続した英語プロンプトに合成する。
//
// Gemini の共有クライアント（src/lib/geminiText.ts）は既に全カテゴリ
// BLOCK_NONE（RELAXED_SAFETY）で動いているため、Google 側の非設定可能な
// 絶対ブロック以外はほぼ素通りする。実際に違法・規約違反なコンテンツは
// この関数の手前（API route 側）で src/lib/contentPolicy.ts のレッドライン
// フィルターが弾く設計なので、ここで想定する「refusal」は主に誤爆
// （水着・戦闘シーン等）ではなく本当に際どい入力のみのはず。
//
// 2026-09-13 時点: refusal を検知した場合の第2LLM（自己ホスト Qwen VLM）への
// フォールバックは未実装（別途 GPU デプロイが必要な大きめの作業のため、
// このリリースではスコープ外）。refusal を検知したら DirectorPromptError を
// 投げ、呼び出し側はユーザーにその旨を案内する。
export class DirectorPromptError extends Error {
  constructor(
    message: string,
    public readonly reason: "refusal" | "quota" | "busy" | "failed" | "not_configured",
  ) {
    super(message);
    this.name = "DirectorPromptError";
  }
}

// 2026-09-14: 各シーンの時間配分（durationS）を明示的にプロンプトへ書き込む
// ようにした。以前は時間情報が一切無く、Geminiが合成した1本のプロンプトから
// 尺の情報が失われていたため、60秒のような長尺で「指示が途中で尽きて同じ
// 動作を繰り返す」実障害があった。MiniMax H3自体にタイムスタンプで厳密に
// 条件付けする仕組みは無いため、これは「モデルが従いやすくなるヒント」で
// あって100%の保証ではない点に注意（ホスト報告、実測で確認）。
function buildSceneDirectorPrompt(scenes: DirectorScene[]): string {
  let elapsed = 0;
  const sceneLines = scenes
    .map((s, i) => {
      const start = elapsed;
      elapsed += Math.max(0, Math.round(s.durationS || 0));
      return `Scene ${i + 1} (${start}s-${elapsed}s): camera movement = ${directorCameraLabel(s.camera)}. Action: ${s.text}`;
    })
    .join("\n");
  return [
    "You are an expert cinematic video director.",
    "The user has provided a timed sequence of scenes, each with a specific time range, camera movement, and action.",
    "Combine them into a SINGLE, highly detailed, continuous English prompt optimized for a text-to-video model.",
    "Explicitly convey the passage of time and the order of actions (e.g. \"first... then... after that... finally...\") so each scene's action occupies roughly its own share of the total duration — do not let one action bleed into or replace another scene's action.",
    "Ensure the transitions between actions are smooth and cinematic. Include lighting and atmosphere.",
    "Preserve the subject's appearance, clothing, and identity exactly as shown in the reference image throughout every scene.",
    "Output ONLY the final English prompt text — no preamble, no scene labels, no timestamps, no quotes.",
    "",
    sceneLines,
  ].join("\n");
}

/** シーン配列 → 1本の連続した英語プロンプト。Gemini が拒否/枯渇/輻輳した場合は
 * DirectorPromptError を投げる（呼び出し側は 502/429/503 等へマップする）。 */
export async function expandDirectorScenes(scenes: DirectorScene[]): Promise<string> {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    throw new DirectorPromptError("AI 機能が未設定です（GEMINI_API_KEY 未設定）。", "not_configured");
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  try {
    const raw = await runGeminiText(genAI, buildSceneDirectorPrompt(scenes), false);
    const cleaned = raw.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    if (!cleaned) {
      throw new DirectorPromptError("プロンプトの合成に失敗しました（空の応答）。", "failed");
    }
    return cleaned;
  } catch (err) {
    if (isSafetyRefusal(err)) {
      throw new DirectorPromptError(
        "入力内容がAIの安全フィルターに引っかかり、プロンプトを生成できませんでした。表現を少し変えて再度お試しください。",
        "refusal",
      );
    }
    const e = err as GemErr;
    if (e && typeof e === "object" && "kind" in e) {
      const reason = e.kind === "quota" ? "quota" : e.kind === "busy" ? "busy" : "failed";
      throw new DirectorPromptError(
        reason === "quota"
          ? "AI の無料利用枠を超過しました。少し時間をおいて再試行してください。"
          : reason === "busy"
            ? "AI サービスが一時的に混雑しています。少し待って再試行してください。"
            : "プロンプトの合成に失敗しました。",
        reason,
      );
    }
    if (err instanceof DirectorPromptError) throw err;
    throw new DirectorPromptError("プロンプトの合成に失敗しました。", "failed");
  }
}

/** 合成済み英語プロンプトをユーザー向けに日本語訳する（コピペ用UI表示のため）。
 * ベストエフォート — 失敗しても生成自体は止めない設計なので、呼び出し側は
 * null を「翻訳なし」として扱い、英語原文だけ表示すればよい。 */
export async function translateDirectorPromptToJapanese(englishPrompt: string): Promise<string | null> {
  const apiKey = geminiApiKey();
  if (!apiKey) return null;
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const raw = await runGeminiText(
      genAI,
      [
        "Translate the following English video-generation prompt into natural, fluent Japanese.",
        "Output ONLY the Japanese translation — no preamble, no quotes, no English.",
        "",
        englishPrompt,
      ].join("\n"),
      false,
    );
    const cleaned = raw.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    return cleaned || null;
  } catch (err) {
    console.error("[directorPrompt] translateDirectorPromptToJapanese failed:", err);
    return null;
  }
}

// 日本語かどうかの簡易判定（ひらがな・カタカナ・CJK統合漢字の範囲）。
// プロンプトモードで日本語入力を検知し、モデルに渡す前に英訳するために使う。
const JAPANESE_RE = /[぀-ヿ㐀-䶿一-鿿]/;

export function looksJapanese(text: string): boolean {
  return JAPANESE_RE.test(text);
}

/** プロンプトモード用: ユーザーが日本語で書いた（または日本語訳をコピペして
 * 少し直した）プロンプトを、モデルに渡す前に英語へ変換する。looksJapanese()
 * で日本語が検知された場合のみ呼び出す想定 — 英語ならそのまま使えばよい。
 * 翻訳合成(expandDirectorScenes)と違い、こちらは失敗時に呼び出し側へ例外を
 * 投げる（無音でユーザーの意図と違う言語のまま生成されるのを防ぐため）。 */
export async function translateJapanesePromptToEnglish(japanesePrompt: string): Promise<string> {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    throw new DirectorPromptError("AI 機能が未設定です（GEMINI_API_KEY 未設定）。", "not_configured");
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  try {
    const raw = await runGeminiText(
      genAI,
      [
        "Translate the following Japanese video-generation prompt into natural, highly detailed English",
        "optimized for a text-to-video model. Preserve all specific details (camera movements, actions, timing).",
        "Output ONLY the English translation — no preamble, no quotes, no Japanese.",
        "",
        japanesePrompt,
      ].join("\n"),
      false,
    );
    const cleaned = raw.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    if (!cleaned) {
      throw new DirectorPromptError("プロンプトの翻訳に失敗しました（空の応答）。", "failed");
    }
    return cleaned;
  } catch (err) {
    if (err instanceof DirectorPromptError) throw err;
    if (isSafetyRefusal(err)) {
      throw new DirectorPromptError(
        "入力内容がAIの安全フィルターに引っかかり、翻訳できませんでした。表現を少し変えて再度お試しください。",
        "refusal",
      );
    }
    const e = err as GemErr;
    if (e && typeof e === "object" && "kind" in e) {
      const reason = e.kind === "quota" ? "quota" : e.kind === "busy" ? "busy" : "failed";
      throw new DirectorPromptError(
        reason === "quota"
          ? "AI の無料利用枠を超過しました。少し時間をおいて再試行してください。"
          : reason === "busy"
            ? "AI サービスが一時的に混雑しています。少し待って再試行してください。"
            : "プロンプトの翻訳に失敗しました。",
        reason,
      );
    }
    throw new DirectorPromptError("プロンプトの翻訳に失敗しました。", "failed");
  }
}
