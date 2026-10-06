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
import { parallelSurcharge } from "@/lib/pricing/parallelSurcharge";

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

/** 2026-09-14: シーンごとに秒数（合計尺・課金計算用）を持てるようにした。
 * 秒数自体はモデルへの厳密な時間指定ではない（directorPrompt.ts参照 —
 * タイムスタンプ方式は実機検証前に撤回済み）。
 *
 * sceneChange: このシーンの直前で「明確な場面転換」をGeminiに指示するか
 * どうか。true なら「別の瞬間・場面へ切り替わる」という強い転換として、
 * false なら「同じ場面の中でカメラだけ動く」という滑らかな継続として
 * 合成される。実機検証（2026-09-14）で、単純な順番リスト＋自然な繋ぎ言葉
 * だけでも実際にシーンが切り替わることを確認済みだが、切り替えの強さを
 * ユーザー側で明示的に制御したいというホスト要望により追加。先頭シーンは
 * 「直前」が無いため意味を持たない（UIでは非表示）。
 *
 * dialogue: このシーンでキャラクターが話す台詞（任意、2026-09-15追加）。
 * MiniMax H3 はプロンプト内に `<d>[言語]セリフ</d>` を埋め込むと台詞＋
 * リップシンクをネイティブに生成できる（別モデル不要 — 調査済み）ため、
 * シーンごとの台詞をここに持たせ directorPrompt.ts で合成時にこの構文へ
 * 変換する。言語はテキストから自動判定（looksJapanese）。 */
export type DirectorScene = {
  camera: DirectorCameraMoveId;
  text: string;
  durationS: number;
  sceneChange?: boolean;
  dialogue?: string;
};

/** タイムラインに追加できるシーン数。60秒の実測上限（[[cinematic-video-tab]]
 * 参照）を、より細かい時間配分で埋められるよう上限を引き上げた
 * （旧: 15秒固定×4個 -> 新: 可変秒数×最大8個）。 */
export const DIRECTOR_MIN_SCENES = 1;
export const DIRECTOR_MAX_SCENES = 8;
export const DIRECTOR_SCENE_TEXT_MAX_LENGTH = 200;
/** シーンごとの台詞の文字数上限（2026-09-15追加）。短い一言〜二言程度を
 * 想定 — 長すぎる台詞はMiniMax H3の口の動き生成が破綻しやすいため。 */
export const DIRECTOR_DIALOGUE_MAX_LENGTH = 120;
/** 動画全体に流す音楽・環境音の指示（任意、シーン単位ではなくグローバル
 * 1本、2026-09-15追加）。 */
export const DIRECTOR_MUSIC_MAX_LENGTH = 200;

/** 1シーンあたりの秒数の許容範囲。下限は「モデルがアクションを1つ描写する
 * のに最低限必要な尺」の目安、上限は「1シーンに尺を寄せすぎて実質単一シーン
 * 化するのを防ぐ」ための緩いガード。 */
export const DIRECTOR_MIN_SCENE_DURATION_S = 3;
export const DIRECTOR_MAX_SCENE_DURATION_S = 30;
/** 新規シーン追加時の初期値・プロンプトモードの最短尺クランプに流用。 */
export const DIRECTOR_SECONDS_PER_SCENE = 15;
export const DIRECTOR_MAX_TOTAL_SECONDS = 60;
/** 音声（歌・セリフ）を持ち込んだときの最長。尺は音声の長さに合わせる（2026-10-05、本番 B300 で 68 秒を 1 本で完走）。 */
export const DIRECTOR_MAX_AUDIO_SECONDS = 68;
/** 持ち込み音声のファイルサイズ上限（ワーカーへは base64 で送る。68 秒の 24bit WAV で約 20MB）。 */
export const DIRECTOR_AUDIO_MAX_BYTES = 40 * 1024 * 1024;

/** 参照のしかた（2026-10-05）。first_frame = 画像を最初のフレームにする（従来）、
 * reference = 顔写真として参照する（長尺でも顔を保てる・構図は自由）。 */
export type DirectorReferenceMode = "first_frame" | "reference";
export function isDirectorReferenceMode(value: unknown): value is DirectorReferenceMode {
  return value === "first_frame" || value === "reference";
}

