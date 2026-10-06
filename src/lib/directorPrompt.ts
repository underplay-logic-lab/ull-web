import "server-only";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { geminiApiKey, isSafetyRefusal, runGeminiText, type GemErr } from "@/lib/geminiText";
import {
  directorCameraLabel,
  type DirectorRefRole,
  type DirectorRefVideoRole,
  type DirectorScene,
} from "@/lib/directorPricing";
import { looksLikeRefusal } from "@/lib/llmRefusal";

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
// フォールバックは未実装だったが、2026-09-18 に「Advanced」モードとして
// 実装した（Gemini拒否時の静かなフォールバックではなく、ユーザーが明示的に
// 選ぶ独立モード）。ただし実装場所はこのファイルではなく
// modal_wan_animate_blackwell.py 側（WanAnimateBlackwell._generate_director_script）
// —— 動画生成と同じB300コンテナ内で実行し、二重コールドスタートを避けるため。
// Next.js側は conceptText と qwenPromptNodeId を spawnDirectorJob に渡すだけで、
// 台本そのものの生成はワーカー側が行う（route.ts参照）。
// refusal を検知したら DirectorPromptError を投げ、呼び出し側はユーザーに
// その旨を案内する。
export class DirectorPromptError extends Error {
  constructor(
    message: string,
    public readonly reason: "refusal" | "quota" | "busy" | "failed" | "not_configured",
  ) {
    super(message);
    this.name = "DirectorPromptError";
  }
}

// 応答冒頭の断り文の検知は src/lib/llmRefusal.ts（Gemini 共通処理でも同じ判定を使う）。

