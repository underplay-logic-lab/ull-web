// 素材づくり（2026-09-27、ホスト構想「1 枚の画像から LoRA 用の素材一式を集められる Studio」）。
//
// マルチアングルと同じ編集モデル・同じワーカー・同じ課金（angle_jobs）を使い、角度 LoRA のトリガーを
// 付けずに「ポーズ・場面・構図・向き」を文章で指示する。実測（docs/STATUS.md 2026-09-27）: 参照 3 枚で
// 「雪原を笑って走る」「椅子に座る」「街を歩く」がキャラを保ったまま出た。向きを書かないと後ろ姿になる
// ことがあるので、向きは必ず指示に入れる。
//
// 1 回の指定枚数を 8 枚ずつのジョブに分けて順に投げる（GPU の 1 ジョブの時間上限と、最初の 1 ジョブで
// 方向を確認してから残りを作る流れのため）。生成した画像を次の参照に使わない（ユーザーが確定した参照だけを
// 毎回使う）ので、枚数が増えてもずれが連鎖しない。

import { angleCreditsPerAngle } from "@/lib/angleStudio";
import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";

export type SceneChip = { id: string; label: string; en: string };

export const POSE_CHIPS: SceneChip[] = [
  { id: "standing", label: "立つ", en: "standing upright" },
  { id: "walking", label: "歩く", en: "walking" },
  { id: "running", label: "走る", en: "running" },
  { id: "sitting_chair", label: "椅子に座る", en: "sitting on a chair" },
  { id: "sitting_floor", label: "床に座る", en: "sitting on the floor" },
  { id: "arms_crossed", label: "腕組み", en: "standing with arms crossed" },
  { id: "waving", label: "手を振る", en: "waving one hand" },
  { id: "looking_back", label: "振り向く", en: "looking back over the shoulder" },
  { id: "jumping", label: "ジャンプ", en: "jumping in the air" },
  { id: "leaning", label: "壁にもたれる", en: "leaning against a wall" },
];

export const PLACE_CHIPS: SceneChip[] = [
  { id: "plain", label: "無地の背景", en: "against a plain white background" },
  { id: "room", label: "部屋", en: "in a cozy living room" },
  { id: "office", label: "オフィス", en: "in a modern office" },
  { id: "classroom", label: "教室", en: "in a school classroom" },
  { id: "cafe", label: "カフェ", en: "in a cafe" },
  { id: "street", label: "昼の街", en: "on a city street in the daytime" },
  { id: "night_street", label: "夜の街", en: "on a city street at night with neon lights" },
  { id: "park", label: "公園", en: "in a park with trees" },
  { id: "beach", label: "海辺", en: "on a sunny beach" },
  { id: "snow", label: "雪景色", en: "in a snowy field with snow falling" },
];

// 構図は文頭に置き、切れる位置と「写らないもの」を明記する（2026-09-27 初回実測: 文中の "upper body shot from the
// waist up" は 3/3 で全身になった。背景・ポーズは従ったので、構図の語だけ弱い）。
export const FRAMING_CHIPS: SceneChip[] = [
  { id: "full", label: "全身", en: "A full body shot showing the whole body from head to feet" },
  {
    id: "upper",
    label: "上半身",
    en: "A medium shot cropped at the waist, showing only the upper body (the legs and feet are outside the frame, the camera is close to the character)",
  },
  {
    id: "bust",
    label: "バストアップ",
    en: "A close-up bust shot cropped at the chest, showing only the head and shoulders (the camera is very close to the face)",
  },
];

export const VIEW_CHIPS: SceneChip[] = [
  { id: "front", label: "正面", en: "facing the viewer" },
  { id: "three_quarter", label: "斜め", en: "in a three-quarter view, turned slightly to the side" },
  { id: "side", label: "真横", en: "in profile view from the side" },
  { id: "back", label: "後ろ", en: "seen from behind" },
];

export type SceneAxis = "poses" | "places" | "framings" | "views";

export type SceneSelection = {
  poses: string[];
  places: string[];
  framings: string[];
  views: string[];
  /** 自分で足したポーズ・場面（日本語可）。指示に入った日本語は API 側で英訳する（2026-09-27）。 */
  customPoses: string[];
  customPlaces: string[];
  /** 服装の指定（任意・日本語可）。 */
  outfit: string;
  /** 自由記述（任意・日本語可）。 */
  extra: string;
};

// LoRA 素材の既定: 立つ・歩く・座る × 無地・部屋・街 × 全身・上半身 × 正面・斜め。
export const DEFAULT_SCENE_SELECTION: SceneSelection = {
  poses: ["standing", "walking", "sitting_chair"],
  places: ["plain", "room", "street"],
  framings: ["full", "upper"],
  views: ["front", "three_quarter"],
  customPoses: [],
  customPlaces: [],
  outfit: "",
  extra: "",
};

export const CHIPS_BY_AXIS: Record<SceneAxis, SceneChip[]> = {
  poses: POSE_CHIPS,
  places: PLACE_CHIPS,
  framings: FRAMING_CHIPS,
  views: VIEW_CHIPS,
};

/** 1 ジョブに入れる枚数。GPU の 1 ジョブの時間上限と「最初の 1 ジョブで確認」の単位。 */
export const SCENE_BATCH_SIZE = 8;
export const SCENE_DEFAULT_COUNT = 24;
export const SCENE_MAX_COUNT = 400;