/**
 * 参照写真（2 枚目以降）ごとの使い方（2026-10-06）。1 枚目は常に「人物」。
 * B300 実測（2026-10-05 夜・ゆきのぱすてる、docs/STATUS.md）: 持ち物（剣）はずっと参照どおりに手に持ち、
 * 場所は参照どおりの景色になり、別人の顔は混ざらなかった。
 */
export const DIRECTOR_REF_ROLES = [
  { id: "person", label: "同じ人物", hint: "角度・表情違い" },
  { id: "item", label: "持ち物", hint: "道具・服・小物" },
  { id: "place", label: "場所", hint: "背景・景色" },
  { id: "style", label: "画風", hint: "絵柄・色づかい" },
] as const;
export type DirectorRefRole = (typeof DIRECTOR_REF_ROLES)[number]["id"];
export function isDirectorRefRole(value: unknown): value is DirectorRefRole {
  return DIRECTOR_REF_ROLES.some((r) => r.id === value);
}

/** 参照動画の使い方（2026-10-06）。動き＝人の動きを写す／カメラ＝カメラの動きだけを写す。 */
export const DIRECTOR_REF_VIDEO_ROLES = [
  { id: "motion", label: "動きの手本", hint: "人の身ぶり・踊りを写す" },
  { id: "camera", label: "カメラの手本", hint: "カメラの動きだけを写す" },
] as const;
export type DirectorRefVideoRole = (typeof DIRECTOR_REF_VIDEO_ROLES)[number]["id"];
export function isDirectorRefVideoRole(value: unknown): value is DirectorRefVideoRole {
  return DIRECTOR_REF_VIDEO_ROLES.some((r) => r.id === value);
}
/** 参照動画の長さ（MiniMaxH3ReferenceToVideo の想定は 2〜15 秒。長い分はノードが切り詰める）。 */
export const DIRECTOR_REF_VIDEO_MIN_S = 2;
export const DIRECTOR_REF_VIDEO_MAX_S = 15;
export const DIRECTOR_REF_VIDEO_MAX_BYTES = 60 * 1024 * 1024;
/** 声の手本（2026-10-06）。数秒あれば足りる（実測は 5 秒）。持ち込み音声（歌・セリフ固定）とは併用しない。 */
export const DIRECTOR_REF_VOICE_MAX_S = 15;
export const DIRECTOR_REF_VOICE_MAX_BYTES = 10 * 1024 * 1024;
/** 参照モードの画面の縦横（first_frame は画像の縦横比で決まる）。 */
export const DIRECTOR_ASPECTS = [
  { id: "16:9", label: "横 16:9", ratio: 16 / 9 },
  { id: "9:16", label: "縦 9:16", ratio: 9 / 16 },
  { id: "1:1", label: "正方形", ratio: 1 },
  // 2026-10-06: Photo Director で追加（写真でよく使う比）。Director でもそのまま選べる。
  { id: "3:4", label: "縦 3:4", ratio: 3 / 4 },
  { id: "4:3", label: "横 4:3", ratio: 4 / 3 },
  { id: "image", label: "画像に合わせる", ratio: 0 },
] as const;
export type DirectorAspectId = (typeof DIRECTOR_ASPECTS)[number]["id"];
export function isDirectorAspectId(value: unknown): value is DirectorAspectId {
  return DIRECTOR_ASPECTS.some((a) => a.id === value);
}
/** 出力の縦横比を決める寸法（cinematicSafeDimensions に渡す）。 */
export function directorAspectDims(
  referenceMode: DirectorReferenceMode,
  aspect: DirectorAspectId,
  image: { width: number; height: number } | null | undefined,
): { width: number; height: number } {
  const a = DIRECTOR_ASPECTS.find((x) => x.id === aspect);
  // 比率だけを 1000 倍の整数で渡す。{ ratio, 1 } で渡すと cinematicSafeDimensions が各辺を「最低 1」に切り上げるため、
  // 縦長（9:16 = 0.5625×1・3:4）が正方形 1024×1024 になっていた（2026-10-06 発覚・横長は無事）。
  if (referenceMode === "reference" && a && a.ratio > 0) return { width: Math.round(a.ratio * 1000), height: 1000 };
  return { width: image?.width || 1, height: image?.height || 1 };
}

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
  // 上限は音声を持ち込んだときの 68 秒。音声なしの 60 秒は呼び出し側（route・尺の選択肢）で抑える
  // （68 秒の音声入り動画を作り直すとき、画面の表示と課金がずれないように）。
  const totalDurationS = Math.min(
    DIRECTOR_MAX_AUDIO_SECONDS,
    // 下限はシード 1 本分の最短（3 秒）。以前は 15 秒で、5 秒の動画を「作り直す」と 15 秒・3 倍の料金になっていた（2026-10-02）。
    // プロンプト／Advanced の尺の選択肢は 15 秒刻みなので、そちらの料金は変わらない。
    Math.max(DIRECTOR_MIN_SCENE_DURATION_S, Math.round(args.totalDurationS || 0)),
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
    totalDurationS: DIRECTOR_MAX_AUDIO_SECONDS,
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
// 実行中のジョブを待たず並列で今すぐ実行する場合の追加料金（既定の「順番待ち」
// は無料）。全タブ共通の「通常料金 × 率 + 固定」（src/lib/pricing/parallelSurcharge.ts）。
// フロント表示と API 検証は同じ baseCost を渡すこと。
export function directorPriorityParallelSurcharge(knobs: PricingKnobs = DEFAULT_KNOBS, baseCost = 0): number {
  return parallelSurcharge(baseCost, knobs.director_priority_parallel_rate, knobs.director_priority_parallel_surcharge);
}

/** Advanced（Qwen3.8-27B-abliteratedによる台本自動生成）モード使用時に
 * 上乗せする追加クレジット。別GPUではなく動画生成と同じB300コンテナ内で
 * 実行するが（二重コールドスタート回避のため、2026-09-18設計変更）、それでも
 * 台本生成ぶんのB300稼働秒数が純増するのでその分を吸収する。knobDefaults.ts
 * 参照 — 実機計測前の暫定値。 */
/** 「顔写真として使う」で足した写真（2 枚目以降）の分の上乗せ（2026-10-05）。フロント表示と route で同じ関数を使う。 */
export function directorExtraRefSurcharge(baseCredits: number, extraRefCount: number, knobs: PricingKnobs = DEFAULT_KNOBS): number {
  const n = Math.max(0, Math.min(8, Math.floor(extraRefCount)));
  return n > 0 ? Math.ceil(baseCredits * knobs.director_extra_ref_rate * n) : 0;
}

/**
 * 参照動画の分の上乗せ（2026-10-06）。参照動画は出力と同じくらいの数のトークンになって全ステップに乗るので、
 * 注意機構の計算は (出力秒 + 参照秒)² / 出力秒² 倍に近づく。B300 実測: 20 秒＋参照 10 秒で 396s → 791s（式 2.25 倍・実 2.0 倍）、
 * 38 秒＋参照 18 秒で 1,953s。率（knob）を掛けて「通常料金 × ((1 + 参照秒/出力秒)² − 1) × 率」。フロント表示と route で同じ関数。
 */
export function directorRefVideoSurcharge(
  baseCredits: number,
  refVideoS: number,
  outputS: number,
  knobs: PricingKnobs = DEFAULT_KNOBS,
): number {
  const v = Math.min(DIRECTOR_REF_VIDEO_MAX_S, Math.max(0, refVideoS));
  if (v <= 0 || outputS <= 0) return 0;
  return Math.ceil(baseCredits * ((1 + v / outputS) ** 2 - 1) * knobs.director_ref_video_rate);
}

/** 制限なしモード（2026-10-06）: 台本・英訳・写真の指示文を GPU 上の制限のない AI で書く分の上乗せ。 */
export function directorUnrestrictedScriptSurcharge(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.round(knobs.director_unrestricted_script_credits);
}

/** Photo Director の制限なしモードの追加料金（H200 で Qwen を読む分。動画の B300 とは別）。 */
export function photoUnrestrictedScriptSurcharge(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.round(knobs.photo_unrestricted_script_credits);
}

export function directorQwenScriptSurcharge(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  return Math.round(knobs.director_qwen_script_credits);
}

export function directorPollDeadlineS(totalDurationS: number, mode: DirectorQualityMode = "fast", refVideoS = 0): number {
  const secPerVideoSec = mode === "quality" ? 68 : 40;
  // 参照動画があると時間が (1 + 参照秒/出力秒)² 倍近くまで伸びる（directorRefVideoSurcharge）。屋上 38 秒＋18 秒＝1,953s。
  const v = Math.min(DIRECTOR_REF_VIDEO_MAX_S, Math.max(0, refVideoS));
  const factor = totalDurationS > 0 ? (1 + v / totalDurationS) ** 2 : 1;
  // ワーカーのハード上限（7,200s）の手前まで。参照動画なしは従来どおり 3,600s で頭打ち。
  const cap = v > 0 ? 6600 : 3600;
  return Math.min(cap, Math.max(300, Math.round(totalDurationS * secPerVideoSec * factor) + 200));
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
    const sceneChange = (raw as { sceneChange?: unknown })?.sceneChange !== false;
    const dialogueRaw = (raw as { dialogue?: unknown })?.dialogue;
    const dialogue =
      typeof dialogueRaw === "string" && dialogueRaw.trim()
        ? dialogueRaw.trim().slice(0, DIRECTOR_DIALOGUE_MAX_LENGTH)
        : undefined;
    cleaned.push({ camera, text, durationS, sceneChange, ...(dialogue ? { dialogue } : {}) });
  }
  if (directorTotalDurationS(cleaned) < cleaned.reduce((acc, s) => acc + s.durationS, 0)) {
    return { ok: false, error: `合計尺は最大${DIRECTOR_MAX_TOTAL_SECONDS}秒までです。` };
  }
  return { ok: true, scenes: cleaned };
}

