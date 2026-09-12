// ULL Multi-Angle Studio — shared composition matrix, prompt builder and
// pricing. Imported from BOTH the client tab (live 構図数 / クレジット表示) and
// the API route (server-side re-derivation — the client's numbers are never
// trusted). No "server-only" guard.
//
// プロンプト規格は `fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA` の HF model
// card 公式フォーマットに準拠する:
//   "<sks> [azimuth] [elevation] [distance]"   ← スペース区切り・カンマなし
//   例: "<sks> right side view high-angle shot close-up"
// トリガートークン `<sks>` は Modal ワーカー側（_apply_lora_trigger、LoRA
// ロード時のみ）で前置するため、ここが生成するのは記述子部分だけ。
// 記述子は model card の厳密表記に一致させること（"quarter view" / "close-up"
// に " shot" を付けない 等、ズレると LoRA が発火しない）。
// 「azimuth = 被写体のどちら側が見えるか」（"right side view" は被写体の右側）。
// 2026-09-08 の CLI 実写で `<sks> right side view eye-level shot medium shot` 等が
// model card どおり正しく機能することを確認済み（左右反転なし）。
// 3 軸マトリクス（直積）で構図を展開する構造は据え置き。

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";

// 2026-09-09: turbo(35)/pro(40) の 2 モードは廃止。35 と 40 の差は誤差なうえ
// 課金が 1C/2C と乖離していた → **40 ステップ単一モード**に統一。`AngleMode` 型は
// 既存の payload/DB 互換のため 1 値だけ残す。単価は `angle_pro_per_angle` knob を
// そのまま流用（legacy `angle_turbo_per_angle` は未使用のまま残置）。
export type AngleMode = "standard";

// `creditsPerAngle` は /api/studio/pricing 応答前のフォールバック表示。実値は
// admin 編集可能な `angle_pro_per_angle` knob（angleCreditsPerAngle 経由）。
export const ANGLE_MODES: Record<
  AngleMode,
  { id: AngleMode; label: string; sublabel: string; steps: number; creditsPerAngle: number }
> = {
  standard: { id: "standard", label: "アングル生成", sublabel: "40ステップ", steps: 40, creditsPerAngle: 2 },
};

const ANGLE_STEPS = 40;

export function isAngleMode(v: unknown): v is AngleMode {
  // 旧 "turbo" / "pro" もここへ吸収（route 側で "standard" に丸める）。
  return v === "standard" || v === "turbo" || v === "pro";
}

export function angleModeSteps(): number {
  return ANGLE_STEPS;
}

// Multi-Reference（Pro）: メイン参照 1 枚に加えて、死角補完用のサブ参照画像
// （背面ラフ・衣装パーツ・テクスチャ等）を最大 3 枚まで同時に渡せる。
// Qwen-Image-Edit-2511 のネイティブ複数画像入力を使う。合計上限は 4 枚
// （ワーカー側 MAX_REF_IMAGES と一致させること）。
export const MAX_SUB_REFERENCE_IMAGES = 3;

// 1 構図あたりの生成時間の概算（秒・B300・warm）。実測: サブ 0 枚 ~20s /
// サブ 3 枚 ~61s（per-step がサブ枚数にほぼ線形）。ジョブ全体の所要見積り
// （UI 表示用）と、ワーカー側 Modal timeout の妥当性確認に使う。
export function angleSecondsPerAngle(subImageCount = 0): number {
  const n = Math.max(0, Math.min(MAX_SUB_REFERENCE_IMAGES, Math.trunc(subImageCount || 0)));
  return 20 + 14 * n;
}

// ジョブ全体のおおよその生成時間（秒）。コールドスタート + 初回 warmup の
// 一過性コスト（~約8分）は含めない純生成ぶん。
export function angleEstimatedSeconds(angleCount: number, subImageCount = 0): number {
  return Math.max(0, Math.trunc(angleCount || 0)) * angleSecondsPerAngle(subImageCount);
}

// 構図数の上限はサブ参照の有無に関わらず撤廃（原価の歯止めは「枚数」ではなく
// 「時間」——課金が枚数連動、ワーカーの Modal timeout がジョブ単位で
// max_allowed_time + マージンにスケールし、二重ウォッチドッグが守る）。
// 旧 MAX_ANGLES_WITH_SUBREFS（サブ参照ありは 48 に固定）は 2026-09-10 撤廃。

