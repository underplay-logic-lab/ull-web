// ULL Cinematic Director: タイムライン型（複数シーン）の動画生成。
// SeedVR2 の超解像/Multi-Angle と違い、生成そのものは「シネマティック
// スタジオ」（廃止済みタブ、[[cinematic-video-tab]]）が使っていた自己ホスト
// MiniMax H3（modal_wan_animate_blackwell.py）をそのまま流用する — 外部API
// は使わない（CLAUDE.md §1: Blackwell GPU 自己ホストが差別化点）。
//
// 2026-09-13 実機確認: 15/30/60秒すべて単発生成で成功（VRAM 155〜158GB、
// ほぼフラット）。2026-09-09 postmortem の「尺が長いとクラッシュする」は
// 誤診断で、真因は解像度側のパッチ化端数バグだった（cinematicPricing.ts の
// floorTo16 コメント参照）。よってチャンク分割・Latent継承等の複雑な改造は
// 不要 — 複数シーンを1本の連続プロンプトに合成し、単発の MiniMax H3 呼び出し
// に渡すだけで成立する。

import { DEFAULT_KNOBS, type KnobKey, type PricingKnobs } from "@/lib/pricing/knobDefaults";

export const DIRECTOR_CAMERA_MOVES = [
  { id: "push_in", label: "Push in（寄る）", en: "a slow, smooth camera push-in" },
  { id: "pull_out", label: "Pull out（引く）", en: "a slow, smooth camera pull-out" },
  { id: "pan_right", label: "Pan right（右へ）", en: "a smooth camera pan to the right" },
  { id: "pan_left", label: "Pan left（左へ）", en: "a smooth camera pan to the left" },
  { id: "tilt_up", label: "Tilt up（上へ）", en: "a smooth camera tilt upward" },
  { id: "tilt_down", label: "Tilt down（下へ）", en: "a smooth camera tilt downward" },
  { id: "static", label: "Static（固定）", en: "a static, locked-off camera" },
] as const;

export type DirectorCameraMoveId = (typeof DIRECTOR_CAMERA_MOVES)[number]["id"];

export function isDirectorCameraMoveId(value: unknown): value is DirectorCameraMoveId {
  return DIRECTOR_CAMERA_MOVES.some((c) => c.id === value);
}

export function directorCameraLabel(id: string): string {
  return DIRECTOR_CAMERA_MOVES.find((c) => c.id === id)?.en ?? "a slow, smooth camera push-in";
}

/** 2026-09-14: シーンごとに秒数（時間配分）を持てるようにした
 * （時間軸ベースのシーン制御）。以前は「1シーン=15秒固定」で、Geminiに
 * 渡すプロンプトにも各シーンの時間情報が一切乗っていなかったため、60秒
 * ×4シーンのような長尺で「指示が終わって同じ動作の繰り返しになる」実障害
 * があった。durationS を明示的に持たせ、Gemini合成プロンプトにも
 * 「0〜8秒はX、8〜15秒はY」の形で反映する（directorPrompt.ts参照）。
 * 注意: MiniMax H3自体にタイムスタンプで厳密に条件付けする仕組みは無いため、
 * これは「モデルが従いやすくなるヒント」であって100%の保証ではない。 */
export type DirectorScene = {
  camera: DirectorCameraMoveId;
  text: string;
  durationS: number;
};

/** タイムラインに追加できるシーン数。60秒の実測上限（[[cinematic-video-tab]]
 * 参照）を、より細かい時間配分で埋められるよう上限を引き上げた
 * （旧: 15秒固定×4個 -> 新: 可変秒数×最大8個）。 */
export const DIRECTOR_MIN_SCENES = 1;
export const DIRECTOR_MAX_SCENES = 8;
export const DIRECTOR_SCENE_TEXT_MAX_LENGTH = 200;

/** 1シーンあたりの秒数の許容範囲。下限は「モデルがアクションを1つ描写する
 * のに最低限必要な尺」の目安、上限は「1シーンに尺を寄せすぎて実質単一シーン
 * 化するのを防ぐ」ための緩いガード。 */
export const DIRECTOR_MIN_SCENE_DURATION_S = 3;
export const DIRECTOR_MAX_SCENE_DURATION_S = 30;
/** 新規シーン追加時の初期値・プロンプトモードの最短尺クランプに流用。 */
export const DIRECTOR_SECONDS_PER_SCENE = 15;
export const DIRECTOR_MAX_TOTAL_SECONDS = 60;

export function directorTotalDurationS(scenes: { durationS: number }[]): number {
  const sum = scenes.reduce((acc, s) => acc + Math.max(0, Math.round(s.durationS || 0)), 0);
  return Math.min(DIRECTOR_MAX_TOTAL_SECONDS, Math.max(DIRECTOR_MIN_SCENE_DURATION_S, sum));
}

export type DirectorCostBreakdown = {
  credits: number;
  totalDurationS: number;
  perSecond: number;
};

/** Director の画質モード。VDN-H3導入(2026-09-13/14)に伴い、旧 speed 固定を
 * やめてユーザーが選べるようにした。fast=8step蒸留(無音)・quality=50step
 * 非蒸留(音声あり) — cinematicPricing.ts の CINEMATIC_MODE_BY_ID.vdnFast /
 * .vdnQuality に対応。 */
export type DirectorQualityMode = "fast" | "quality";

