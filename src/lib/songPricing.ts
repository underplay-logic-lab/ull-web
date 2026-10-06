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

export function songCredits(count: number, knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.ceil(knobs.song_base_credits + knobs.song_per_track_credits * clampSongCount(count));
}

export function songPriorityParallelSurcharge(knobs: PricingKnobs = DEFAULT_KNOBS, baseCost = 0): number {
  return parallelSurcharge(baseCost, knobs.song_priority_parallel_rate, knobs.song_priority_parallel_surcharge);
}
