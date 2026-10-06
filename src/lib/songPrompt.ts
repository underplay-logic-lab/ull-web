import "server-only";
import { runDirectorPromptGemini, DirectorPromptError } from "@/lib/directorPrompt";
import { SONG_VOICES, type SongVoiceId } from "@/lib/songPricing";

// 曲づくり（2026-10-06）: 思いつき（または手書きの歌詞）から、歌詞・曲調のタグ・BPM・キーを Gemini に作らせる。
// 指針（docs/STATUS.md の試作から）:
//   - 歌詞は 8〜12 行・[Verse] / [Chorus] など構成つき（4 行・40 秒は歌の途中で時間切れ、8 行はまとまりが良かった）
//   - 1 行は 15 音前後まで
//   - 読み間違えやすい語だけかなへ（「屋上」を「やく…」と歌った。全部かなにすると抑揚が崩れるので語単位）
// 断られたら DirectorPromptError(reason "refusal")。曲づくりには制限なしの AI が無いので、画面は「歌詞を自分で書く」へ案内する。

export type SongPlan = {
  title: string;
  lyrics: string;
  tags: string;
  bpm: number;
  keyscale: string;
  language: string;
};

const KANA_RULE =
  "Readability: the singing model often misreads kanji. Rewrite only individual words that are hard to read (rare readings, ambiguous compounds, uncommon proper nouns) into hiragana; keep ordinary words in kanji. Never rewrite whole lines into hiragana.";

function voiceTag(voice: SongVoiceId): string {
  return SONG_VOICES.find((v) => v.id === voice)?.tag ?? SONG_VOICES[0].tag;
}

export function buildSongPlanPrompt(input: { idea?: string; lyrics?: string; style?: string; voice: SongVoiceId }): string {
  const hasLyrics = Boolean(input.lyrics?.trim());
  return [
    "You are a professional songwriter and producer preparing input for a text-to-music model that sings lyrics.",
    "Return ONLY one JSON object (no code fences, no comments) with these keys:",
    '{"title": string, "lyrics": string, "tags": string, "bpm": integer, "keyscale": string, "language": string}',
    "",
    hasLyrics
      ? [
          "The user wrote the lyrics. Keep every word and line exactly as written, in the same order.",
          "Only (1) add section tags such as [Intro], [Verse], [Chorus], [Bridge], [Outro] on their own lines if they are missing, and (2) apply the readability rule below.",
        ].join("\n")
      : [
          "Write original song lyrics from the user's idea.",
          "- Language: the language of the idea (Japanese if the idea is Japanese).",
          "- Structure: [Intro] (empty), then [Verse] 4 lines, [Chorus] 4 lines; for a longer song add [Verse] and [Chorus] again (8 to 12 sung lines in total), then [Outro] (empty).",
          "- Each line short and singable: about 15 syllables (morae) or fewer. Natural, emotional, concrete images; avoid clichés.",
          "- Do not use names of real artists or quote existing songs.",
        ].join("\n"),
    KANA_RULE,
    "",
    "tags: one English comma-separated list for the music model: genre, mood, main instruments, tempo feel, production, and the vocal.",
    `The vocal MUST be: ${voiceTag(input.voice)}. Do not mention real artists.`,
    "bpm: an integer between 70 and 160 that suits the song. keyscale: like \"G major\" or \"A minor\".",
    "language: ISO code of the lyrics, e.g. \"ja\" or \"en\".",
    "",
    input.style?.trim() ? `Desired style (may be Japanese, translate it into tags): ${input.style.trim()}` : "",
    hasLyrics ? `Lyrics:\n${input.lyrics!.trim()}` : `Idea (may be Japanese): ${input.idea?.trim() ?? ""}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function parsePlan(raw: string): SongPlan {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new DirectorPromptError("歌詞の作成に失敗しました（形式が不正）。", "failed");
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new DirectorPromptError("歌詞の作成に失敗しました（形式が不正）。", "failed");
  }
  const lyrics = typeof obj.lyrics === "string" ? obj.lyrics.trim() : "";
  const tags = typeof obj.tags === "string" ? obj.tags.trim() : "";
  if (!lyrics || !tags) throw new DirectorPromptError("歌詞の作成に失敗しました（空の応答）。", "failed");
  const bpmNum = typeof obj.bpm === "number" ? obj.bpm : Number(obj.bpm);
  return {
    title: typeof obj.title === "string" ? obj.title.trim().slice(0, 80) : "",
    lyrics,
    tags,
    bpm: Number.isFinite(bpmNum) ? Math.max(60, Math.min(180, Math.round(bpmNum))) : 120,
    keyscale: typeof obj.keyscale === "string" && /^[A-G][#b]? (major|minor)$/i.test(obj.keyscale.trim()) ? obj.keyscale.trim() : "C major",
    language: typeof obj.language === "string" && /^[a-z]{2}$/.test(obj.language.trim()) ? obj.language.trim() : "ja",
  };
}

export async function planSong(input: { idea?: string; lyrics?: string; style?: string; voice: SongVoiceId }): Promise<SongPlan> {
  const raw = await runDirectorPromptGemini(buildSongPlanPrompt(input), "song_plan");
  const plan = parsePlan(raw);
  // 声の指定は必ず入れる（Gemini が落とすことがある）。
  const vt = voiceTag(input.voice);
  if (!plan.tags.toLowerCase().includes(vt.toLowerCase())) plan.tags = `${plan.tags}, ${vt}`;
  return plan;
}