export type ScenePlanItem = {
  key: string;
  framingId: string;
  viewId: string;
  /** 「何をどこで」の英語（チップから組み立てた既定）。 */
  bodyEn: string;
  /** 同じ内容の日本語（実行前の一覧に出す）。 */
  bodyJa: string;
  /** ユーザーが一覧で書き換えた内容（日本語可・API 側で英訳）。あれば bodyEn の代わりに使う。 */
  custom?: string;
};

const IDENTITY_EN = "Keep the same character with the identical face, hairstyle, body shape and clothing as the reference.";

function chip(axis: SceneAxis, id: string): SceneChip {
  return CHIPS_BY_AXIS[axis].find((c) => c.id === id) ?? CHIPS_BY_AXIS[axis][0];
}

/** ワーカーへ送る英語の指示（構図・向きを先頭に、本文、同一性の順）。本文が日本語なら API 側で英訳される。 */
export function scenePlanInstruction(item: ScenePlanItem): string {
  const framing = chip("framings", item.framingId);
  const view = chip("views", item.viewId);
  const body = (item.custom ?? "").trim() || item.bodyEn;
  return `${framing.en}, ${view.en}. ${body.replace(/[。.]\s*$/, "")}. ${IDENTITY_EN}`;
}

/** 一覧・結果のラベル（日本語）。 */
export function scenePlanLabel(item: ScenePlanItem): string {
  const framing = chip("framings", item.framingId);
  const view = chip("views", item.viewId);
  const body = (item.custom ?? "").trim() || item.bodyJa;
  return `${body}（${framing.label}・${view.label}）`;
}

/** 実行前の一覧に出す日本語の全文。 */
export function scenePlanPreviewJa(item: ScenePlanItem): string {
  const framing = chip("framings", item.framingId);
  const view = chip("views", item.viewId);
  return `${framing.label}・${view.label}で、${(item.custom ?? "").trim() || item.bodyJa}`;
}

function pick(axis: SceneAxis, ids: string[], custom: string[] = []): SceneChip[] {
  const set = new Set(ids);
  const fixed = CHIPS_BY_AXIS[axis].filter((c) => set.has(c.id));
  const extra = custom
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ id: `custom:${t}`, label: t, en: t }));
  return [...fixed, ...extra];
}

/**
 * 選んだチップの組み合わせを、ばらつきが早く出る順（各軸を回しながら）に並べて count 枚ぶん返す。
 * 組み合わせが count に足りなければ先頭から繰り返す（ワーカーは seed + index で散らすので同じ絵にはならない）。
 * 未選択の軸は既定（ポーズ=立つ／場所=無地／構図=全身／向き=正面）で埋める。
 */
export function buildScenePlan(sel: SceneSelection, count: number): ScenePlanItem[] {
  const n = Math.max(0, Math.min(SCENE_MAX_COUNT, Math.trunc(count || 0)));
  if (n === 0) return [];
  const poses = pick("poses", sel.poses, sel.customPoses ?? []);
  const places = pick("places", sel.places, sel.customPlaces ?? []);
  const framings = pick("framings", sel.framings);
  const views = pick("views", sel.views);
  const P = poses.length ? poses : [POSE_CHIPS[0]];
  const L = places.length ? places : [PLACE_CHIPS[0]];
  const F = framings.length ? framings : [FRAMING_CHIPS[0]];
  const V = views.length ? views : [VIEW_CHIPS[0]];
  const total = P.length * L.length * F.length * V.length;
  const outfit = sel.outfit.trim();
  const extra = sel.extra.trim();

  const items: ScenePlanItem[] = [];
  for (let i = 0; i < n; i++) {
    const k = i % total;
    // 隣り合う枚で違う軸が動くように、各軸を互いに素な歩幅で回す。
    const pose = P[k % P.length];
    const place = L[Math.floor(k / P.length) % L.length];
    const framing = F[(k + Math.floor(k / (P.length * L.length))) % F.length];
    const view = V[(Math.floor(k / F.length) + Math.floor(k / (P.length * L.length * F.length))) % V.length];
    const bodyEn = [`Make the character ${pose.en} ${place.en}`, outfit ? `wearing ${outfit}` : "", extra]
      .filter(Boolean)
      .join(", ");
    const bodyJa = [`${place.label}で${pose.label}`, outfit ? `服装: ${outfit}` : "", extra].filter(Boolean).join("、");
    items.push({
      key: `${i}:${pose.id}|${place.id}|${framing.id}|${view.id}`,
      framingId: framing.id,
      viewId: view.id,
      bodyEn,
      bodyJa,
    });
  }
  return items;
}

export function chunkPlan<T>(items: T[], size = SCENE_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 参照枚数に応じた 1 枚あたりのクレジット（マルチアングルと同じ単価・同じ係数）。 */
export function sceneCreditsPerImage(knobs: PricingKnobs = DEFAULT_KNOBS, subImageCount = 0): number {
  return angleCreditsPerAngle(knobs, subImageCount);
}

export function sceneTotalCredits(count: number, knobs: PricingKnobs = DEFAULT_KNOBS, subImageCount = 0): number {
  return Math.max(0, Math.trunc(count || 0)) * sceneCreditsPerImage(knobs, subImageCount);
}
