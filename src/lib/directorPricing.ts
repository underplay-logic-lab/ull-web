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

export type DirectorScene = {
  camera: DirectorCameraMoveId;
  text: string;
};

/** タイムラインに追加できるシーン数。1本あたり15秒換算・最大60秒の実測上限
 * （[[cinematic-video-tab]] 参照）から逆算した4ブロック上限。 */
export const DIRECTOR_MIN_SCENES = 1;
export const DIRECTOR_MAX_SCENES = 4;
export const DIRECTOR_SCENE_TEXT_MAX_LENGTH = 200;

/** 1シーンあたりの尺（秒）。シーン数 × 15秒、実測済みの60秒で頭打ち。
 * プロンプトモードの最短尺クランプにも流用するため export する。 */
export const DIRECTOR_SECONDS_PER_SCENE = 15;
export const DIRECTOR_MAX_TOTAL_SECONDS = 60;

export function directorTotalDurationS(sceneCount: number): number {
  const n = Math.max(DIRECTOR_MIN_SCENES, Math.min(DIRECTOR_MAX_SCENES, Math.round(sceneCount || 0)));
  return Math.min(DIRECTOR_MAX_TOTAL_SECONDS, n * DIRECTOR_SECONDS_PER_SCENE);
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
  sceneCount: number;
  mode?: DirectorQualityMode;
  knobs?: PricingKnobs;
}): DirectorCostBreakdown {
  const knobs = args.knobs ?? DEFAULT_KNOBS;
  const mode = args.mode ?? "fast";
  const totalDurationS = directorTotalDurationS(args.sceneCount);
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

/** 尺不明時（見積り不能）の上限課金 — 最大シーン数・最大尺・最も高い
 * quality モードで計算（過小課金を避ける）。 */
export function directorCreditsWorstCase(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return directorCostBreakdown({ sceneCount: DIRECTOR_MAX_SCENES, mode: "quality", knobs }).credits;
}

/** Modal worker 側のポーリング上限秒（_run_workflow の poll_deadline_s）。
 * 実測: 60秒動画で Prompt実行 600s・elapsed 638.6s。安全マージンを乗せて
 * 動的に算出する（固定値のままだと今回のようにタイムアウト誤検知する）。 */
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
    cleaned.push({ camera, text });
  }
  return { ok: true, scenes: cleaned };
}