export function isDirectorQualityMode(value: unknown): value is DirectorQualityMode {
  return value === "fast" || value === "quality";
}

const DIRECTOR_PER_SECOND_KNOB: Record<DirectorQualityMode, KnobKey> = {
  fast: "director_per_second_fast",
  quality: "director_per_second_quality",
};

function directorPerSecond(mode: DirectorQualityMode, knobs: PricingKnobs): number {
  return knobs[DIRECTOR_PER_SECOND_KNOB[mode]];
}

export function directorCostBreakdown(args: {
  scenes: { durationS: number }[];
  mode?: DirectorQualityMode;
  knobs?: PricingKnobs;
}): DirectorCostBreakdown {
  const knobs = args.knobs ?? DEFAULT_KNOBS;
  const mode = args.mode ?? "fast";
  const totalDurationS = directorTotalDurationS(args.scenes);
  const perSecond = directorPerSecond(mode, knobs);
  const raw = Math.ceil(perSecond * totalDurationS);
  const floor = Math.max(1, Math.round(knobs.director_min_credits));
  return { credits: Math.max(floor, raw), totalDurationS, perSecond };
}

/** プロンプトモード（シーンビルダーを介さず、合成済みプロンプトを直接編集して
 * 再生成する経路）用。シーン数の概念がないため、尺(秒)を直接クランプして
 * 計算する。式自体は directorCostBreakdown と同一。 */
export function directorCostBreakdownForDuration(args: {
  totalDurationS: number;
  mode?: DirectorQualityMode;
  knobs?: PricingKnobs;
}): DirectorCostBreakdown {
  const knobs = args.knobs ?? DEFAULT_KNOBS;
  const mode = args.mode ?? "fast";
  const totalDurationS = Math.min(
    DIRECTOR_MAX_TOTAL_SECONDS,
    Math.max(DIRECTOR_SECONDS_PER_SCENE, Math.round(args.totalDurationS || 0)),
  );
  const perSecond = directorPerSecond(mode, knobs);
  const raw = Math.ceil(perSecond * totalDurationS);
  const floor = Math.max(1, Math.round(knobs.director_min_credits));
  return { credits: Math.max(floor, raw), totalDurationS, perSecond };
}

/** 尺不明時（見積り不能）の上限課金 — 最大尺・最も高い quality モードで計算
 * （過小課金を避ける）。 */
export function directorCreditsWorstCase(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return directorCostBreakdownForDuration({
    totalDurationS: DIRECTOR_MAX_TOTAL_SECONDS,
    mode: "quality",
    knobs,
  }).credits;
}

/** modal_wan_animate_blackwell.py の _run_workflow が ComfyUI の完了を待つ
 * ポーリング上限（秒）。2026-09-14 実測（480x864・8/50step、VDN-H3）を基に
 * 「多めに設定する」方針（CLAUDE.md §0 — 短いタイムアウトで暴走を止められた
 * 実績が一度もない一方、正常進行中のジョブを誤って失敗判定したことは複数回
 * ある）で、実測値の約1.7倍を秒あたり単価として尺に比例させる。
 * fast: 実測26.4s/video-sec -> 40s/video-sec。quality: 実測45.4s/video-sec
 * -> 68s/video-sec。Modal関数自体のハードタイムアウト(7200s)より必ず小さく
 * 収まるよう上限3600sでクランプ。 */
export function directorPollDeadlineS(totalDurationS: number, mode: DirectorQualityMode = "fast"): number {
  const secPerVideoSec = mode === "quality" ? 68 : 40;
  return Math.min(3600, Math.max(300, Math.round(totalDurationS * secPerVideoSec) + 200));
}

export function validateDirectorScenes(scenes: unknown): { ok: true; scenes: DirectorScene[] } | { ok: false; error: string } {
  if (!Array.isArray(scenes) || scenes.length < DIRECTOR_MIN_SCENES) {
    return { ok: false, error: "少なくとも1つのシーンを追加してください。" };
  }
  if (scenes.length > DIRECTOR_MAX_SCENES) {
    return { ok: false, error: `シーンは最大${DIRECTOR_MAX_SCENES}個までです。` };
  }
  const cleaned: DirectorScene[] = [];
  for (const raw of scenes) {
    const camera = isDirectorCameraMoveId((raw as { camera?: unknown })?.camera)
      ? (raw as { camera: DirectorCameraMoveId }).camera
      : "push_in";
    const textRaw = (raw as { text?: unknown })?.text;
    const text = typeof textRaw === "string" ? textRaw.trim().slice(0, DIRECTOR_SCENE_TEXT_MAX_LENGTH) : "";
    if (!text) {
      return { ok: false, error: "各シーンにアイデア（テキスト）を入力してください。" };
    }
    const durationRaw = (raw as { durationS?: unknown })?.durationS;
    const durationS = Math.min(
      DIRECTOR_MAX_SCENE_DURATION_S,
      Math.max(DIRECTOR_MIN_SCENE_DURATION_S, Math.round(Number(durationRaw) || DIRECTOR_SECONDS_PER_SCENE)),
    );
    cleaned.push({ camera, text, durationS });
  }
  if (directorTotalDurationS(cleaned) < cleaned.reduce((acc, s) => acc + s.durationS, 0)) {
    return { ok: false, error: `合計尺は最大${DIRECTOR_MAX_TOTAL_SECONDS}秒までです。` };
  }
  return { ok: true, scenes: cleaned };
}