// Gemini に断られたときの代わり（2026-10-01）: 同じ指示文を、動画生成と同じ GPU コンテナ内の Qwen（abliterated＝断らない
// 調整）に渡して合成させる。日本語訳も同じ生成で書かせ、"===JA===" の後ろに置かせる（Advanced モードの台本生成と同じ書式。
// ワーカー側が分割して combined_prompt / combined_prompt_ja へ書き戻す）。
export function withJapaneseTranslationRequest(instruction: string): string {
  return [
    instruction,
    "",
    "After the English prompt, output a line containing only ===JA=== and then a natural, fluent Japanese translation of that English prompt (for the user to read). Output nothing else.",
  ].join("\n");
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
/** 持ち込み音声（歌・セリフ、2026-10-05）。尺は音声の長さ。 */
export type DirectorSoundtrack = { durationS: number };

// 持ち込み音声があるときの書き方（D:\ComfyUI-ull\prod_hinata_mv_68s_v3.json で確かめた書き方）:
// 時間ごとの演出を「ショット」「シーン」と書くとカットが入る（v2 は 68 秒で 4 回）。「1 台のカメラの長回し・カット無し」と
// 宣言し、前の動きから続ける文で書くと 0 回になった（ffmpeg scdet）。音声はそのまま使うので、別のセリフや音楽を足させない。
const ONE_TAKE_OPENING = (durationS: number) =>
  `One continuous unbroken take filmed with a single moving camera: no cuts, no edits, no scene changes, no transitions from the first frame to the last, about ${Math.round(durationS)} seconds long.`;
const SOUNDTRACK_RULE =
  "The soundtrack (music and/or voice) is given and must not change; the character's lips move exactly in sync with the vocals and stay closed when there are no vocals.";

export function soundtrackInstruction(soundtrack: DirectorSoundtrack): string {
  return [
    `IMPORTANT: The audio for this video is supplied by the user as a ${Math.round(soundtrack.durationS)}-second recording (a song or a spoken voice) and is used as-is.`,
    `- Start the prompt with exactly this sentence: "${ONE_TAKE_OPENING(soundtrack.durationS)}"`,
    `- Then include this sentence: "${SOUNDTRACK_RULE}"`,
    "- Describe everything as ONE continuous camera move. Never write \"shot\", \"scene\", \"cut to\" or \"then, in a different moment\"; describe each change as continuing from the previous motion (\"continuing without any cut\", \"the same camera glides...\"). Keep the same location throughout.",
    "- You may give rough timings (\"around 20 seconds\") for changes in movement or expression.",
    "- Do NOT add dialogue tags, invented lines, background music or sound-effect descriptions — the supplied audio is the only sound.",
  ].join("\n");
}

/** 顔写真として参照するモード（2026-10-05）。画像は最初のフレームではないので、構図・場所は自由に書かせる。 */
export const REFERENCE_MODE_NOTE =
  "IMPORTANT: The reference image is NOT the first frame of the video. It is an identity reference called <Picture 1>. Refer to the person as \"the person from <Picture 1>\" (same face, hairstyle and features); the composition, pose, framing and setting are free to follow the user's idea. " +
  // 2026-10-06 夜: 書き手の AI は参照を見ていないので、アニメ・2.5 次元の参照でも実写の言葉を足して実写に寄せていた。
  "You cannot see <Picture 1>: it may be a photo, anime, an illustration or anything in between. Unless the user asks for a specific style, " +
  "do not write words about medium or realism (photo, photorealistic, realistic, live-action, anime, illustration, skin pores, 3D render) — the model keeps the look of <Picture 1> by itself.";

/** 参照モードで足した素材の使い方（2026-10-06）。台本 AI に番号と役目を教え、場所・持ち物・手本を台本に織り込ませる。 */
export type DirectorReferenceSummary = {
  /** 2 枚目以降の写真の使い方（<Picture 2> から順に）。 */
  roles?: DirectorRefRole[];
  videoRole?: DirectorRefVideoRole;
  voice?: boolean;
};

export function referenceModeNote(refs: DirectorReferenceSummary = {}): string {
  const lines = [REFERENCE_MODE_NOTE];
  const roleText: Record<DirectorRefRole, string> = {
    person: "another photo of the same person (use it only to keep the identity)",
    item: "an object the character has or uses — make it appear exactly as shown",
    place: "the location — set the video in exactly this place",
    style: "the art style — draw the whole video in this style",
  };
  (refs.roles ?? []).forEach((r, i) => lines.push(`- <Picture ${i + 2}> is ${roleText[r]}.`));
  if (refs.videoRole === "motion") {
    lines.push("- <Video 1> is a motion reference: the character copies the body movements of the person in <Video 1>; never take that person's face, clothes or the room from <Video 1>.");
  } else if (refs.videoRole === "camera") {
    lines.push("- <Video 1> is a camera reference: copy only its camera movement; nothing else from <Video 1> appears.");
  }
  if (refs.voice) lines.push("- <Audio 1> is a voice reference: whenever the character speaks or sings, it is in the voice of <Audio 1>.");
  if (lines.length > 1) lines.push("Mention each of these references by its exact tag (e.g. <Picture 3>) where it matters in the prompt.");
  return lines.join("\n");
}

export type DirectorPromptOptions = {
  soundtrack?: DirectorSoundtrack;
  referenceMode?: boolean;
  /** 参照モードの素材の使い方（referenceMode のときだけ見る）。 */
  references?: DirectorReferenceSummary;
};

/** おまかせ（ワーカーの Qwen が台本を書く）用: 思いつきの後ろに足す注記。ワーカーを変えずに同じ書き方をさせる。 */
export function withConceptNotes(conceptText: string, opts: DirectorPromptOptions): string {
  const notes = [
    ...(opts.soundtrack ? [soundtrackInstruction(opts.soundtrack)] : []),
    ...(opts.referenceMode ? [referenceModeNote(opts.references)] : []),
  ];
  return notes.length ? `${conceptText}\n\n${notes.join("\n\n")}` : conceptText;
}

/** 直接書くモード用: 長回しの宣言と音声の扱いが無ければ先頭に足す。 */
export function withSoundtrackAnchor(prompt: string, soundtrack: DirectorSoundtrack): string {
  const parts: string[] = [];
  if (!/continuous (unbroken )?take|no cuts/i.test(prompt)) parts.push(ONE_TAKE_OPENING(soundtrack.durationS));
  if (!/in sync with the (vocals|voice|audio)|lip[- ]?sync/i.test(prompt)) parts.push(SOUNDTRACK_RULE);
  return parts.length ? `${parts.join(" ")} ${prompt}` : prompt;
}

export function buildSceneDirectorPrompt(
  scenes: DirectorScene[],
  musicDirection?: string,
  opts: DirectorPromptOptions = {},
): string {
  const { soundtrack } = opts;
  const sceneLines = scenes
    .map((s, i) => {
      // 音声を持ち込んだときは 1 本の長回しにする（場面転換を書くとカットが入る）。
      const marker = i === 0 || s.sceneChange === false || soundtrack ? "[CONTINUE]" : "[SCENE CHANGE]";
      const dialogue = s.dialogue?.trim();
      const dialogueNote = dialogue
        ? ` Dialogue spoken in this scene (wrap as <d>[${dialogueLanguageTag(dialogue)}]...</d> at the point where it's spoken — do not translate it; see the readability exception below for Japanese lines): ${dialogue}`
        : "";
      return `${marker} Scene ${i + 1}: camera movement = ${directorCameraLabel(s.camera)}. Action: ${s.text}${dialogueNote}`;
    })
    .join("\n");
  const musicNote = musicDirection?.trim() && !soundtrack
    ? [
        "",
        `Overall music / ambient sound direction for the whole video: ${musicDirection.trim()}`,
        "Weave this soundtrack direction naturally into the prompt (do not just append it verbatim as a separate sentence at the end).",
      ].join("\n")
    : "";
  return [
    "You are an expert cinematic video director.",
    "The user has provided a sequence of scenes with specific camera movements and actions.",
    ...(soundtrack ? ["", soundtrackInstruction(soundtrack), ""] : []),
    ...(opts.referenceMode ? [referenceModeNote(opts.references), ""] : []),
    "Combine them into a SINGLE, highly detailed, continuous English prompt optimized for a text-to-video model.",
    "Each scene is marked [SCENE CHANGE] or [CONTINUE] (relative to the scene right before it):",
    "- [SCENE CHANGE]: introduce it as a clear transition to a different moment or setting (e.g. \"Then, in a different moment,\" or \"The scene shifts to...\").",
    "- [CONTINUE]: treat it as a smooth continuation of the same shot/setting as the previous scene — do not introduce it as a new scene, just let the camera and action flow onward (e.g. \"and then\", \"as the camera continues\").",
    "Follow the given order from first to last. Include lighting and atmosphere.",
    "Preserve the subject's appearance, clothing, and identity exactly as shown in the reference image throughout every scene.",
    "Some scenes specify a Dialogue line: include that <d>[Language]...</d> tag at the natural point in that scene's description where the character speaks it — this is a literal syntax the video model requires for lip-synced speech, not a stylistic suggestion. Never invent dialogue for a scene that has none, and never change the actual wording or meaning of a given dialogue line.",
    // 2026-09-19: 「セリフの読み間違いが目立つ・全部ひらがなだとイントネーションが
    // 崩れる」というホスト報告を受けて追加。単語ごとに判断させる（全文ひらがな化
    // は禁止）——固有名詞・稀な漢字の読みだけを狙い撃ちする、一般的な日本語TTS
    // の定石と同じアプローチ。
    "Readability exception for Japanese dialogue only: within the exact words of a Japanese dialogue line, you may rewrite an individual word into hiragana if it is prone to being misread by the video model's speech engine (a rare kanji reading, an ambiguous compound, an uncommon proper noun) — but leave ordinary, easily-read words in their natural kanji form. Do NOT rewrite the whole line into hiragana (this flattens natural pitch accent and sounds worse, not better) and do NOT change the actual words or meaning — only the kanji-vs-hiragana choice for specific hard-to-read words.",
    "Output ONLY the final English prompt text — no preamble, no scene labels, no [SCENE CHANGE]/[CONTINUE] markers, no quotes.",
    "",
    sceneLines,
    musicNote,
  ].join("\n");
}

/** シーン配列 → 1本の連続した英語プロンプト。Gemini が拒否/枯渇/輻輳した場合は
 * DirectorPromptError を投げる（呼び出し側は 502/429/503 等へマップする）。
 * musicDirection: 動画全体の音楽・環境音の指示（任意、2026-09-15追加）。 */
export async function expandDirectorScenes(
  scenes: DirectorScene[],
  musicDirection?: string,
  opts: DirectorPromptOptions = {},
): Promise<string> {
  return runDirectorPromptGemini(buildSceneDirectorPrompt(scenes, musicDirection, opts), "director_prompt");
}

/**
 * Photo Director（2026-10-06）: 日本語の思いつき → 静止画 1 枚の英語プロンプトを書かせる指示文。
 * 書き出しは本番 B300 で確かめた静止画プロンプト（D:\ComfyUI-ull\results\prod\a_test\wf_still_bf16_*.json）と同じ。
 * 動画モデルを 5 フレームだけ回すので「動き」を書かせない（ブレ・途中のポーズになる）。
 */
// 2026-10-06 夜: "photograph" をやめて中立な "still image" に。書き出しが「写真」だと、アニメ・2.5 次元の参照でも実写に寄った
// （ホスト報告）。プロンプトを書く AI（Gemini・Qwen）は参照を見ていないので、絵柄は言葉にせず参照を見ている H3 に任せる。
export const PHOTO_PROMPT_OPENING = "A single high-quality still image, perfectly still, sharp focus.";
/** 2026-10-06 夜までの書き出し（前のジョブのプロンプトを英語のまま直したときに二重に付けないため）。 */
const PHOTO_PROMPT_OPENING_LEGACY = "A single high-quality photograph, perfectly still, sharp focus.";
/** 絵柄の指定が無いときに入れる一文（PHOTO_PROMPT_OPENING の直後）。 */
export const PHOTO_SAME_STYLE_SENTENCE = "Same art style, rendering and texture as <Picture 1>.";
/**
 * 絵柄「アニメ・イラスト」を選んだときに必ず入れる一文（2026-10-06 夜）。土台の 10Eros は実写寄りで、「同じ絵柄で」だけでは
 * アニメの参照でも実写になる。H200 試験でこの一文を入れると輪郭線と平塗りのアニメ寄りになった（実写の参照を足すと実写に戻る）。
 */
export const PHOTO_ANIME_SENTENCE =
  "Anime screencap, 2D cel shading, flat colors, clean black lineart, same art style as <Picture 1>; not a photo, not realistic.";
export type PhotoStyle = "match" | "anime";

/** 写真の絵柄の一文をそろえる（書き出しが無ければ足し、アニメなら「同じ絵柄で」を外してアニメの一文を書き出しの直後へ）。 */
export function withPhotoStyle(prompt: string, style: PhotoStyle): string {
  const p = withPhotoOpening(prompt);
  if (style !== "anime" || p.includes(PHOTO_ANIME_SENTENCE)) return p;
  const body = p.replace(PHOTO_SAME_STYLE_SENTENCE, "").trim();
  for (const opening of [PHOTO_PROMPT_OPENING, PHOTO_PROMPT_OPENING_LEGACY]) {
    if (body.startsWith(opening)) return `${opening}
${PHOTO_ANIME_SENTENCE}
${body.slice(opening.length).trim()}`;
  }
  return `${PHOTO_ANIME_SENTENCE}
${body}`;
}

export function buildPhotoPrompt(idea: string, refs: DirectorReferenceSummary = {}, style: PhotoStyle = "match"): string {
  return [
    "You are an expert visual director writing a prompt for an image model that is given reference pictures. You cannot see the pictures.",
    referenceModeNote(refs),
    "",
    "Write ONE English prompt for a single still image based on the user's idea below.",
    `- Start with exactly this sentence: "${PHOTO_PROMPT_OPENING}"`,
    "- Describe the framing (close-up, bust shot, full body...), pose, expression, clothing, location, lighting and mood as concrete visual details.",
    "- Describe a frozen moment: no camera movement, no actions that unfold over time, no sound, no dialogue.",
    "- Refer to the person as \"the person from <Picture 1>\" (or the woman / man from <Picture 1>) and keep the same face and hairstyle.",
    ...(style === "anime"
      ? [
          `- Art style: the user chose anime. Put exactly this sentence right after the first one: "${PHOTO_ANIME_SENTENCE}"`,
          "  and never use words that push toward a photo (photo, photograph, photorealistic, realistic, lens, skin pores, 3D render).",
        ]
      : [
          "- Art style: you cannot see <Picture 1>, so it may be a photo, anime, an illustration or anything in between. Unless the user's idea explicitly asks for a style",
          "  (e.g. anime, photorealistic, watercolor, oil painting), put exactly this sentence right after the first one: " + `"${PHOTO_SAME_STYLE_SENTENCE}"`,
          "  and never use words about medium or realism (photo, photograph, photorealistic, realistic, lens, anime, illustration, skin pores, 3D render).",
          "  If the user does ask for a style, describe that style instead and do not write that sentence.",
        ]),
    "- Keep it under 120 words. Output ONLY the prompt — no preamble, no quotes.",
    "",
    `User's idea (may be Japanese): ${idea}`,
  ].join("\n");
}

/** 編集して渡された写真のプロンプトに、静止画の書き出し（PHOTO_PROMPT_OPENING）が無ければ先頭に足す。 */
export function withPhotoOpening(prompt: string): string {
  return prompt.includes(PHOTO_PROMPT_OPENING) || prompt.includes(PHOTO_PROMPT_OPENING_LEGACY)
    ? prompt
    : `${PHOTO_PROMPT_OPENING} ${prompt}`;
}

export async function expandPhotoIdea(
  idea: string,
  refs: DirectorReferenceSummary = {},
  style: PhotoStyle = "match",
): Promise<string> {
  const out = await runDirectorPromptGemini(buildPhotoPrompt(idea, refs, style), "photo_prompt");
  return withPhotoStyle(out, style);
}

/** Gemini に指示文を渡して文章を受け取る（シーン合成・写真・曲づくりの歌詞の共通部分）。断り・枯渇は DirectorPromptError。 */
export async function runDirectorPromptGemini(instruction: string, feature: string): Promise<string> {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    throw new DirectorPromptError("AI 機能が未設定です（GEMINI_API_KEY 未設定）。", "not_configured");
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  try {
    const raw = await runGeminiText(genAI, instruction, false, { feature });
    const cleaned = raw.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    if (!cleaned) {
      throw new DirectorPromptError("プロンプトの合成に失敗しました（空の応答）。", "failed");
    }
    if (looksLikeRefusal(cleaned)) {
      throw new DirectorPromptError("AI がプロンプトの合成を断りました。", "refusal");
    }
    return cleaned;
  } catch (err) {
    if (err instanceof DirectorPromptError) throw err;
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
          ? "AI 処理が混み合っています。少し時間をおいて再試行してください。"
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
      { feature: "director_prompt" },
    );
    const cleaned = raw.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    // 断り文を「日本語訳」として画面に出さない。
    return cleaned && !looksLikeRefusal(cleaned) ? cleaned : null;
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

/**
 * セリフ（<d>…</d> の中）を除いて日本語があるか。英語の台本にセリフだけ日本語、という正しい書き方で
 * 全文を訳し直さないようにする（訳し直すと言い回しが全部変わり、<d>[Japanese]…</d> の言語指定まで落ちた。2026-10-02）。
 */
export function looksJapaneseOutsideDialogue(text: string): boolean {
  return looksJapanese(text.replace(/<d>[\s\S]*?<\/d>/g, ""));
}

// プロンプトモードは書かれた文章をそのまま使うので、「参照画像の人物のまま」という指示が無いことがある。
// 無いまま長い尺を作らせると、後半で別人に入れ替わった実例がある（2026-10-01、ジョブ 6d5b922f）。
// シーンモード（Gemini 合成）・Advanced（Qwen 台本）の文章には必ず入っているので、無いときだけ先頭に足す。
const IDENTITY_ANCHOR =
  "The person in the reference image remains exactly the same person, with the same face, hair and body, for the entire video, and is never replaced by a different person.";
const IDENTITY_HINT_RE = /reference image|same (person|identity|face)|identical|identity/i;

export function withIdentityAnchor(prompt: string): string {
  return IDENTITY_HINT_RE.test(prompt) ? prompt : `${IDENTITY_ANCHOR} ${prompt}`;
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
    const raw = await runGeminiText(genAI, buildJapaneseTranslationPrompt(japanesePrompt), false, {
      feature: "director_prompt",
    });
    const cleaned = raw.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    if (!cleaned) {
      throw new DirectorPromptError("プロンプトの翻訳に失敗しました（空の応答）。", "failed");
    }
    if (looksLikeRefusal(cleaned)) {
      throw new DirectorPromptError("AI がプロンプトの翻訳を断りました。", "refusal");
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
          ? "AI 処理が混み合っています。少し時間をおいて再試行してください。"
          : reason === "busy"
            ? "AI サービスが一時的に混雑しています。少し待って再試行してください。"
            : "プロンプトの翻訳に失敗しました。",
        reason,
      );
    }
    throw new DirectorPromptError("プロンプトの翻訳に失敗しました。", "failed");
  }
}

