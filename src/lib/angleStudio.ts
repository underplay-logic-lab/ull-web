// ULL Multi-Angle Studio — shared composition matrix, prompt builder and
// pricing. Imported from BOTH the client tab (live 構図数 / クレジット表示) and
// the API route (server-side re-derivation — the client's numbers are never
// trusted). No "server-only" guard, same posture as gpuWarm.ts.

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";

export type AngleMode = "turbo" | "pro";

// `creditsPerAngle` here is the hardcoded fallback shown before
// /api/studio/pricing responds; the live value is the admin-editable
// angle_{turbo,pro}_per_angle knob — always price through
// angleCreditsPerAngle(mode, knobs).
export const ANGLE_MODES: Record<
  AngleMode,
  { id: AngleMode; label: string; sublabel: string; steps: number; creditsPerAngle: number }
> = {
  turbo: { id: "turbo", label: "🚀 Turbo", sublabel: "高速 / 8ステップ", steps: 8, creditsPerAngle: 1 },
  pro: { id: "pro", label: "💎 Pro", sublabel: "高精細 / 40ステップ", steps: 40, creditsPerAngle: 2 },
};

const ANGLE_MODE_KNOB: Record<AngleMode, "angle_turbo_per_angle" | "angle_pro_per_angle"> = {
  turbo: "angle_turbo_per_angle",
  pro: "angle_pro_per_angle",
};

export function isAngleMode(v: unknown): v is AngleMode {
  return v === "turbo" || v === "pro";
}

export function angleModeSteps(mode: AngleMode): number {
  return ANGLE_MODES[mode].steps;
}

export function angleCreditsPerAngle(mode: AngleMode, knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return knobs[ANGLE_MODE_KNOB[mode]];
}

// 構図数の上限は撤廃（無限スケール）。原価の歯止めは「枚数」ではなく「時間」——
// API が消費クレジットから max_allowed_time を算出し、Modal ワーカーの二重
// ウォッチドッグ（フリーズ検知 / 原価割れ損切り）が守る。名目値だけ残置。
export const MAX_ANGLES = 9999;

export type AngleAxisOption = {
  id: string;
  /** 日本語ラベル（UI 表示） */
  label: string;
  /** 生成プロンプトに差し込む英語フレーズ */
  en: string;
};

// --- 向き（体・顔の向き） -------------------------------------------------
export const ORIENTATION_OPTIONS: AngleAxisOption[] = [
  { id: "front", label: "正面", en: "a front-facing view" },
  { id: "three_quarter", label: "3/4 斜め", en: "a 3/4 turned view" },
  { id: "profile_left", label: "真横（左）", en: "a left-side profile view" },
  { id: "profile_right", label: "真横（右）", en: "a right-side profile view" },
  { id: "looking_back", label: "見返り", en: "a looking-back-over-the-shoulder view" },
  { id: "back", label: "真後ろ", en: "a full rear (back) view" },
];

// --- アングル（カメラの高さ） -------------------------------------------
export const CAMERA_ANGLE_OPTIONS: AngleAxisOption[] = [
  { id: "eye_level", label: "水平（アイレベル）", en: "eye level" },
  { id: "low_angle", label: "アオリ（ローアングル）", en: "a low angle looking up" },
  { id: "high_angle", label: "フカン（ハイアングル）", en: "a high angle looking down" },
];

// --- 距離（画角・フレーミング） ----------------------------------------
export const DISTANCE_OPTIONS: AngleAxisOption[] = [
  { id: "face", label: "顔アップ", en: "a tight close-up of the face" },
  { id: "bust_up", label: "バストアップ", en: "a bust-up shot from the waist up" },
  { id: "full_body", label: "全身", en: "a full-body shot" },
];

export type AngleAxis = "orientations" | "cameraAngles" | "distances";

export type AngleSelection = {
  orientations: string[];
  cameraAngles: string[];
  distances: string[];
};

export const EMPTY_ANGLE_SELECTION: AngleSelection = {
  orientations: [],
  cameraAngles: [],
  distances: [],
};

const OPTIONS_BY_AXIS: Record<AngleAxis, AngleAxisOption[]> = {
  orientations: ORIENTATION_OPTIONS,
  cameraAngles: CAMERA_ANGLE_OPTIONS,
  distances: DISTANCE_OPTIONS,
};

function orderedPick(axis: AngleAxis, ids: string[]): AngleAxisOption[] {
  const set = new Set(ids);
  return OPTIONS_BY_AXIS[axis].filter((o) => set.has(o.id));
}