/**
 * Photo Director の 1 回の枚数（2026-10-06 ホスト判断: 当たり外れがあるので最低 4 枚。まとめて出して 1 枚あたりの高値感を薄める）。
 * 1 枚の描画は B300 で 16〜21 秒（参照の読み込みは 1 回だけ）なので、8 枚でも 1〜2 分増えるだけ。
 */
export const PHOTO_COUNTS = [4, 6, 8] as const;
export const PHOTO_MIN_COUNT = 4;
export const PHOTO_MAX_COUNT = 8;
export function clampPhotoCount(count: unknown): number {
  const n = typeof count === "number" && Number.isFinite(count) ? Math.floor(count) : PHOTO_MIN_COUNT;
  return Math.max(PHOTO_MIN_COUNT, Math.min(PHOTO_MAX_COUNT, n));
}

/** Photo Director の思いつき欄の最大文字数（2026-10-06）。 */
export const PHOTO_IDEA_MAX_LENGTH = 600;
/** 「前のプロンプトを編集して作る」欄の最大文字数（英語の完成文が 120 語前後・日本語訳はもっと短い）。 */
export const PHOTO_PROMPT_MAX_LENGTH = 2000;

/**
 * Photo Director（2026-10-06）の料金: 1 回の基本料（起動・参照の読み込み）＋ 1 枚ごと。追加の参照写真の上乗せは Director と同じ率。
 * フロント表示と route で同じ関数を使う。knob の既定は本番実測前の仮値（knobDefaults.ts）。
 */
export function photoDirectorCredits(count: number, extraRefCount: number, knobs: PricingKnobs = DEFAULT_KNOBS): number {
  const n = clampPhotoCount(count);
  const base = Math.ceil(knobs.photo_director_base_credits + knobs.photo_director_per_image_credits * n);
  return base + directorExtraRefSurcharge(base, extraRefCount, knobs);
}

/** Photo Director の待ち上限（秒）。温まって 1 枚 約 1.5 分・起動込み 4 分強（2026-10-06 実測）の 2 倍以上を取る。 */
export function photoDirectorPollDeadlineS(count: number): number {
  return 900 + 120 * clampPhotoCount(count);
}