// Multi-Reference（Pro）: サブ参照 1 枚ごとに生成コスト（＝時間）が線形に増える
// （B300 実測: サブ3枚で per-構図 時間 ×3.0）。per-構図 の消費クレジットにも
// 同じ係数を乗せて原価割れを防ぐ。係数 = 1 + knob × clamp(サブ枚数, 0..3)。
export function angleRefMultiplier(
  subImageCount: number,
  knobs: PricingKnobs = DEFAULT_KNOBS,
): number {
  const n = Math.max(0, Math.min(MAX_SUB_REFERENCE_IMAGES, Math.trunc(subImageCount || 0)));
  return 1 + knobs.angle_ref_multiplier_per_sub * n;
}

export function angleCreditsPerAngle(
  knobs: PricingKnobs = DEFAULT_KNOBS,
  subImageCount = 0,
): number {
  return Math.ceil(knobs.angle_pro_per_angle * angleRefMultiplier(subImageCount, knobs));
}

// 構図数の上限は撤廃（無限スケール）。原価の歯止めは「枚数」ではなく「時間」——
// API が消費クレジットから max_allowed_time を算出し、Modal ワーカーの二重
// ウォッチドッグ（フリーズ検知 / 原価割れ損切り）が守る。名目値だけ残置。
export const MAX_ANGLES = 9999;

// 最低構図数。1〜2 構図だとコールドスタート（初回ロード + 起動後 30 秒の
// scaledown 待機）が償却されず原価割れするため、3 構図から（2026-09-09）。
// 全プリセットが 3 構図以上なので実質の制約にはならない。
export const MIN_ANGLES = 3;

// ---------------------------------------------------------------------------
// 2511 Multi-Angle LoRA 確定プロンプト定義（公式フォーマット）
// ---------------------------------------------------------------------------
// LoRA トリガートークン。ワーカーの ANGLE_LORA_TRIGGER 既定と一致させること。
export const ANGLE_LORA_TRIGGER = "<sks>";

// サブ参照を 1 枚以上渡したとき、ワーカーがカメラ指示プロンプトの文末へ
// 付け足す英文（実体は modal_angle_worker.py の ANGLE_MULTIREF_PROMPT_SUFFIX が
// 正。ここは参照用）:
//   "Maintaining exact features, lengths, and texture details from all
//    provided reference images."

// azimuth（水平方位）: 45/135/225/315° は "quarter view"（"view" だけだと発火弱）。
export const CAMERA_AZIMUTH = {
  FRONT: "front view",
  FRONT_RIGHT: "front-right quarter view",
  RIGHT_PROFILE: "right side view",
  BACK_RIGHT: "back-right quarter view",
  BACK: "back view",
  BACK_LEFT: "back-left quarter view",
  LEFT_PROFILE: "left side view",
  FRONT_LEFT: "front-left quarter view",
} as const;

// elevation（仰角）: model card の 4 値のみ（-30 / 0 / 30 / 60°）。
export const CAMERA_ELEVATION = {
  LOW_ANGLE: "low-angle shot",
  EYE_LEVEL: "eye-level shot",
  ELEVATED: "elevated shot",
  HIGH_ANGLE: "high-angle shot",
} as const;

// distance（距離）: close-up は " shot" を付けない（model card 表記）。
export const CAMERA_DISTANCE = {
  CLOSE_UP: "close-up",
  MEDIUM: "medium shot",
  WIDE: "wide shot",
} as const;

/**
 * 2511 Multi-Angle LoRA の構図プロンプトを model card 公式フォーマットで
 * 組み立てる（`<sks>` トリガー + スペース区切り、elevation / distance は既定値で
 * 補完）。外部呼び出し・単発生成・ドキュメント用。
 * マトリクス経由の生成は buildAngleCombos → buildInstruction を通り、そちらは
 * `<sks>` を付けず（ワーカーが前置）、未選択の軸の記述子を省く。
 */
export function build2511AnglePrompt(
  azimuth: keyof typeof CAMERA_AZIMUTH,
  elevation: keyof typeof CAMERA_ELEVATION = "EYE_LEVEL",
  distance: keyof typeof CAMERA_DISTANCE = "MEDIUM",
): string {
  return `${ANGLE_LORA_TRIGGER} ${CAMERA_AZIMUTH[azimuth]} ${CAMERA_ELEVATION[elevation]} ${CAMERA_DISTANCE[distance]}`;
}

export type AngleAxisOption = {
  id: string;
  /** 日本語ラベル（UI 表示） */
  label: string;
  /** 生成プロンプトに差し込む英語フレーズ（2511 LoRA 公式表記） */
  en: string;
};

