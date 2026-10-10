// 画風を変える（構図そのまま・2026-10-10・許可制 restyle_trial）の選択肢と料金。フロント表示と route で同じ関数を使う。
// 単価は knob（/admin の Pricing）。根拠は knobDefaults.ts の restyle_* のコメント。

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";
import { parallelSurcharge } from "@/lib/pricing/parallelSurcharge";

export type RestyleStyleId = "anime" | "manga" | "free";
export type RestyleKeepId = "strong" | "medium" | "loose";

/** 画風。prompt はワーカーで元画像を言語化する AI に渡す画風の説明（英語）。free は利用者の文をそのまま使う。 */
export const RESTYLE_STYLES: { id: RestyleStyleId; label: string; sub: string; prompt: string }[] = [
  { id: "anime", label: "アニメ", sub: "線画＋アニメ塗り", prompt: "a Japanese anime illustration with clean line art and soft cel shading" },
  {
    id: "manga",
    label: "白黒漫画",
    sub: "ペン線＋スクリーントーン",
    prompt: "a black and white Japanese manga drawing with ink lines and screentone, monochrome only, no color at all",
  },
  { id: "free", label: "自由に書く", sub: "画風を文章で指定", prompt: "" },
];

/** 元の形をどれだけ残すか（線画の ControlNet の強さと、生成のどこまで効かせるか）。2026-10-10 手元の実測で決めた。 */
export const RESTYLE_KEEPS: { id: RestyleKeepId; label: string; sub: string; strength: number; end: number }[] = [
  { id: "strong", label: "しっかり", sub: "形をほぼそのまま", strength: 0.8, end: 0.65 },
  { id: "medium", label: "ほどほど", sub: "配置は保って描き直す", strength: 0.6, end: 0.5 },
  { id: "loose", label: "ゆるく", sub: "雰囲気だけ借りる", strength: 0.45, end: 0.35 },
];

export const RESTYLE_COUNTS = [1, 2, 4] as const;
export type RestyleCount = (typeof RESTYLE_COUNTS)[number];
export const RESTYLE_FREE_STYLE_MAX = 300;

export function isRestyleStyle(v: unknown): v is RestyleStyleId {
  return typeof v === "string" && RESTYLE_STYLES.some((s) => s.id === v);
}
export function isRestyleKeep(v: unknown): v is RestyleKeepId {
  return typeof v === "string" && RESTYLE_KEEPS.some((k) => k.id === v);
}
export function clampRestyleCount(v: unknown): RestyleCount {
  const n = Number(v);
  return (RESTYLE_COUNTS as readonly number[]).includes(n) ? (n as RestyleCount) : 1;
}

/** 出力の縦横（元画像の縦横比のまま約 1.6MP・16 の倍数・長辺 2048 まで）。Qwen-Image の得意な大きさ（1328×1328 ≒ 1.76MP）に合わせる。 */
export function restyleOutputDims(inW: number, inH: number): { width: number; height: number } {
  const w0 = Math.max(1, inW || 1024);
  const h0 = Math.max(1, inH || 1024);
  let s = Math.sqrt(1_600_000 / (w0 * h0));
  s = Math.min(s, 2048 / Math.max(w0, h0));
  const r16 = (v: number) => Math.max(256, Math.round(v / 16) * 16);
  return { width: r16(w0 * s), height: r16(h0 * s) };
}

/** 料金 = 1 回の基本料（起動・読み込み＋言語化＋待機 30 秒）＋ 1 枚ごと × 枚数（他の機能と同じ形・原価 × 3）。 */
export function restyleCredits(count: number, knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.ceil(knobs.restyle_base_credits + knobs.restyle_per_image_credits * clampRestyleCount(count));
}

export function restylePriorityParallelSurcharge(knobs: PricingKnobs = DEFAULT_KNOBS, baseCost = 0): number {
  return parallelSurcharge(baseCost, knobs.restyle_priority_parallel_rate, knobs.restyle_priority_parallel_surcharge);
}