export type AngleCombo = {
  /** 安定キー（順序に依存しない） */
  key: string;
  /** 「正面・水平・全身」形式の日本語ラベル */
  labelJa: string;
  /** ファイル名などに使う ASCII スラッグ */
  slug: string;
  /** Modal ワーカーへ渡す英語の編集指示 1 行 */
  instruction: string;
  /** この 1 構図だけを再現する最小 selection（個別リロール用） */
  selection: AngleSelection;
};

function buildInstruction(
  o: AngleAxisOption | undefined,
  c: AngleAxisOption | undefined,
  d: AngleAxisOption | undefined,
): string {
  const clauses: string[] = [];
  if (o) clauses.push(`to ${o.en}`);
  if (c) clauses.push(`shot at ${c.en}`);
  if (d) clauses.push(`framed as ${d.en}`);
  const body = clauses.join(", ");
  return (
    `Change the camera angle ${body}. ` +
    "Keep the exact same character, face, hairstyle, outfit, colors and art style — " +
    "only change the viewing angle and framing. Do not alter the character's identity."
  );
}

/**
 * 選択された 3 軸の直積を「構図」の配列に展開する。
 * 未選択の軸は「元のまま（変更なし）」= 1 バリアントとして扱い、その軸の
 * プロンプト節を省く。全軸未選択なら空配列（＝生成不可）。
 */
export function buildAngleCombos(selection: AngleSelection): AngleCombo[] {
  const os = orderedPick("orientations", selection.orientations);
  const cs = orderedPick("cameraAngles", selection.cameraAngles);
  const ds = orderedPick("distances", selection.distances);

  if (os.length === 0 && cs.length === 0 && ds.length === 0) return [];

  const oList: (AngleAxisOption | undefined)[] = os.length ? os : [undefined];
  const cList: (AngleAxisOption | undefined)[] = cs.length ? cs : [undefined];
  const dList: (AngleAxisOption | undefined)[] = ds.length ? ds : [undefined];

  const combos: AngleCombo[] = [];
  for (const o of oList) {
    for (const c of cList) {
      for (const d of dList) {
        const parts = [o, c, d].filter(Boolean) as AngleAxisOption[];
        combos.push({
          key: `${o?.id ?? "-"}|${c?.id ?? "-"}|${d?.id ?? "-"}`,
          labelJa: parts.map((p) => p.label).join("・"),
          slug: parts.map((p) => p.id).join("-") || "angle",
          instruction: buildInstruction(o, c, d),
          selection: {
            orientations: o ? [o.id] : [],
            cameraAngles: c ? [c.id] : [],
            distances: d ? [d.id] : [],
          },
        });
      }
    }
  }
  return combos;
}

export function angleSelectionCount(selection: AngleSelection): number {
  return buildAngleCombos(selection).length;
}

export function isAngleSelectionEmpty(selection: AngleSelection): boolean {
  return (
    selection.orientations.length === 0 &&
    selection.cameraAngles.length === 0 &&
    selection.distances.length === 0
  );
}

export function angleGenerationCost(
  selection: AngleSelection,
  mode: AngleMode,
  knobs: PricingKnobs = DEFAULT_KNOBS,
): number {
  return angleSelectionCount(selection) * angleCreditsPerAngle(mode, knobs);
}

// --- クイックプリセット -------------------------------------------------
export type AnglePreset = { id: string; label: string; hint: string; selection: AngleSelection };

const allIds = (opts: AngleAxisOption[]) => opts.map((o) => o.id);

export const ANGLE_PRESETS: AnglePreset[] = [
  {
    id: "turnaround3",
    label: "三面図",
    hint: "正面・真横・真後ろ / 全身",
    selection: {
      orientations: ["front", "profile_right", "back"],
      cameraAngles: ["eye_level"],
      distances: ["full_body"],
    },
  },
  {
    id: "turnaround6",
    label: "6方向ターンアラウンド",
    hint: "全方向 / 全身",
    selection: {
      orientations: allIds(ORIENTATION_OPTIONS),
      cameraAngles: ["eye_level"],
      distances: ["full_body"],
    },
  },
  {
    id: "angle_compare",
    label: "アングル比較",
    hint: "正面 / 水平・アオリ・フカン",
    selection: {
      orientations: ["front"],
      cameraAngles: allIds(CAMERA_ANGLE_OPTIONS),
      distances: ["bust_up"],
    },
  },
  {
    id: "distance_set",
    label: "寄り引き3種",
    hint: "正面 / 顔・バスト・全身",
    selection: {
      orientations: ["front"],
      cameraAngles: ["eye_level"],
      distances: allIds(DISTANCE_OPTIONS),
    },
  },
  {
    id: "select_all",
    label: "全選択",
    hint: "全方向 × 全アングル / 全身",
    selection: {
      orientations: allIds(ORIENTATION_OPTIONS),
      cameraAngles: allIds(CAMERA_ANGLE_OPTIONS),
      distances: ["full_body"],
    },
  },
];