// --- 水平方位（Azimuth / 被写体のどちら側が見えるか） -----------------------
export const AZIMUTH_OPTIONS: AngleAxisOption[] = [
  { id: "front", label: "正面（0°）", en: CAMERA_AZIMUTH.FRONT },
  { id: "front_right", label: "右斜め前（45°）", en: CAMERA_AZIMUTH.FRONT_RIGHT },
  { id: "right_profile", label: "真横・右（90°）", en: CAMERA_AZIMUTH.RIGHT_PROFILE },
  { id: "back_right", label: "右斜め後ろ（135°）", en: CAMERA_AZIMUTH.BACK_RIGHT },
  { id: "back", label: "真後ろ（180°）", en: CAMERA_AZIMUTH.BACK },
  { id: "back_left", label: "左斜め後ろ（225°）", en: CAMERA_AZIMUTH.BACK_LEFT },
  { id: "left_profile", label: "真横・左（270°）", en: CAMERA_AZIMUTH.LEFT_PROFILE },
  { id: "front_left", label: "左斜め前（315°）", en: CAMERA_AZIMUTH.FRONT_LEFT },
];

// --- 仰角（Elevation / カメラの高さ、model card の 4 値） -------------------
export const ELEVATION_OPTIONS: AngleAxisOption[] = [
  { id: "low_angle", label: "アオリ（-30°）", en: CAMERA_ELEVATION.LOW_ANGLE },
  { id: "eye_level", label: "水平（0°）", en: CAMERA_ELEVATION.EYE_LEVEL },
  { id: "elevated", label: "やや俯瞰（30°）", en: CAMERA_ELEVATION.ELEVATED },
  { id: "high_angle", label: "フカン（60°）", en: CAMERA_ELEVATION.HIGH_ANGLE },
];

// --- 距離（Distance / フレーミング） --------------------------------------
export const DISTANCE_OPTIONS: AngleAxisOption[] = [
  { id: "close_up", label: "顔アップ（×0.6）", en: CAMERA_DISTANCE.CLOSE_UP },
  { id: "medium", label: "バストアップ（×1.0）", en: CAMERA_DISTANCE.MEDIUM },
  { id: "wide", label: "全身（×1.8）", en: CAMERA_DISTANCE.WIDE },
];

export type AngleAxis = "azimuths" | "elevations" | "distances";

export type AngleSelection = {
  azimuths: string[];
  elevations: string[];
  distances: string[];
};

export const EMPTY_ANGLE_SELECTION: AngleSelection = {
  azimuths: [],
  elevations: [],
  distances: [],
};

const OPTIONS_BY_AXIS: Record<AngleAxis, AngleAxisOption[]> = {
  azimuths: AZIMUTH_OPTIONS,
  elevations: ELEVATION_OPTIONS,
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
  /** Modal ワーカーへ渡す英語の編集指示 1 行（2511 LoRA 規格） */
  instruction: string;
  /** この 1 構図だけを再現する最小 selection（個別リロール用） */
  selection: AngleSelection;
};

/**
 * 2511 Multi-Angle LoRA 規格の instruction 記述子部分を組み立てる。
 * 選択された軸のフレーズだけを "azimuth elevation distance" の順で**スペース**
 * 結合する（未選択の軸は省く＝その軸は元画像のまま）。`<sks>` トリガーは
 * ワーカー側（_apply_lora_trigger）が前置する。
 *   例: (right_profile, eye_level, medium) -> "right side view eye-level shot medium shot"
 *       (back, -, -)                        -> "back view"
 */
function buildInstruction(
  a: AngleAxisOption | undefined,
  e: AngleAxisOption | undefined,
  d: AngleAxisOption | undefined,
): string {
  return [a?.en, e?.en, d?.en].filter(Boolean).join(" ");
}

/**
 * 選択された 3 軸の直積を「構図」の配列に展開する。
 * 未選択の軸は「元のまま（変更なし）」= 1 バリアントとして扱い、その軸の
 * プロンプト節を省く。全軸未選択なら空配列（＝生成不可）。
 */
