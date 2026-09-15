import "server-only";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { geminiApiKey, isSafetyRefusal, runGeminiText, type GemErr } from "@/lib/geminiText";
import { directorCameraLabel, type DirectorScene } from "@/lib/directorPricing";

// 2026-09-15: MiniMax H3 は音声・映像を同時生成するモデルで、プロンプト内に
// `<d>[言語]セリフ</d>` を埋め込むと台詞＋リップシンクをネイティブに生成する
// （GitHub上のMiniMax-AI/MiniMax-H3公式README・実例記事で確認済み — 別モデル
// 〈LatentSync/MuseTalk等〉は不要）。言語タグは自前でテキストから判定する
// （Geminiの自己判定に委ねず、looksJapanese() で確定させたものを明示的に
// 指示へ渡す — 誤判定でリップシンクが無音/別言語になるのを避けるため）。
function dialogueLanguageTag(text: string): string {
  return looksJapanese(text) ? "Japanese" : "English";
}

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

// 2026-09-14: 一度「各シーンの時間配分をプロンプトへ明示的に書き込む」
// (Scene N (0s-8s): ...) 方式を試したが、ホスト指摘により撤回した —
// MiniMax H3（および調査した限りWan2.2等も含め、この種の単発呼び出し動画
// 拡散モデル全般）はテキストプロンプト内のタイムスタンプを厳密に守る
// 仕組みを持たない。「時間指定できます」という誤った期待を持たせるのは
// 実測での不一致以上に問題（クレームの元）と判断し、単純な「順番のみ」の
// リストに戻した。本当に秒数を厳密に守らせたい場合は、1シーン=1回の
// 独立した生成に分けて Motion Context 系ノードで繋ぐ方式が必要
// （ComfyUI-H3-Motion-Context 等、コミュニティ実装あり）— 別途検討中。
// 2026-09-14: シーンごとに「明確な場面転換」か「同じ場面内の継続」かを
// ユーザーが選べるようにした（sceneChange フラグ、DirectorScene参照）。
// 先頭シーンは「直前」が無いため常に継続扱い（[CONTINUE]）。
function buildSceneDirectorPrompt(scenes: DirectorScene[], musicDirection?: string): string {
  const sceneLines = scenes
    .map((s, i) => {
      const marker = i === 0 || s.sceneChange === false ? "[CONTINUE]" : "[SCENE CHANGE]";
      const dialogue = s.dialogue?.trim();
      const dialogueNote = dialogue
        ? ` Dialogue spoken in this scene (wrap EXACTLY as <d>[${dialogueLanguageTag(dialogue)}]${dialogue}</d>, verbatim, do not translate or alter the text inside the tag): ${dialogue}`
        : "";
      return `${marker} Scene ${i + 1}: camera movement = ${directorCameraLabel(s.camera)}. Action: ${s.text}${dialogueNote}`;
    })
    .join("\n");
  const musicNote = musicDirection?.trim()
    ? [
        "",
        `Overall music / ambient sound direction for the whole video: ${musicDirection.trim()}`,
        "Weave this soundtrack direction naturally into the prompt (do not just append it verbatim as a separate sentence at the end).",
      ].join("\n")
    : "";
  return [
    "You are an expert cinematic video director.",
    "The user has provided a sequence of scenes with specific camera movements and actions.",
    "Combine them into a SINGLE, highly detailed, continuous English prompt optimized for a text-to-video model.",
    "Each scene is marked [SCENE CHANGE] or [CONTINUE] (relative to the scene right before it):",
    "- [SCENE CHANGE]: introduce it as a clear transition to a different moment or setting (e.g. \"Then, in a different moment,\" or \"The scene shifts to...\").",
    "- [CONTINUE]: treat it as a smooth continuation of the same shot/setting as the previous scene — do not introduce it as a new scene, just let the camera and action flow onward (e.g. \"and then\", \"as the camera continues\").",
    "Follow the given order from first to last. Include lighting and atmosphere.",
    "Preserve the subject's appearance, clothing, and identity exactly as shown in the reference image throughout every scene.",
    "Some scenes specify a Dialogue line: include that EXACT <d>[Language]...</d> tag (character count and all) at the natural point in that scene's description where the character speaks it — this is a literal syntax the video model requires for lip-synced speech, not a stylistic suggestion. Never invent dialogue for a scene that has none.",
    "Output ONLY the final English prompt text — no preamble, no scene labels, no [SCENE CHANGE]/[CONTINUE] markers, no quotes.",
    "",
    sceneLines,
    musicNote,
  ].join("\n");
}

/** シーン配列 → 1本の連続した英語プロンプト。Gemini が拒否/枯渇/輻輳した場合は
 * DirectorPromptError を投げる（呼び出し側は 502/429/503 等へマップする）。
 * musicDirection: 動画全体の音楽・環境音の指示（任意、2026-09-15追加）。 */
export async function expandDirectorScenes(scenes: DirectorScene[], musicDirection?: string): Promise<string> {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    throw new DirectorPromptError("AI 機能が未設定です（GEMINI_API_KEY 未設定）。", "not_configured");
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  try {
    const raw = await runGeminiText(genAI, buildSceneDirectorPrompt(scenes, musicDirection), false);
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
