// 曲づくり（2026-10-06）の料金と上限。フロント表示と route で同じ関数を使う。
// 原価 3.0×（ローンチ価格の標準）。L40S（¥331/h）実測・100 秒の曲: 1 曲 24 秒 ≒ ¥2.2 → ×3 ≒ 4C、
// 1 回ごとの起動・読み込み 約 55 秒 ≒ ¥5 → ×3 ≒ 9C（docs/STATUS.md）。単価は knob（/admin の Pricing）。

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";
import { parallelSurcharge } from "@/lib/pricing/parallelSurcharge";

/** 1 回の曲数（ホスト判断: 最低 3 曲・何曲でも。上限は待ち時間 約 5 分の 10 曲）。 */
export const SONG_MIN_COUNT = 3;
export const SONG_MAX_COUNT = 10;
export function clampSongCount(count: unknown): number {
  const n = typeof count === "number" && Number.isFinite(count) ? Math.floor(count) : SONG_MIN_COUNT;
  return Math.max(SONG_MIN_COUNT, Math.min(SONG_MAX_COUNT, n));
}

/**
 * 曲の長さ＝何番まで（2026-10-06 ホスト判断: 1 番でも 2 番でも 3 番でも、作り直しを見込んだ料金と時間を承知で選べる）。
 * 長いほど「声が入らない」外れが増える（2 番の構成で 6 回中 4 回がハミングだけ・声なし）ので、1 曲の単価に作り直しの見込みを含める。
 * minutes は 1 回あたりの作曲時間の目安（L40S 実測: 100 秒の曲 20 秒・230 秒の曲 43 秒）× 作り直しの見込み。
 */
export const SONG_PARTS = [
  { id: 1, label: "1 番だけ", length: "約 1 分半", minutesPerSong: 0.5 },
  { id: 2, label: "2 番まで", length: "約 4 分", minutesPerSong: 1.5 },
  { id: 3, label: "3 番まで", length: "約 5〜6 分", minutesPerSong: 2.7 },
] as const;
export type SongParts = (typeof SONG_PARTS)[number]["id"];
export function clampSongParts(v: unknown): SongParts {
  return v === 2 || v === 3 ? v : 1;
}
/** 手書きの歌詞は行数で長さを決める（構成のタグの行は数えない）。 */
export function songPartsFromLyrics(lyrics: string): SongParts {
  const n = lyrics.split("\n").filter((l) => l.trim() && !l.trim().startsWith("[")).length;
  return n <= 10 ? 1 : n <= 20 ? 2 : 3;
}

export const SONG_IDEA_MAX_LENGTH = 600;
export const SONG_LYRICS_MAX_LENGTH = 1500;
export const SONG_STYLE_MAX_LENGTH = 300;

/** 声（タグに足す英語）。 */
export const SONG_VOICES = [
  { id: "female", label: "女性ボーカル", tag: "clear young Japanese female vocals" },
  { id: "male", label: "男性ボーカル", tag: "warm Japanese male vocals" },
] as const;
export type SongVoiceId = (typeof SONG_VOICES)[number]["id"];
export function isSongVoiceId(v: unknown): v is SongVoiceId {
  return SONG_VOICES.some((x) => x.id === v);
}

export function songPerTrackCredits(parts: SongParts, knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return parts === 3 ? knobs.song_per_track_credits_3 : parts === 2 ? knobs.song_per_track_credits_2 : knobs.song_per_track_credits;
}

export function songCredits(count: number, parts: SongParts = 1, knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.ceil(knobs.song_base_credits + songPerTrackCredits(parts, knobs) * clampSongCount(count));
}

export function songPriorityParallelSurcharge(knobs: PricingKnobs = DEFAULT_KNOBS, baseCost = 0): number {
  return parallelSurcharge(baseCost, knobs.song_priority_parallel_rate, knobs.song_priority_parallel_surcharge);
}