export function buildAngleCombos(selection: AngleSelection): AngleCombo[] {
  const as = orderedPick("azimuths", selection.azimuths);
  const es = orderedPick("elevations", selection.elevations);
  const ds = orderedPick("distances", selection.distances);

  if (as.length === 0 && es.length === 0 && ds.length === 0) return [];

  const aList: (AngleAxisOption | undefined)[] = as.length ? as : [undefined];
  const eList: (AngleAxisOption | undefined)[] = es.length ? es : [undefined];
  const dList: (AngleAxisOption | undefined)[] = ds.length ? ds : [undefined];

  const combos: AngleCombo[] = [];
  for (const a of aList) {
    for (const e of eList) {
      for (const d of dList) {
        const parts = [a, e, d].filter(Boolean) as AngleAxisOption[];
        combos.push({
          key: `${a?.id ?? "-"}|${e?.id ?? "-"}|${d?.id ?? "-"}`,
          labelJa: parts.map((p) => p.label).join("・"),
          slug: parts.map((p) => p.id).join("-") || "angle",
          instruction: buildInstruction(a, e, d),
          selection: {
            azimuths: a ? [a.id] : [],
            elevations: e ? [e.id] : [],
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

// 顔クロップだと「体のシルエット」が画面に無く、この方位への大角度回転がほぼ
// 効かない（2026-09-09 実機）。正面〜斜め前は close-up でも軽い振り向きが可能。
const HARD_AZIMUTHS_FOR_CLOSEUP = new Set([
  "right_profile",
  "back_right",
  "back",
  "back_left",
  "left_profile",
]);

/**
 * 「回転がほぼ効かない組み合わせ」を選んだときの警告文（無ければ null）。
 * close-up 自体は LoRA 素材として重要（顔がメインで学習される）。問題なのは
 * 「close-up 単独 × 真横/背面系の方位」の組み合わせだけ。
 */
export function angleSelectionWarning(selection: AngleSelection): string | null {
  const d = selection.distances;
  const closeUpOnly = d.includes("close_up") && !d.includes("medium") && !d.includes("wide");
  const hasHardAzimuth = selection.azimuths.some((a) => HARD_AZIMUTHS_FOR_CLOSEUP.has(a));
  if (closeUpOnly && hasHardAzimuth) {
    return "顔アップ（クローズアップ）だと真横・背面への回転はほぼ効きません。真横・背面は「バストアップ」か「全身」を選び、顔アップは正面〜斜め前に絞ってください。";
  }

  const e = selection.elevations;
  const noEyeLevel = e.length > 0 && !e.includes("eye_level");
  if (selection.azimuths.length >= 3 && noEyeLevel) {
    return "アオリ／フカンのみだと大角度の回転が弱くなりがちです。「水平（0°）」も併せて選ぶと安定します。";
  }
  return null;
}

export function isAngleSelectionEmpty(selection: AngleSelection): boolean {
  return (
    selection.azimuths.length === 0 &&
    selection.elevations.length === 0 &&
    selection.distances.length === 0
  );
}

export function angleGenerationCost(
  selection: AngleSelection,
  knobs: PricingKnobs = DEFAULT_KNOBS,
  subImageCount = 0,
): number {
  return angleSelectionCount(selection) * angleCreditsPerAngle(knobs, subImageCount);
}

// --- クイックプリセット -------------------------------------------------
export type AnglePreset = { id: string; label: string; hint: string; selection: AngleSelection };

const allIds = (opts: AngleAxisOption[]) => opts.map((o) => o.id);

export const ANGLE_PRESETS: AnglePreset[] = [
  {
    id: "turnaround3",
    label: "三面図",
    hint: "正面・真横・真後ろ / 水平・ミディアム",
    selection: {
      azimuths: ["front", "right_profile", "back"],
      elevations: ["eye_level"],
      distances: ["medium"],
    },
  },
  {
    id: "turnaround8",
    label: "8方向ターンアラウンド",
    hint: "全方位 / 水平・バストアップ",
    selection: {
      azimuths: allIds(AZIMUTH_OPTIONS),
      elevations: ["eye_level"],
      distances: ["medium"],
    },
  },
  {
    id: "face_set",
    label: "顔アップ集（LoRA向け）",
    hint: "正面・斜め前 / 水平 / 顔アップ・バストアップ",
    selection: {
      azimuths: ["front", "front_right", "front_left"],
      elevations: ["eye_level"],
      distances: ["close_up", "medium"],
    },
  },
  {
    id: "elevation_compare",
    label: "仰角比較",
    hint: "正面 / 水平・アオリ・フカン・俯瞰",
    selection: {
      azimuths: ["front"],
      elevations: allIds(ELEVATION_OPTIONS),
      distances: ["medium"],
    },
  },
  {
    id: "distance_set",
    label: "寄り引き3種",
    hint: "正面 / クローズアップ・ミディアム・ワイド",
    selection: {
      azimuths: ["front"],
      elevations: ["eye_level"],
      distances: allIds(DISTANCE_OPTIONS),
    },
  },
  {
    id: "select_all",
    label: "全選択",
    hint: "全方位 × 水平・アオリ・フカン / ワイド",
    selection: {
      azimuths: allIds(AZIMUTH_OPTIONS),
      elevations: ["eye_level", "low_angle", "high_angle"],
      distances: ["wide"],
    },
  },
];