/**
 * 参照写真の指し方の揺れを、モデルが読むタグ <Picture N> にそろえる（2026-10-06）。画面のサムネには「Picture N」と出しているが、
 * 「picture2」「画像2」「2枚目の写真」などで書かれても効くように。N が写真の枚数を超えるもの・タグ以外の数字は触らない。
 */
export function normalizeReferenceTags(text: string, pictureCount: number): string {
  const tag = (n: string, whole: string) => (Number(n) >= 1 && Number(n) <= pictureCount ? `<Picture ${n}>` : whole);
  return text
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/<\s*picture\s*([1-9])\s*>|(?<![a-z])picture\s*([1-9])(?![0-9])/gi, (m, a, b) => tag(a ?? b, m))
    .replace(/(?:画像|写真)\s*([1-9])(?![0-9])/g, (m, n) => tag(n, m))
    .replace(/(?<![0-9])([1-9])\s*(?:枚目の(?:画像|写真)|枚目|の画像|の写真)/g, (m, n) => tag(n, m));
}

/** プロンプトモードの日本語 → 英語の指示文（Gemini に断られたときは同じ文を Qwen に渡す）。 */
export function buildJapaneseTranslationPrompt(japanesePrompt: string): string {
  return [
    "Translate the following Japanese video-generation prompt into natural, highly detailed English",
    "optimized for a text-to-video model. Preserve all specific details (camera movements, actions, timing).",
    "",
    // 2026-09-19: buildSceneDirectorPrompt（シーンで作るモード）と同じ
    // <d>[Language]...</d> 規約をここにも適用する。プロンプトモードは
    // シーンビルダーと違いセリフ専用の入力欄が無く、ユーザーはこの
    // タグの存在を知らずに普通の日本語文としてセリフを書く——それを
    // 気付かずまとめて英訳すると、動画モデルへ渡る時点でセリフが英語に
    // なってしまう（リップシンク自体も外れる）というバグがあったため
    // 追加（ホスト報告）。
    "If the prompt contains a line of dialogue that a character actually speaks out loud (e.g. text quoted with 「」or otherwise clearly spoken, such as a greeting or line of speech), do NOT translate that spoken line — keep its original Japanese words, and wrap it exactly as <d>[Japanese]...</d> at the point in the English prompt where the character speaks it. This is a literal syntax the video model requires for lip-synced speech, not a stylistic suggestion. Translate everything else (scene description, actions, camera direction, atmosphere) into English as normal. Never invent dialogue that isn't in the original prompt, and never change the actual wording or meaning of the dialogue line.",
    // 2026-09-19: buildSceneDirectorPromptに追加したのと同じ読みやすさの
    // 例外（全文ひらがな化は禁止・単語単位のみ）。
    "Readability exception: within that Japanese dialogue line's exact words, you may rewrite an individual word into hiragana if it is prone to being misread by the video model's speech engine (a rare kanji reading, an ambiguous compound, an uncommon proper noun) — but leave ordinary, easily-read words in their natural kanji form. Do NOT rewrite the whole line into hiragana (this flattens natural pitch accent and sounds worse, not better).",
    "Reference tags such as <Picture 1>, <Picture 2>, <Video 1> and <Audio 1> point at the input files: keep every one of them exactly as written (same angle brackets, word and number), at the matching place in the English prompt.",
    "Output ONLY the translated prompt (with any <d>[Japanese]...</d> tag embedded as described, if present) — no preamble, no extra quotes wrapping the whole output.",
    "",
    japanesePrompt,
  ].join("\n");
}
