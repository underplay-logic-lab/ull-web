"use client";

// モジュールレベルの定数・型・ヘルパー関数・独立コンポーネント（ImageDropzone /
// GenderTagPicker / YamlVipLockCard / ProgressPanel 等）は
// ./LoraStudioTab.parts.tsx に切り出し済み。この本体ファイルには状態を持つ
// LoraStudioTab コンポーネントそのものだけを残している。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  Cpu,
  Download,
  ImagePlus,
  Loader2,
  LogIn,
  Plus,
  RotateCcw,
  Scissors,
  Sparkles,
  Tag,
  Trash2,
  Wand2,
  Zap,
} from "lucide-react";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { supabase } from "@/lib/supabaseClient";
import {
  startLoraTraining,
  pollLoraJob,
  uploadLoraDataset,
  fetchRecentLoraJob,
  type LoraJobStatus,
  type LoraApiError,
  type LoraPollError,
} from "@/lib/loraApi";
import {
  LORA_PRESETS,
  LORA_PRESET_GROUP_LABELS,
  LORA_BASE_ARCHITECTURES,
  LORA_RESOLUTION_LABELS,
  DEFAULT_LORA_RESOLUTION,
  isBlockedLoraModel,
  loraPresetById,
  recommendedResolution,
  type LoraBaseArchitecture,
  type LoraResolution,
} from "@/lib/loraModels";
import { autoLoraSteps, autoLoraRankAlpha } from "@/lib/loraCredits";
import {
  guiLoraPricingConfig,
  loraPriceBreakdown,
  loraPriceMultiplierSummary,
  LORA_CREDIT_WORST_CASE,
} from "@/lib/loraPricing";
import { validateLoraYaml, loraYamlIdentity } from "@/lib/loraYaml";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { DatasetCurationUI, type CurationPair } from "@/components/studio/DatasetCurationUI";
import { parseDatasetZip, isZipFile, buildDatasetZip, downloadBlob } from "@/lib/datasetZip";
import {
  LORA_CAPTION_CATEGORIES,
  LORA_CAPTION_CATEGORY_META,
  coerceLoraCaptionCategory,
  captionSpecHasInput,
  buildCaptionFallbackPrompt,
  normalizeSubjectTags,
  buildEmbedTagsFromSubjects,
  keepTokensForCaption,
  resolveCaptionMode,
  isCaptionMode,
  type LoraCaptionCategory,
  type LoraCaptionSpec,
  type LoraSubject,
  type CaptionMode,
  type ResolvedCaptionMode,
  matchLeadingSubjectTriggers,
} from "@/lib/loraCaptionSpec";
import { analyzeDataset, captionBuckets, DIAGNOSTIC_AXES, suggestRepeats } from "@/lib/datasetDiagnostics";
import { DatasetDiagnosticsPanel } from "@/components/studio/DatasetDiagnosticsPanel";
import { translateCaption } from "@/lib/loraTranslate";
import { extractIdentityTags } from "@/lib/loraCaption";
import { generateCaptionPrompt } from "@/lib/loraCaptionPrompt";
import { generateDatasetCaptions, captionFileKey } from "@/lib/loraCaption";
import { runSmartCrop, type SmartCropKind } from "@/lib/smartCrop";
import { loraFlowStep, type LoraFlowTarget } from "@/lib/loraFlowStep";
import { prepareDatasetImage, type ImageSizeVerdict } from "@/lib/datasetImagePrep";

// 切り出し結果を捨てる閾値（2026-09-21、ホスト指摘「粗い画像を学習しちゃう
// だけだろ？」）。出力は固定サイズへ引き伸ばされるので、切り出し元の領域が
// 小さいほどただの水増しになる。1024x1536 の全身写真だと顔は150px前後＝約7倍。
// 1.35 は「上半身（実寸 約640px → 768px ＝ 約1.2倍）は通し、顔アップは落とす」
// という線で引いた出発点で、実測校正はしていない。
const SMART_CROP_MAX_UPSCALE = 1.35;
// 切り出し結果の短辺の下限（2026-09-22）。引き伸ばしをやめた（cropOutputSize）
// ので拡大率では弾けなくなった代わりに、出来上がりが小さすぎるものを落とす。
// 384 は「全身絵から切った顔でも、寄りの情報としては使える」下限の目安で、
// 未校正。ここを上げすぎると顔アップが足りない被写体ほど作れなくなる
// （まさにそれで 1024 固定＋拡大率1.35 が破綻した）。
const SMART_CROP_MIN_SHORT_EDGE = 384;
// 画像の取り込みが落ち着いてから特徴を抽出するまでの待ち時間（2026-09-22）。
// フォルダを何回かに分けてドロップする使い方が普通なので、最初のドロップだけで
// 走らせると偏ったサンプルを見ることになる。images.length が変わるたびに
// タイマーが張り直されるので、連続ドロップ中は発火しない。
// キャプション解析はこの抽出の完了を待つ（下の vision pass の identityPending
// を参照）ので、この値がそのまま「取り込みが止まってから解析が始まるまで」に
// なる。長くしすぎると待たされ、短すぎると偏ったサンプルで抽出する。
// 切り出し元が元画像のこの割合以上を占めるなら、中身がほぼ同じで情報が
// 増えないので捨てる（全身写真から全身を切り出すケース）。
const SMART_CROP_REDUNDANT_COVERAGE = 0.85;
import { warmSmartCropModels } from "@/lib/smartCropDetect";
import {
  ImageDropzone,
  GenderTagPicker,
  YamlVipLockCard,
  ProgressPanel,
  buildFormDraft,
  loadFormDraft,
  loadCaptionCache,
  persistCaptionCache,
  clearCaptionCache,
  JOB_POLL_INTERVAL_MS,
  MAX_RETRY_COUNT,
  POLL_KEEPALIVE_MS,
  MAX_IMAGES,
  MAX_LONG_EDGE,
  SMART_CROP_PANEL_ID,
  CROP_REVIEW_PANEL_ID,
  DIAGNOSTICS_PANEL_ID,
  METADATA_PANEL_ID,
  SUBJECTS_PANEL_ID,
  LORA_SETTINGS_ANCHOR_ID,
  SUBJECT_HINT_SEEN_KEY,
  RepeatWeightPanel,
  SmartCropPanel,
  MIN_SHORT_EDGE_ERROR,
  MAX_TOTAL_BYTES,
  MAX_FILE_BYTES,
  ACTIVE_JOB_STORAGE_KEY,
  LEGACY_ACTIVE_JOB_KEYS,
  DISMISSED_JOBS_STORAGE_KEY,
  RECENT_COMPLETED_MAX_AGE_MS,
  FORM_DRAFT_STORAGE_KEY,
  PRESET_GROUPS,
  OPTIMIZERS,
  LORA_NAME_RE,
  RANK_OPTIONS,
  ALPHA_OPTIONS,
  STEPS_MIN,
  STEPS_MAX,
  STEPS_STEP,
  STEPS_QUICK,
  LR_PRESETS,
  DEFAULT_PRO,
  DEFAULT_FORM_DRAFT,
  fieldCls,
  type DatasetImage,
  MAX_IMAGE_REPEATS,
  IdentityTagsField,
  type ProConfig,
  type Phase,
} from "./LoraStudioTab.parts";

// 日本語のカンマ（、）も区切りとして扱う。
const SPLIT_TAGS_RE = /\s*[,、]\s*/;

export function LoraStudioTab({
  onUseLora,
  onOpenMultiAngle,
  onOpenUpscale,
}: {
  onUseLora?: (loraFilename: string) => void;
  /** データセット診断から「足りない構図を作る」導線でタブを切り替える。 */
  onOpenMultiAngle?: () => void;
  /** 小さすぎる素材を拡大しに行く導線（超解像タブへ切り替える）。 */
  onOpenUpscale?: () => void;
}) {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs: pricingKnobs } = usePricingKnobs();
  // Gates the raw-YAML editor (a bespoke-contract / support feature). Non-
  // admins get the consultation card and can never reach yamlMode, so the
  // train payload from a normal account can't carry custom_yaml_override.
  const { isAdmin, loading: adminLoading } = useIsAdmin(user);

  const [images, setImages] = useState<DatasetImage[]>([]);
  const [smartCropBusy, setSmartCropBusy] = useState(false);
  const [smartCropProgress, setSmartCropProgress] = useState<{ done: number; total: number } | null>(null);
  // 送信済みバイト（枚数カウンタは16並列ぶんまとめて動くので、止まって見える）。
  const [uploadBytes, setUploadBytes] = useState<{ sent: number; total: number } | null>(null);
  // 送信前の WebP 変換（実測で 317MB -> 35MB。ここが送信時間を9倍縮める）。
  const [optimizeProgress, setOptimizeProgress] = useState<{ done: number; total: number } | null>(null);
  // 📐 の実行結果。ボタンのすぐ下に出す（2026-09-22、ホスト指摘「押した時に
  // 終わっているのかどうか分からない」）。取り込み通知は画面のはるか上なので
  // 気付けなかった。
  const [repeatsNotice, setRepeatsNotice] = useState<string | null>(null);
  const smartCropWarmedRef = useRef(false);
  // English caption per image id. Filled by the AI-vision auto-caption pass on
  // drop, or straight from a .txt / ZIP the user brought.
  const [captions, setCaptions] = useState<Record<string, string>>({});
  // Japanese working copy per image id (for the curation UI's review pane).
  const [captionsJa, setCaptionsJa] = useState<Record<string, string>>({});
  // AI-vision auto-caption progress for the current pass.
  const [autoCap, setAutoCap] = useState<{
    running: boolean;
    done: number;
    total: number;
    error: string | null;
    // Transient hint shown while a batch is backing off a rate limit.
    note: string | null;
    everRan: boolean;
  }>({ running: false, done: 0, total: 0, error: null, note: null, everRan: false });
  // Image ids whose AI-vision caption exhausted its retries (rate limit /
  // error / timeout). Surfaced on the card + the "未完了を再解析" button;
  // cleared the moment a caption lands for that id.
  const [captionErrorIds, setCaptionErrorIds] = useState<Set<string>>(() => new Set());
  // Image ids with a single-image re-analysis in flight (per-card 🔄 button).
  const [recaptioningIds, setRecaptioningIds] = useState<Set<string>>(() => new Set());
  // Image ids we've already sent to the vision captioner (so a re-render / new
  // drop doesn't re-caption them). Cleared per-id on remove / on "再解析".
  const captionAttemptedRef = useRef<Set<string>>(new Set());
  // Asked at most once per mount: when a fresh dataset drop would rehydrate
  // captions from the localStorage draft cache, offer a clean start so a stale
  // (or wrong-format) draft can't zombie back in. Once the user has answered,
  // their choice stands for the rest of the session.
  const zombieDraftDecidedRef = useRef(false);
  // Image ids whose caption came from a user .txt / ZIP (NOT the AI) — a
  // blank one of these is intentional, so the worker must not VLM-fill it.
  // State (not a ref) because the routing badge derives from it in render.
  const [userCaptionIds, setUserCaptionIds] = useState<Set<string>>(() => new Set());
  const autoCaptionAbortRef = useRef<AbortController | null>(null);
  // Live set of image ids — read by the async caption pass (which captured a
  // now-stale `targets` list) to drop results for images removed mid-pass.
  // Kept in sync with `images` right after commit; the pass only reads it
  // when a network round trip resolves, long after any effect has run.
  const imageIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    imageIdsRef.current = new Set(images.map((i) => i.id));
  }, [images]);
  // The caption_prompt the AI captions were last generated with — so
  // handleStart only re-captions when the synthesised instruction changed.
  const recaptionPromptRef = useRef<string>("");
  // "__custom__" is the last option in the single model dropdown; anything
  // else is a preset id.
  const [modelChoice, setModelChoice] = useState<string>("minimax_h3");
  const [customModelId, setCustomModelId] = useState("");
  const [baseArchitecture, setBaseArchitecture] = useState<LoraBaseArchitecture>("sdxl");
  // 2026-09-14: ユーザーが手で選ぶものではなくなった。512/768/1280を選ばせて
  // 「512だとディティールが甘い」等の混乱を招いていたため廃止し、モデルの
  // アーキテクチャから recommendedResolution() で純粋に導出する（state では
  // ない — pricedArch と同じ isCustom 判定をここで先に軽量に再現している。
  // 後方（pricedArch 定義箇所）で改めて計算し直す version と重複するが、
  // このファイル規模での並び替えリスクを避けるため意図的に重複させている）。
  const resolution = useMemo<LoraResolution>(() => {
    const arch = modelChoice === "__custom__" ? baseArchitecture : (loraPresetById(modelChoice)?.arch ?? "");
    return arch ? recommendedResolution(arch as LoraBaseArchitecture) : DEFAULT_LORA_RESOLUTION;
  }, [modelChoice, baseArchitecture]);
  const [triggerWord, setTriggerWord] = useState("");
  // 2026-09-15: 複数の人物/被写体をひとつのLoRAで区別する場合の追加trigger。
  // 空配列（既定）なら完全に従来通り（単一trigger、判定ロジックなし）。
  // 1件以上あると「複数被写体モード」になり、主trigger(triggerWord)にも
  // 説明文が要る（判定材料として全員分の説明が必要なため）。
  const [primaryDescription, setPrimaryDescription] = useState("");
  // 性別/人数タグ（1girl/1boy/1man/1woman + solo）をAI任せにせず固定する
  // （2026-09-15、ホスト報告: 同じ人物なのに1girl/1womanが混在・soloタグが
  // 抜ける画像があった）。空なら従来通りAIの判定＋多数決に任せる。
  const [primaryFixedTags, setPrimaryFixedTags] = useState("");
  // 見た目の固定特徴（Danbooru タグ、カンマ区切り。例: "bald, fat, glasses"）。
  // キャプションには**書かず**、LoRA の metadata にだけ埋め込む。
  // ComfyUI 側の「LoRA を読んだら metadata のタグをプロンプトへ足す」運用で
  // 生成時に戻ってくることで再現性が上がる、という対称の使い方（ホスト運用）。
  const [primaryIdentityTags, setPrimaryIdentityTags] = useState("");
  // 上の英タグと同じ並びの日本語表示（表示専用。英側が正）。
  const [primaryIdentityTagsJa, setPrimaryIdentityTagsJa] = useState("");
  const [extraSubjects, setExtraSubjects] = useState<LoraSubject[]>([]);
  const allSubjects = useMemo<LoraSubject[]>(
    () =>
      extraSubjects.length > 0 || primaryFixedTags.trim() || primaryIdentityTags.trim()
        ? [
            {
              trigger: triggerWord.trim(),
              description: primaryDescription.trim(),
              fixedTags: primaryFixedTags.trim(),
              identityTags: primaryIdentityTags.trim(),
              identityTagsJa: primaryIdentityTagsJa.trim(),
            },
            ...extraSubjects,
          ]
        : [],
    [
      triggerWord,
      primaryDescription,
      primaryFixedTags,
      primaryIdentityTags,
      primaryIdentityTagsJa,
      extraSubjects,
    ],
  );
  const [loraName, setLoraName] = useState("");
  // SDXL/sd-scriptsワーカー限定のメタデータタグ埋め込み（2026-09-15、
  // [[sdxl-training-sd-scripts-plan]] の「フロントUI未着手」項目）。
  // "tag:freq,tag,..." 形式の文字列。空ならopt-out（sd-scripts純正メタデータ
  // のまま）— modal_sdxl_lora_worker.py の _parse_embed_tags と同じ書式。
  // keep_tokens の手入力欄は 2026-09-21 に廃止した。値はキャプションの
  // 固定ブロック長から keepTokensForCaption() が画像ごとに算出する。
  const [embedTagsOpen, setEmbedTagsOpen] = useState(false);
  const [pro, setPro] = useState<ProConfig>(DEFAULT_PRO);
  // LoRA-type-aware auto-caption spec: the training TYPE + the user's JP notes
  // on which features to lock into the trigger (blacklisted from captions) vs.
  // let vary (described). Gemini turns this into the English Qwen instruction.
  const [captionCategory, setCaptionCategory] = useState<LoraCaptionCategory>("character");
  const [captionFixed, setCaptionFixed] = useState("");
  const [captionVarying, setCaptionVarying] = useState("");
  // User-edited final English instruction — empty = use whatever Gemini builds
  // on "次へ". Non-empty overrides generation.
  const [captionPromptOverride, setCaptionPromptOverride] = useState("");
  const [captionPromptOpen, setCaptionPromptOpen] = useState(false);
  // Caption FORMAT: 'auto' routes off the base model (dense prose for the
  // next-gen DiT lineup, comma tags for CLIP-encoder SDXL); 'dense' / 'tags'
  // pin it. Resolved via resolveCaptionMode() and sent to the vision API.
  const [captionMode, setCaptionMode] = useState<CaptionMode>("auto");
  // Last synthesised English instruction + how it was produced, for display.
  const [captionGen, setCaptionGen] = useState<{
    state: "idle" | "generating" | "done" | "error";
    prompt: string;
    fromGemini: boolean;
    error: string | null;
  }>({ state: "idle", prompt: "", fromGemini: false, error: null });
  // The instruction actually sent with the current run — set in handleStart so
  // both the direct and post-curation training paths pick it up.
  const resolvedCaptionPromptRef = useRef<string>("");
  // Previous trigger word — so a change can be swapped into existing captions
  // client-side (no re-analysis). Seeded lazily on the first change.
  const prevTriggerRef = useRef<string | null>(null);
  // Mirror of `hasUserCaptions` (defined later) for use in callbacks declared
  // before it.
  const hasUserCaptionsRef = useRef(false);
  // Identity of the caption spec the current captions reflect. handleStart
  // only re-analyses when the live spec differs from this (a bare trigger-word
  // edit is swapped in client-side and updates this without a re-run). Mirrored
  // to state so the "反映済み / 変更あり" badge can react.
  const lastCaptionSpecKeyRef = useRef<string>("");
  const [reflectedSpecKey, setReflectedSpecKey] = useState<string>("");
  const markCaptionsReflect = useCallback((key: string) => {
    lastCaptionSpecKeyRef.current = key;
    setReflectedSpecKey(key);
  }, []);

  const [phase, setPhase] = useState<Phase>("form");
  // Locked the instant "学習を開始" is pressed — before phase flips to
  // "starting" there's an async window (caption passes, prompt synthesis) in
  // which the button must be inert and no form re-render can slip a stale
  // "クレジット不足" card back onto the screen.
  const [submitting, setSubmitting] = useState(false);
  const [datasetZipBusy, setDatasetZipBusy] = useState(false);
  // Opt-in visual dataset curation: after upload, review/cull images and
  // review/edit captions (with JP round-trip translation) before training.
  // 既定 ON（2026-09-22、ホスト判断）。キャプションは学習結果を決める要素で、
  // 一度も見ずに焼くほうが例外であるべき。下書きがあればそちらが優先される。
  const [curationEnabled, setCurationEnabled] = useState(true);
  const [curationPairs, setCurationPairs] = useState<CurationPair[]>([]);
  const [zipBusy, setZipBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [job, setJob] = useState<LoraJobStatus | null>(null);
  // Human label of the model `job` is training — captured at dispatch time so
  // the "学習が進行中です" return-to-progress banner can name it even after a
  // soft return to the form (the job payload itself carries no model name).
  const [activeJobModelLabel, setActiveJobModelLabel] = useState<string | null>(null);
  // A previous FAILED / cancelled job found at mount. Never auto-opens its
  // panel (that async-driven yank is the whole bug) — it surfaces a small,
  // dismissible banner on the form and the user chooses to open it.
  const [recoveredJob, setRecoveredJob] = useState<LoraJobStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 取り込み結果（何枚増えて合計何枚になったか）。エラーではないので別枠。
  const [addNotice, setAddNotice] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  // Seconds since the current job entered 'queued' — drives the cold-start
  // provisioning copy in ProgressPanel. Only ever written from the interval
  // callback below (never synchronously in the effect body).
  const [queuedElapsedSec, setQueuedElapsedSec] = useState(0);
  // Transient-failure state for the status poll (see startPolling /
  // MAX_RETRY_COUNT). `pollRetry` > 0 drives the light "再接続中 (n/6)…" hint
  // while the loop is still on its fast exponential backoff; `pollLost` means
  // the fast retries were spent (or the job 404'd) so the degraded card is
  // shown — but a slow keep-alive poll keeps running underneath (plus an
  // instant re-poll on tab-focus / network-online), so the screen self-heals
  // when the backend is reachable again. Only a 404 truly stops the loop.
  // Neither path ever throws or unmounts the progress screen.
  const [pollRetry, setPollRetry] = useState(0);
  const [pollLost, setPollLost] = useState(false);

  // Wraps the progress / completion / error panel — the viewport is pulled
  // here the moment a job is dispatched and again on every terminal flip, so
  // the user never loses the running job (or its download / error card) below
  // the fold.
  const progressRef = useRef<HTMLDivElement>(null);
  // The outermost Studio container for the current screen. When we DO need to
  // realign the viewport on a screen change (only the form -> curation
  // transition), we scroll THIS element into view — never window Y=0, which
  // would fling the page up to the site Hero.
  const studioRef = useRef<HTMLDivElement>(null);
  // The scroll target we last honoured ("panel" on first appearance, then the
  // terminal status). Stops the routine queued -> processing step from yanking
  // a user who scrolled down to read the live log.
  const scrolledForRef = useRef<string>("");

  const pollCancelledRef = useRef(false);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Count of consecutive failed poll ticks. Reset to 0 on any 200; when it
  // reaches MAX_RETRY_COUNT the loop stops and `pollLost` is raised.
  const consecutiveErrorsRef = useRef(0);
  // Job ids the user has explicitly dismissed via "新しい LoRA を学習する" /
  // フォームに戻る — the mount-restore effect must never resurrect them (the
  // fetchRecentLoraJob fallback would otherwise bounce the user straight back
  // to a failed panel they just left). Mirrored to sessionStorage so a reload
  // right after dismissing still stays on the form.
  const dismissedJobIdsRef = useRef<Set<string>>(
    new Set(
      (() => {
        try {
          return JSON.parse(sessionStorage.getItem(DISMISSED_JOBS_STORAGE_KEY) || "[]") as string[];
        } catch {
          return [];
        }
      })(),
    ),
  );
  const dismissJob = (jobId: string | null | undefined) => {
    if (!jobId) return;
    dismissedJobIdsRef.current.add(jobId);
    try {
      sessionStorage.setItem(
        DISMISSED_JOBS_STORAGE_KEY,
        JSON.stringify([...dismissedJobIdsRef.current].slice(-20)),
      );
    } catch {
      /* private mode / disabled storage — the ref alone still guards this session */
    }
  };
  // The job id currently being polled and when it entered 'queued'.
  const activeJobIdRef = useRef<string>("");
  const queuedSinceRef = useRef<number>(0);
  // Live mirror of `phase`, readable synchronously from async callbacks. The
  // mount-restore fetch and any in-flight poll consult this before touching
  // state: once the user is on the form (fresh load that resolved to the form,
  // an explicit reset, or a Start-Training press) NO late async response may
  // shove them onto "tracking".
  const phaseRef = useRef<Phase>("form");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  // The mount-restore effect keys on `user`, whose identity changes on every
  // token refresh / tab refocus — without this it re-runs and re-attaches a
  // job the user already left. Restore is attempted exactly once per mount.
  const restoreDoneRef = useRef(false);
  // Generation counter bumped by resetForm / Start-Training. An async restore
  // or poll captures the value at dispatch and bails if it no longer matches —
  // physically decouples a slow response from the current screen.
  const jobBindGenRef = useRef(0);
  // Caches a successful dataset upload against a fingerprint of the exact
  // image set. Re-running with the same images (only params / YAML changed)
  // reuses these Storage paths and skips the whole upload — 0s, no re-cost.
  const uploadedDatasetRef = useRef<{ signature: string; paths: string[] } | null>(null);
  useEffect(
    () => () => {
      pollCancelledRef.current = true;
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
      autoCaptionAbortRef.current?.abort();
      images.forEach((i) => URL.revokeObjectURL(i.url));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Ticks the queued-provisioning copy once a second while a job sits in
  // 'queued'. ProgressPanel only reads queuedElapsedSec in its 'queued'
  // branch, so a stale value after the job moves on is never shown.
  useEffect(() => {
    if (job?.status !== "queued") return;
    const iv = setInterval(() => {
      setQueuedElapsedSec(
        queuedSinceRef.current > 0 ? Math.floor((Date.now() - queuedSinceRef.current) / 1000) : 0,
      );
    }, 1000);
    return () => clearInterval(iv);
  }, [job?.status]);

  // Smooth-scroll the progress panel into view: once when it first appears
  // (job dispatched), and again each time the job reaches a terminal state
  // (completed / failed / cancelled) so the download buttons and the
  // success / error card land in the viewport. The intermediate queued ->
  // processing progression is intentionally NOT scrolled.
  useEffect(() => {
    if (phase !== "starting" && phase !== "tracking") {
      scrolledForRef.current = "";
      return;
    }
    const status = job?.status ?? null;
    const terminal =
      status === "completed" ||
      status === "failed" ||
      status === "failed_timeout" ||
      status === "cancelled";
    const key = terminal ? `done:${status}` : "panel";
    if (scrolledForRef.current === key) return;
    scrolledForRef.current = key;
    const el = progressRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(raf);
  }, [phase, job?.status]);

  // Bring the Studio container (NOT the window top) into view. Used ONLY for
  // the form -> curation transition, where the user is typically scrolled deep
  // into a 100+ thumbnail grid and the curation screen would otherwise open
  // mid-page. Never touches window.scrollTo, so it can't fling the page up to
  // the site Hero. PURE side effect, fully guarded — it can only scroll.
  const scrollStudioIntoView = useCallback(() => {
    if (typeof window === "undefined") return;
    requestAnimationFrame(() => {
      try {
        studioRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch {
        /* no-op */
      }
    });
  }, []);

  // Mirrors `images` for synchronous MAX_IMAGES accounting inside the add
  // helpers (which can't read the just-set state).
  const imagesRef = useRef<DatasetImage[]>([]);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  // --- form-draft auto-persist -------------------------------------------
  // Hydrated from localStorage once on mount (not via useState initialisers —
  // that would desync SSR/CSR and warn on hydration). Applied in a microtask
  // so it's out of the effect's synchronous body (matches the active-job
  // restore effect below). The save effect is gated on draftHydratedRef so it
  // never writes the defaults over a saved draft before this runs.
  const draftHydratedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const d = loadFormDraft();
      if (d) {
        if (typeof d.triggerWord === "string") setTriggerWord(d.triggerWord);
        if (typeof d.primaryDescription === "string") setPrimaryDescription(d.primaryDescription);
        if (typeof d.primaryFixedTags === "string") setPrimaryFixedTags(d.primaryFixedTags);
        if (typeof d.primaryIdentityTags === "string") setPrimaryIdentityTags(d.primaryIdentityTags);
        if (typeof d.primaryIdentityTagsJa === "string") setPrimaryIdentityTagsJa(d.primaryIdentityTagsJa);
        if (Array.isArray(d.extraSubjects)) {
          const restored = d.extraSubjects
            .map((s) => {
              const o = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
              return {
                trigger: typeof o.trigger === "string" ? o.trigger : "",
                description: typeof o.description === "string" ? o.description : "",
                fixedTags: typeof o.fixedTags === "string" ? o.fixedTags : "",
              };
            })
            .filter((s) => s.trigger.length > 0);
          if (restored.length > 0) setExtraSubjects(restored);
        }
        if (typeof d.loraName === "string") setLoraName(d.loraName);
        {
          const migrated = coerceLoraCaptionCategory(d.captionCategory);
          if (migrated) setCaptionCategory(migrated);
        }
        if (typeof d.captionFixed === "string") setCaptionFixed(d.captionFixed);
        if (typeof d.captionVarying === "string") setCaptionVarying(d.captionVarying);
        if (typeof d.captionPromptOverride === "string") setCaptionPromptOverride(d.captionPromptOverride);
        if (isCaptionMode(d.captionMode)) setCaptionMode(d.captionMode);
        if (typeof d.curationEnabled === "boolean") setCurationEnabled(d.curationEnabled);
        // キャッシュから戻すキャプションが反映している指示（2026-09-22）。
        // 保存していなかったため、リロード後は常に「指示が変わった」と判定され、
        // 取り込み直すたびに全画像のキャプションが作り直されていた。
        if (typeof d.reflectedSpecKey === "string" && d.reflectedSpecKey) {
          lastCaptionSpecKeyRef.current = d.reflectedSpecKey;
          setReflectedSpecKey(d.reflectedSpecKey);
        }

        // --- expert / model settings ---------------------------------------
        // "__custom__" is intentionally excluded — that entry point is sealed
        // out of the UI (see the model <select> below), so an old draft that
        // saved it degrades to the default preset instead of selecting a
        // dropdown option that no longer exists.
        if (typeof d.modelChoice === "string" && loraPresetById(d.modelChoice)) {
          setModelChoice(d.modelChoice);
        }
        if (typeof d.customModelId === "string") setCustomModelId(d.customModelId);
        if (
          typeof d.baseArchitecture === "string" &&
          (LORA_BASE_ARCHITECTURES as string[]).includes(d.baseArchitecture)
        ) {
          setBaseArchitecture(d.baseArchitecture as LoraBaseArchitecture);
        }
        // resolution はもう手動保存/復元しない — モデル確定後に
        // recommendedResolution() から自動で決まる（下記 useEffect 参照）。

        // Nested `pro` (current shape) with a fallback to the legacy top-level
        // rawYaml / useRawYaml that pre-expert-settings drafts stored.
        const rp =
          d.pro && typeof d.pro === "object" ? (d.pro as Partial<Record<keyof ProConfig, unknown>>) : {};
        const legacyRawYaml =
          typeof rp.rawYaml === "string"
            ? (rp.rawYaml as string)
            : typeof d.rawYaml === "string"
              ? (d.rawYaml as string)
              : undefined;
        const legacyUseRawYaml =
          typeof rp.useRawYaml === "boolean"
            ? (rp.useRawYaml as boolean)
            : typeof d.useRawYaml === "boolean"
              ? (d.useRawYaml as boolean)
              : undefined;
        setPro((p) => {
          const next = { ...p };
          if ((RANK_OPTIONS as readonly number[]).includes(rp.rank as number)) next.rank = rp.rank as number;
          if ((ALPHA_OPTIONS as readonly number[]).includes(rp.alpha as number))
            next.alpha = rp.alpha as number;
          if (typeof rp.alphaLinked === "boolean") next.alphaLinked = rp.alphaLinked;
          if (typeof rp.learningRate === "number" && rp.learningRate > 0)
            next.learningRate = rp.learningRate;
          if (typeof rp.lrCustom === "boolean") next.lrCustom = rp.lrCustom;
          if (typeof rp.steps === "number" && rp.steps >= STEPS_MIN && rp.steps <= STEPS_MAX)
            next.steps = rp.steps;
          if (typeof rp.optimizer === "string" && OPTIMIZERS.includes(rp.optimizer))
            next.optimizer = rp.optimizer;
          if (legacyRawYaml !== undefined) next.rawYaml = legacyRawYaml;
          if (legacyUseRawYaml !== undefined) next.useRawYaml = legacyUseRawYaml;
          return next;
        });
      }
      draftHydratedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !draftHydratedRef.current) return;
    const draft = buildFormDraft({
      triggerWord,
      primaryDescription,
      primaryFixedTags,
      primaryIdentityTags,
      primaryIdentityTagsJa,
      extraSubjects,
      loraName,
      captionCategory,
      captionFixed,
      captionVarying,
      captionPromptOverride,
      captionMode,
      curationEnabled,
      reflectedSpecKey,
      mode: "pro" as const,
      modelChoice,
      customModelId,
      baseArchitecture,
      resolution,
      pro,
    });
    try {
      const serialized = JSON.stringify(draft);
      // Pristine form -> no key at all (so "フォームを初期化" genuinely clears
      // it, and a first-time visitor never gets a stale entry).
      if (serialized === JSON.stringify(DEFAULT_FORM_DRAFT)) {
        window.localStorage.removeItem(FORM_DRAFT_STORAGE_KEY);
      } else {
        window.localStorage.setItem(FORM_DRAFT_STORAGE_KEY, serialized);
      }
    } catch {
      /* private mode / quota — persistence is best-effort */
    }
  }, [
    reflectedSpecKey,
    triggerWord,
    primaryDescription,
    primaryFixedTags,
    primaryIdentityTags,
    primaryIdentityTagsJa,
    extraSubjects,
    loraName,
    captionCategory,
    captionFixed,
    captionVarying,
    captionPromptOverride,
    captionMode,
    curationEnabled,
    modelChoice,
    customModelId,
    baseArchitecture,
    resolution,
    pro,
  ]);

  const addDatasetFiles = useCallback((entries: { file: File; caption?: string; cropKind?: SmartCropKind; sizeVerdict?: ImageSizeVerdict }[]) => {
    // Deterministic, filename-derived id (no random UUID) so it's a stable
    // React key across every re-render / curation round-trip; a numeric
    // suffix disambiguates genuinely identical files.
    const used = new Set(imagesRef.current.map((i) => i.id));
    let room = MAX_IMAGES - imagesRef.current.length;
    const newImgs: DatasetImage[] = [];
    const newCaps: Record<string, string> = {};
    const newCapsJa: Record<string, string> = {};
    const newUserCaptionIds: string[] = [];
    // Resume support: captions earned before a crash / reload are cached by
    // file identity — rehydrate any that match the files being (re-)added.
    const cache = loadCaptionCache();

    // Zombie-draft guard: a fresh dataset drop that WOULD rehydrate captions
    // from a previous session's cache — ask once whether to keep that draft or
    // start clean. Without this, a re-dropped file silently restores a stale
    // (or wrong-format, e.g. Tags after a switch to Dense) caption.
    let useCache = true;
    const freshStart = imagesRef.current.length === 0;
    const cacheWouldRehydrate =
      freshStart &&
      Object.keys(cache).length > 0 &&
      entries.some((e) => !(e.caption ?? "").trim() && Boolean(cache[captionFileKey(e.file)]));
    if (cacheWouldRehydrate && !zombieDraftDecidedRef.current) {
      zombieDraftDecidedRef.current = true;
      // ⚠️ 破棄を既定（OK）にしていたのが原因で、AI解析の1日の上限を使い切る
      // 事故が起きた（2026-09-22、ホスト報告）。リロード後に同じ画像を入れ直すと
      // 必ずこのダイアログが出るため OK を押しがちになる。破棄はコストが大きい
      // （無料枠は1日80リクエスト前後）ので、**再利用を OK 側**に置く。
      const reusable = entries.filter(
        (e) => !(e.caption ?? "").trim() && Boolean(cache[captionFileKey(e.file)]),
      ).length;
      const startClean = !window.confirm(
        `同じ画像の解析結果が ${reusable} 件、この端末に残っています。再利用しますか？\n\n` +
          "「OK」= 再利用する（AI解析を使いません・推奨）\n" +
          "「キャンセル」= 破棄して解析し直す（AI解析の1日の上限を消費します）",
      );
      if (startClean) {
        useCache = false;
        clearCaptionCache();
        setCaptions({});
        setCaptionsJa({});
        setCurationPairs([]);
        captionAttemptedRef.current = new Set();
      }
    }
    // Reject any single image over the per-file cap (the total-size cap is
    // enforced separately by the submit gate).
    let dupes = 0;
    const oversized = entries.filter((e) => e.file.size > MAX_FILE_BYTES);
    if (oversized.length) {
      setErrorMessage(
        `${oversized.length} 枚が 1 枚あたりの上限（${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB）を超えたため除外しました: ` +
          oversized
            .slice(0, 3)
            .map((e) => e.file.name)
            .join(", ") +
          (oversized.length > 3 ? " ほか" : ""),
      );
    }
    // 上限超過も無言で切り捨てない（CLAUDE.md §6-8）。oversized と両方
    // 起きた場合は後勝ちになるが、どちらも「何枚落ちたか」は必ず出る。
    const overflow = entries.length - oversized.length - Math.max(room, 0);
    if (overflow > 0) {
      setErrorMessage(
        `1データセットの上限 ${MAX_IMAGES} 枚に達したため、${overflow} 枚を取り込めませんでした。` +
          `不要な画像を削除してから追加してください。`,
      );
    }
    for (const { file, caption, cropKind, sizeVerdict } of entries) {
      if (file.size > MAX_FILE_BYTES) continue;
      if (room <= 0) break;
      room--;
      // ファイル名・サイズ・更新日時が完全一致するものは、同じ画像を二度
      // 取り込んだとみなして弾く（2026-09-21）。以前は ::2 の連番を付けて
      // 別物として追加していたため、同じフォルダをもう一度ドロップすると
      // 枚数が黙って増えた。データセットに同一画像が二重に入るのは学習上も
      // 有害なので、追加せずに理由を出す。
      const base = `${file.name}::${file.size}::${file.lastModified}`;
      if (used.has(base)) {
        dupes++;
        room++; // 枠は消費していない
        continue;
      }
      const id = base;
      used.add(id);
      newImgs.push({ id, file, url: URL.createObjectURL(file), cropKind, sizeVerdict });
      if ((caption ?? "").trim()) {
        newCaps[id] = caption!.trim();
        // Brought by the user (.txt / ZIP) — not AI-generated.
        newUserCaptionIds.push(id);
        captionAttemptedRef.current.add(id);
      } else if (useCache) {
        const cached = cache[captionFileKey(file)];
        if (cached && (cached.en?.trim() || cached.ja?.trim())) {
          if (cached.en?.trim()) newCaps[id] = cached.en.trim();
          if (cached.ja?.trim()) newCapsJa[id] = cached.ja.trim();
          // Cached => already analyzed; the auto-kick effect skips it.
          captionAttemptedRef.current.add(id);
        }
      }
    }
    // 何枚増えて合計いくつになったかを毎回出す。取り込み直後に数が合わない
    // という混乱が実際に起きたため、内訳を必ず可視化する。
    const before = imagesRef.current.length;
    // この通知は**取り込み欄のすぐ下**に出す（2026-09-22、ホスト指摘）。
    // 以前はサムネイル一覧の下にあり、取り込み中は画面外で見えず、後から
    // スクロールして出会うと「2 枚」が何の数字か分からなかった。
    setAddNotice(
      `${newImgs.length} 枚を追加しました（合計 ${before + newImgs.length} 枚）` +
        (dupes > 0
          ? ` ／ 取り込み済みと同じ画像 ${dupes} 枚は除外しました。` +
            `特定の画像を多めに学習させたい場合は、同じ画像を重ねて入れるのではなく、` +
            `サムネイルを選んで「学習回数」を 2〜4 に上げてください（同じ効果が得られ、あとから変更できます）。`
          : ""),
    );
    if (newImgs.length) setImages((prev) => [...prev, ...newImgs]);
    if (Object.keys(newCaps).length) setCaptions((prev) => ({ ...prev, ...newCaps }));
    if (Object.keys(newCapsJa).length) setCaptionsJa((prev) => ({ ...prev, ...newCapsJa }));
    if (newUserCaptionIds.length) {
      setUserCaptionIds((prev) => {
        const next = new Set(prev);
        newUserCaptionIds.forEach((id) => next.add(id));
        return next;
      });
    }
  }, []);

  const importZip = useCallback(
    async (zip: File) => {
      setZipBusy(true);
      setErrorMessage(null);
      try {
        const entries = await parseDatasetZip(zip, { maxImages: MAX_IMAGES });
        if (!entries.length) {
          setErrorMessage(`ZIP に画像が見つかりませんでした（${zip.name}）。`);
          return;
        }
        addDatasetFiles(entries.map((e) => ({ file: e.file, caption: e.caption })));
        // Captions carried by the ZIP land in `captions` — the dropzone badge
        // and runTraining pick them up automatically (Qwen is then skipped);
        // no mode switch needed.
      } catch (err) {
        setErrorMessage(
          `ZIP の展開に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setZipBusy(false);
      }
    },
    [addDatasetFiles],
  );

  // 取り込み前に1枚ずつサイズを測り、長辺が大きすぎるものは縮小してから
  // 渡す（2026-09-21）。ワーカー側は bucket_no_upscale なので小さい画像は
  // 引き伸ばされず、そのぶん甘い LoRA になる。黙っていると原因不明の品質
  // 劣化になるので、ここで計測して下の警告パネルへ回す。
  const addDatasetFilesChecked = useCallback(
    async (entries: { file: File; caption?: string }[]) => {
      const prepared = await Promise.all(
        entries.map(async (e) => {
          const p = await prepareDatasetImage(e.file);
          return { ...e, file: p.file, sizeVerdict: p.verdict, shrunkFrom: p.shrunkFrom };
        }),
      );
      const shrunk = prepared.filter((p) => p.shrunkFrom).length;
      addDatasetFiles(prepared);
      if (shrunk > 0) {
        setAddNotice(
          `${shrunk} 枚は長辺が ${MAX_LONG_EDGE}px を超えていたため、取り込み時に縮小しました（学習解像度では使われない情報のため、画質は落ちません）。`,
        );
      }
    },
    [addDatasetFiles],
  );

  const addImages = useCallback(
    (incoming: FileList | File[]) => {
      const arr = Array.from(incoming);
      const imgs = arr.filter((f) => /^image\/(png|jpe?g|webp)$/.test(f.type));
      const zips = arr.filter((f) => isZipFile(f));
      // Loose <name>.txt dropped alongside <name>.<img> — pair them by base
      // name so a plain "images + .txt" drop routes the same as a ZIP.
      const txts = arr.filter((f) => /\.txt$/i.test(f.name) && !isZipFile(f));
      const stem = (n: string) => n.replace(/\.[^.]+$/, "");

      if (imgs.length) {
        if (txts.length) {
          void (async () => {
            const byStem = new Map<string, string>();
            await Promise.all(
              txts.map(async (t) => {
                try {
                  byStem.set(stem(t.name), (await t.text()).trim());
                } catch {
                  /* unreadable .txt — image just gets auto-captioned */
                }
              }),
            );
            void addDatasetFilesChecked(imgs.map((file) => ({ file, caption: byStem.get(stem(file.name)) })));
          })();
        } else {
          void addDatasetFilesChecked(imgs.map((file) => ({ file })));
        }
      }
      zips.forEach((z) => void importZip(z));

      // 画像でもZIPでも.txtでもないファイル（動画等）は、これまで何の
      // フィードバックも無く黙って無視されていた（2026-09-15、Cinematic
      // Directorでの同種の不具合を水平展開して修正）。
      const recognized = new Set<File>([...imgs, ...zips, ...txts]);
      const rejected = arr.filter((f) => !recognized.has(f));
      if (rejected.length) {
        setErrorMessage(
          `${rejected.length} 件は画像/ZIP/.txt として認識できず除外しました（${rejected
            .slice(0, 3)
            .map((f) => f.name)
            .join(", ")}${rejected.length > 3 ? " ほか" : ""}）。PNG/JPG/WEBP か ZIP を選んでください。`,
        );
      }
    },
    [addDatasetFilesChecked, importZip],
  );

  // モデル（MediaPipe WASM + .task、計10MB前後）はユーザーがデータセットに
  // 画像を入れた時点で一度だけバックグラウンド先読みしておく（実行ボタンを
  // 押した瞬間の初回待ちを減らす）。失敗しても runSmartCrop 側で再試行される。
  useEffect(() => {
    if (images.length > 0 && !smartCropWarmedRef.current) {
      smartCropWarmedRef.current = true;
      warmSmartCropModels();
    }
  }, [images.length]);

  // 未クロップの元画像（cropKind未設定）だけを対象に、1枚ずつ順番に
  // スマートクロップを実行してデータセットへ追加する。並列実行にしない
  // のはメモリ・進捗表示のシンプルさを優先したもの（1枚あたり数百ms程度）。
  // サムネイルの選択状態（学習回数の一括設定・クロップ対象の指定に使う）。
  // 診断パネルから「この被写体の元画像だけ選ぶ」ためにタブ側で持つ。
  const [selectedImageIds, setSelectedImageIds] = useState<Set<string>>(new Set());

  const runSmartCropForDataset = useCallback(async (ids?: string[], kinds?: SmartCropKind[]) => {
    // 対象を絞れる（2026-09-21）。165枚×3種を一括で切り出すと上限500枚を
    // 超えるうえ、要らない構図まで増えてキャプション解析の無料枠も食う。
    const want = ids && ids.length ? new Set(ids) : null;
    const kindSet = kinds && kinds.length ? new Set(kinds) : null;
    const candidates = imagesRef.current.filter(
      (img) => !img.cropKind && (!want || want.has(img.id)),
    );
    if (!candidates.length) return;
    setSmartCropBusy(true);
    setSmartCropProgress({ done: 0, total: candidates.length });
    setErrorMessage(null);
    const failures: string[] = [];
    // 数が合わないという指摘（2026-09-22）に応えるため、全部を数えて最後に
    // 1回だけ内訳を出す。「対象 = 追加 + 除外 + 作れなかった」が必ず合う。
    const rejected = { upscaled: 0, redundant: 0, tooSmall: 0 };
    let kept = 0;
    let noOutput = 0;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        const outputs = await runSmartCrop(candidate.file);
        const keep = outputs.filter((o) => {
          if (kindSet && !kindSet.has(o.kind)) return false;
          // 拡大しすぎ（＝切り出し元が小さい）＝ボケた画像を学習させるだけ。
          // 1024x1536 の全身写真から顔を切ると約7倍になるのが典型。
          if (o.upscale > SMART_CROP_MAX_UPSCALE) {
            rejected.upscaled += 1;
            return false;
          }
          if (Math.min(o.width, o.height) < SMART_CROP_MIN_SHORT_EDGE) {
            rejected.tooSmall += 1;
            return false;
          }
          // 元画像とほぼ同じ範囲＝情報が増えない重複（全身→全身）。
          if (o.coverage >= SMART_CROP_REDUNDANT_COVERAGE) {
            rejected.redundant += 1;
            return false;
          }
          return true;
        });
        // 人物が検出できないと runSmartCrop は全身1枚（フォールバック）しか
        // 返さないため、顔・上半身だけを選んでいると何も作れない。
        const wanted = outputs.filter((o) => !kindSet || kindSet.has(o.kind));
        if (wanted.length === 0) noOutput += 1;
        kept += keep.length;
        addDatasetFiles(keep.map((o) => ({ file: o.file, cropKind: o.kind })));
      } catch (err) {
        failures.push(candidate.file.name);
        console.error("[LoraStudioTab] smart crop failed:", candidate.file.name, err);
      }
      setSmartCropProgress({ done: i + 1, total: candidates.length });
    }
    setSmartCropBusy(false);
    setSmartCropProgress(null);
    // 切り出しが終わったら選択は解除する（2026-09-22、ホスト指摘）。
    // 診断から飛んできた選択がそのまま残っていると、次の工程（学習回数）で
    // 「なぜこれだけ選ばれているのか」が分からなくなる。
    setSelectedImageIds(new Set());
    // 上のサムネイル一覧が数十行ぶん伸びるので、放っておくとクロップ欄が
    // 画面外へ押し出される。切り出し結果の一覧まで戻す。
    requestAnimationFrame(() =>
      document
        .getElementById(CROP_REVIEW_PANEL_ID)
        // block:"end" で画面の下側に出す。上に切り出した画像が見えた状態で
        // 「確認してください」が読める（2026-09-22、ホスト指摘）。
        ?.scrollIntoView({ behavior: "smooth", block: "end" }),
    );
    setAddNotice(
      `元画像 ${candidates.length} 枚から ${kept} 枚を切り出してデータセットに追加しました。` +
        ` 内訳: 生成 ${kept + rejected.upscaled + rejected.redundant + rejected.tooSmall} 枚` +
        ` → 採用 ${kept}` +
        (rejected.upscaled
          ? ` / 切り出し元が小さすぎて除外 ${rejected.upscaled}（${SMART_CROP_MAX_UPSCALE}倍以上に引き伸ばされるため。全身写真から顔アップを作っても、ぼけた顔を学習させるだけです）`
          : "") +
        (rejected.tooSmall
          ? ` / 小さすぎて除外 ${rejected.tooSmall}（短辺 ${SMART_CROP_MIN_SHORT_EDGE}px 未満。元画像の中でその部分が小さすぎます）`
          : "") +
        (rejected.redundant
          ? ` / 元画像とほぼ同じ範囲で除外 ${rejected.redundant}（情報が増えません）`
          : "") +
        (noOutput
          ? `。 ${noOutput} 枚は人物の骨格を検出できず、選んだ構図を作れませんでした。`
          : "。"),
    );
    if (failures.length) {
      setErrorMessage(
        `${failures.length} 枚でスマートクロップに失敗しました（人物の骨格が検出できなかった可能性があります）: ` +
          failures.slice(0, 3).join(", ") +
          (failures.length > 3 ? " ほか" : ""),
      );
    }
  }, [addDatasetFiles]);

  // 画像ごとの学習回数（kohya のフォルダ名 "10_name" 相当）をまとめて設定する。
  // ⚠️ 総ステップ数は固定なので消費クレジットは変わらない（構成比だけが変わる）。
  // 「見た目の固定特徴」は日本語で入力してもらい、Danbooru タグへは自動変換する
  // （2026-09-21、ホスト指摘「入れるにしても日本語じゃないと使い勝手が悪い」）。
  // 同じ情報を日本語と英タグで2回入力させていたのを1つに統合した。変換は既存の
  // /api/studio/lora/translate（action "to_en" + caption_type "tags"）をそのまま
  // 使う——日本語→Danbooru タグ列はこのルートの本来の仕事なので新設不要。
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  // ベースモデルの選択欄を触ったか（導線の表示だけに使う。loraFlowStep 参照）。
  const [baseModelTouched, setBaseModelTouched] = useState(false);
  // 「解析を開始」が押されたか（2026-09-22）。取り込みの途中で特徴抽出や
  // キャプション解析が走らないようにするための、ユーザーからの明示的な合図。
  // タイマーでは「取り込みが終わった」を判定できないため。
  const [analysisStarted, setAnalysisStarted] = useState(false);

  // 画像から identity タグを抽出する（ホスト方針「画像解析結果から抽出される
  // が、最終的には不要なら削除・不足なら追加」）。返るのは候補で、確定は
  // ユーザーが行う。渡すのは「その被写体が写っているキャプション済み画像」の
  // 先頭6枚——サムネイルはキャプションと同じキャッシュを使うので追加の
  // デコードは発生しない。
  const [identityExtracting, setIdentityExtracting] = useState<number | null>(null);
  const extractIdentityFor = useCallback(
    async (index: number, trigger: string, hintJa: string, fixedTags = "") => {
      const t = trigger.trim();
      if (!t) return;
      // キャプション前でも動かす（2026-09-21、ホスト指摘「画像から抽出を
      // デフォルトにして、抽出結果を表示して追加・削除してもらう流れ」）。
      // 複数人が写っていても、日本語の特徴をヒントとして渡すので Gemini 側で
      // 対象を選り分けられる（identity-tags の buildPrompt 参照）。
      // キャプション済みならその被写体のトリガーで始まる画像を優先する。
      const captioned = images.filter((img) => (captions[img.id] ?? "").trim());
      const mine = captioned.filter((img) =>
        (captions[img.id] ?? "").toLowerCase().startsWith(t.toLowerCase()),
      );
      // キャプション前は「誰が写っているか」が分からない。先頭6枚を取ると
      // フォルダ単位で偏って片方の被写体しか入らないので（2026-09-22、
      // ホスト報告「男と女が混じる」）、全体から等間隔で拾う。誰を見るかは
      // 性別タグで API 側に指定する。
      const source = mine.length > 0 ? mine : captioned.length > 0 ? captioned : images;
      const step = Math.max(1, Math.floor(source.length / 6));
      const pool = source
        .filter((_, k) => k % step === 0)
        .slice(0, 6)
        .map((img) => img.file);
      if (pool.length === 0) return;
      setIdentityExtracting(index);
      try {
        const tags = await extractIdentityTags(pool, t, hintJa, fixedTags);
        const en = tags.map((x) => x.en).join(", ");
        const ja = tags.map((x) => x.ja).join(", ");
        if (index < 0) {
          setPrimaryIdentityTags(en);
          setPrimaryIdentityTagsJa(ja);
        } else {
          setExtraSubjects((prev) =>
            prev.map((p, k) => (k === index ? { ...p, identityTags: en, identityTagsJa: ja } : p)),
          );
        }
        setIdentityConfirmed(false);
      } catch (err) {
        console.warn("[lora] identity extraction failed:", err);
        // 失敗したら「実行済み」の印を消して、次の変化でやり直せるようにする。
        autoExtractedRef.current.delete(`${index}:${t}:${fixedTags}`);
        setErrorMessage(
          err instanceof Error ? err.message : "特徴の抽出に失敗しました。手で入力してください。",
        );
      } finally {
        setIdentityExtracting(null);
      }
    },
    [images, captions],
  );

  const setImageRepeats = useCallback((ids: string[], repeats: number) => {
    const target = new Set(ids);
    const n = Math.min(MAX_IMAGE_REPEATS, Math.max(1, Math.round(repeats)));
    setImages((prev) =>
      prev.map((img) => (target.has(img.id) ? { ...img, repeats: n } : img)),
    );
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((i) => i.id !== id);
    });
    setCaptions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setCaptionsJa((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    captionAttemptedRef.current.delete(id);
    setCaptionErrorIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setUserCaptionIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // metadata へ埋め込むタグ。被写体レジストリから自動生成し、手入力欄は
  // 「追加分」として後ろに連結する（2026-09-21 — 以前は全部手入力だった）。
  const autoEmbedTags = useMemo(() => buildEmbedTagsFromSubjects(allSubjects), [allSubjects]);
  // 診断の入力。キャプション済みの画像だけを渡す（未解析は数えても意味が無い）。
  const diagnosticItems = useMemo(
    () =>
      images
        .map((img) => ({ caption: (captions[img.id] ?? "").trim(), repeats: img.repeats ?? 1 }))
        .filter((x) => x.caption.length > 0),
    [images, captions],
  );
  // 学習回数の一括選択チップ（2026-09-21、ホスト指摘）。165枚を1枚ずつ
  // shift+クリックするのは非現実的なので、キャプションから「被写体」と
  // 「構図（距離）」の2軸を作る。判定は診断と同じ関数を通すので、
  // 「診断が全身が多いと言う」→「全身チップで選べる」が必ず一致する。
  const selectionGroups = useMemo(() => {
    const captioned = images.filter((img) => (captions[img.id] ?? "").trim());
    if (captioned.length === 0) return [];

    const subjMap = new Map<string, { label: string; ids: string[] }>();
    const distMap = new Map<string, { label: string; ids: string[] }>();
    const push = (m: Map<string, { label: string; ids: string[] }>, id: string, label: string, imgId: string) => {
      const e = m.get(id) ?? { label, ids: [] };
      e.ids.push(imgId);
      m.set(id, e);
    };

    for (const img of captioned) {
      const cap = (captions[img.id] ?? "").trim();
      const hits = matchLeadingSubjectTriggers(cap, allSubjects);
      if (hits.length === 0) push(subjMap, "__none__", "未分類", img.id);
      else if (hits.length === 1) push(subjMap, hits[0].trigger, hits[0].trigger, img.id);
      else {
        // 2人以上が同時に写っている画像（duo）。片方だけの画像と分けて
        // 比率を触れるようにするのが目的なので、組み合わせごとに1つ。
        const key = hits.map((h) => h.trigger).join("+");
        push(subjMap, key, `${hits.map((h) => h.trigger).join(" + ")}（同時）`, img.id);
      }
      const buckets = captionBuckets(cap, "distance");
      if (buckets.length === 0) push(distMap, "__none__", "未分類", img.id);
      for (const b of buckets) {
        const def = DIAGNOSTIC_AXES.distance.buckets.find((x) => x.id === b);
        push(distMap, b, def?.label ?? b, img.id);
      }
    }

    const toOptions = (m: Map<string, { label: string; ids: string[] }>) =>
      [...m.entries()]
        .map(([id, v]) => ({ id, label: v.label, ids: v.ids }))
        .sort((a, b) => b.ids.length - a.ids.length);

    // 取り込んだ元画像か、切り出したものか（2026-09-22、ホスト指摘）。
    // 「duo 判定になった切り出しだけを見たい」のように、他の軸と掛け合わせて
    // 点検するのに要る。クロップは他キャラの端が写り込むことがあるため。
    const kindMap = new Map<string, { label: string; ids: string[] }>();
    for (const img of captioned) {
      push(kindMap, img.cropKind ? "crop" : "orig", img.cropKind ? "切り出し" : "取り込み", img.id);
    }

    const groups: { key: string; title: string; options: { id: string; label: string; ids: string[] }[] }[] = [];
    if (subjMap.size > 1) groups.push({ key: "subject", title: "被写体", options: toOptions(subjMap) });
    if (distMap.size > 1) groups.push({ key: "distance", title: "構図", options: toOptions(distMap) });
    if (kindMap.size > 1) groups.push({ key: "origin", title: "種別", options: toOptions(kindMap) });
    return groups;
  }, [images, captions, allSubjects]);

  // 診断の「◯◯ の元画像を選んでクロップ欄へ」。実際の切り出しは実行しない
  // （実行ボタンが2つあると対象が分からなくなる。2026-09-21 ホスト指摘）。
  // 対象は「その被写体が写っていて、まだ切り出していない元画像」。
  const [cropKindSelection, setCropKindSelection] = useState<Set<SmartCropKind>>(
    new Set<SmartCropKind>(["face", "upper", "full"]),
  );

  const prepareCropForSubject = useCallback(
    (subject: string, kinds: ("face" | "upper")[]) => {
      // duo 画像も対象に含める（2026-09-22、ホスト指摘「duo画像が完全に弾かれて
      // 素材が集まらない」）。一度は「その被写体だけの画像」に限定したが、
      // kocho は単独21枚しか無く素材が足りなくなる。検出を2人まで広げた
      // （smartCropDetect の numPoses/numFaces = 2）ので、duo からは**両方**を
      // 切り出す。どちらがどの被写体かは後段のキャプションが判定するので、
      // 狙った側が取れないという問題も起きない。
      const ids = images
        .filter((img) => {
          if (img.cropKind) return false;
          const cap = (captions[img.id] ?? "").trim();
          if (!cap) return false;
          return matchLeadingSubjectTriggers(cap, allSubjects).some((x) => x.trigger === subject);
        })
        .map((img) => img.id);
      setSelectedImageIds(new Set(ids));
      // 診断が「この構図が足りない」と言っている以上、切り出す構図もそこへ
      // 合わせる（余計な構図まで作らせない）。
      if (kinds.length) setCropKindSelection(new Set<SmartCropKind>(kinds));
      document.getElementById(SMART_CROP_PANEL_ID)?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    [images, captions, allSubjects],
  );

  // キャプションに実際に入っている被写体の内訳（2026-09-21、ホスト指摘）。
  // 以前は主トリガーだけを見て「全キャプションの先頭に hitozuma を反映済み」
  // と出しており、kocho 単独の画像がある構成では単純に嘘だった。
  // キャプション自体は API 側が subjects 全体を見て振り分けているので正しい。
  const captionSubjectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let none = 0;
    let total = 0;
    for (const img of images) {
      const cap = (captions[img.id] ?? "").trim();
      if (!cap) continue;
      total += 1;
      const hits = matchLeadingSubjectTriggers(cap, allSubjects);
      if (hits.length === 0) {
        none += 1;
        continue;
      }
      const key = hits.map((h) => h.trigger).join(" + ");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
      total,
      none,
      rows: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [images, captions, allSubjects]);

  // 構図の偏りを均す学習回数を一括適用する（2026-09-21、ホスト指摘
  // 「どれだけ増やせば良いのかがわかりにくい」）。キャプションが付いている
  // 画像だけが対象で、被写体ごとに一番多い距離バケットへ揃える（上限×4）。
  const applySuggestedRepeats = useCallback(() => {
    const captioned = images.filter((img) => (captions[img.id] ?? "").trim());
    if (captioned.length === 0) return;
    const sug = suggestRepeats(
      captioned.map((img) => ({ caption: (captions[img.id] ?? "").trim() })),
      allSubjects,
    );
    const byRepeat = new Map<number, string[]>();
    captioned.forEach((img, k) => {
      const n = sug[k] ?? 1;
      const list = byRepeat.get(n) ?? [];
      list.push(img.id);
      byRepeat.set(n, list);
    });
    for (const [n, ids] of byRepeat) setImageRepeats(ids, n);
    setRepeatsNotice(
      "構図の偏りを均す学習回数を入れました: " +
        [...byRepeat.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([n, ids]) => `×${n} が ${ids.length} 枚`)
          .join(" / ") +
        "。多い構図を下げることはできないので、少ない構図を上げる形になります。個別に直せます。",
    );
  }, [images, captions, allSubjects, setImageRepeats]);

  // 画像id -> 距離バケット（クロップ候補の絞り込みに使う）。判定は診断と同じ。
  const distanceById = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const img of images) {
      const cap = (captions[img.id] ?? "").trim();
      if (cap) out[img.id] = captionBuckets(cap, "distance");
    }
    return out;
  }, [images, captions]);

  const croppedImages = useMemo(() => images.filter((i) => i.cropKind), [images]);
  // キャプションが付いていない画像（＝解析が拒否された／届かなかったもの）。
  const uncaptionedImages = useMemo(
    () => images.filter((i) => !(captions[i.id] ?? "").trim() && !userCaptionIds.has(i.id)),
    [images, captions, userCaptionIds],
  );

  // 切り出したのに2人以上写っていると判定された画像（2026-09-22、ホスト提案）。
  // クロップは「1人を切り出す」操作なので、結果に2人いるのは
  //   (a) カップル構図を切って両方の顔が入った（正当）
  //   (b) 隣の人物の腕や袖が残ってキャプションが拾った（削除対象）
  // のどちらか。どちらも目視が要るのでここへ集める。集計の差分を突き合わせる
  // 方式と違い、**同時に複数被写体ぶんクロップしても1枚ずつ判定できる**。
  const multiSubjectCrops = useMemo(() => {
    if (allSubjects.filter((x) => x.trigger.trim()).length < 2) return [];
    return croppedImages.filter((img) => {
      const cap = (captions[img.id] ?? "").trim();
      if (!cap) return false;
      return matchLeadingSubjectTriggers(cap, allSubjects).length >= 2;
    });
  }, [croppedImages, captions, allSubjects]);

  // 手で足した特徴を1語だけ英訳する（2026-09-22）。以前は日本語のまま英側へ
  // 入り、LoRA の metadata に日本語タグが焼かれていた。
  const translateIdentityTag = useCallback(async (ja: string): Promise<string> => {
    try {
      const tags = await translateCaption(ja, "to_en", "tags");
      return (tags || "")
        .split(SPLIT_TAGS_RE)
        .map((x) => x.trim())
        .filter(Boolean)[0] ?? "";
    } catch {
      return "";
    }
  }, []);

  // 「画像から抽出」はボタンではなく自動実行（2026-09-22、ホスト指摘）。
  // 画像が入っていてトリガーワードがあり、まだ特徴が空の被写体だけを対象に
  // 1回ずつ走らせる。effect の中で同期 setState はしない（非同期の完了時に
  // extractIdentityFor が自前で state を更新する）。
  // 「別の人物を追加」の直後にフォーカスを当てる被写体の index。
  const focusSubjectRef = useRef<number | null>(null);
  const autoExtractedRef = useRef<Set<string>>(new Set());
  // 抽出をやり直す（結果がおかしかったとき用）。自動実行は1回きりなので、
  // これが無いと直す手段が手入力しか無くなる（2026-09-22）。
  const redoIdentityExtract = useCallback(
    (index: number) => {
      const sub =
        index < 0
          ? { trigger: triggerWord.trim(), hint: primaryDescription, fixedTags: primaryFixedTags }
          : {
              trigger: (extraSubjects[index]?.trigger ?? "").trim(),
              hint: extraSubjects[index]?.description ?? "",
              fixedTags: extraSubjects[index]?.fixedTags ?? "",
            };
      if (!sub.trigger) return;
      autoExtractedRef.current.delete(`${index}:${sub.trigger}:${sub.fixedTags}`);
      if (index < 0) {
        setPrimaryIdentityTags("");
        setPrimaryIdentityTagsJa("");
      } else {
        setExtraSubjects((prev) =>
          prev.map((p, k) => (k === index ? { ...p, identityTags: "", identityTagsJa: "" } : p)),
        );
      }
      void extractIdentityFor(index, sub.trigger, sub.hint, sub.fixedTags);
    },
    // extractIdentityFor は毎レンダー作り直されるので依存から外す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [triggerWord, primaryDescription, primaryFixedTags, extraSubjects],
  );
  useEffect(() => {
    if (images.length === 0) return;
    // ⚠️ タイマーでは「取り込みが終わった」を判定できない（2026-09-22、
    // ホスト指摘）。前半のフォルダに片方の被写体しか入っていない状態で発火
    // すると、もう一方は1人も写っていない6枚を見ることになり、間違った特徴が
    // 1回きりの抽出で確定する。フォルダ間の間隔は何秒でも空き得るので、
    // 秒数をいくら伸ばしても解決しない。**ユーザーが明示的に開始を押すまで
    // 走らせない。**
    if (!analysisStarted) return;
    {
    const jobs = [
      {
        index: -1,
        trigger: triggerWord.trim(),
        hint: primaryDescription,
        fixedTags: primaryFixedTags,
        has: !!primaryIdentityTags.trim(),
      },
      ...extraSubjects.map((sub, i) => ({
        index: i,
        trigger: (sub.trigger ?? "").trim(),
        hint: sub.description ?? "",
        fixedTags: sub.fixedTags ?? "",
        has: !!(sub.identityTags ?? "").trim(),
      })),
    ];
    for (const j of jobs) {
      if (!j.trigger || j.has) continue;
      // 性別タグは「誰を見るか」の決定打なので、埋まるまで待つ。
      if (!j.fixedTags.trim()) continue;
      const key = `${j.index}:${j.trigger}:${j.fixedTags}`;
      if (autoExtractedRef.current.has(key)) continue;
      autoExtractedRef.current.add(key);
      void extractIdentityFor(j.index, j.trigger, j.hint, j.fixedTags);
    }
    }
    // extractIdentityFor は毎レンダー作り直されるので依存から外す（キーで
    // 二重実行を防いでいる）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisStarted, images.length, triggerWord, primaryIdentityTags, primaryFixedTags, extraSubjects]);

  // 被写体の「特徴」欄の説明を読んだか（初回だけ出す）。初期値を lazy に
  // 読むので effect で setState する必要がない。SSR では false のまま。
  const [subjectHintSeen] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      const seen = Boolean(window.localStorage.getItem(SUBJECT_HINT_SEEN_KEY));
      if (!seen) window.localStorage.setItem(SUBJECT_HINT_SEEN_KEY, "1");
      return seen;
    } catch {
      return false; // プライベートウィンドウ等。出し続けても害は無い
    }
  });

  const multiSubjectCropIds = useMemo(
    () => new Set(multiSubjectCrops.map((i) => i.id)),
    [multiSubjectCrops],
  );

  const tooSmallImages = useMemo(() => images.filter((i) => i.sizeVerdict === "tooSmall"), [images]);

  // 手入力の追加欄は 2026-09-22 に廃止。被写体レジストリから作った分だけ。
  const effectiveEmbedTags = autoEmbedTags;

  const totalBytes = useMemo(() => images.reduce((s, i) => s + i.file.size, 0), [images]);

  const nameValid = LORA_NAME_RE.test(loraName.trim());
  // Admin-only: a non-admin toggling pro.useRawYaml (persisted draft, React
  // devtools, …) still resolves to yamlMode === false, so every downstream
  // consumer — canSubmit, trainingConfig, price, effective name/trigger —
  // takes the GUI-slider path and custom_yaml_override is never sent.
  const yamlMode = pro.useRawYaml && isAdmin;

  // オートが実際に使う値（= エキスパートの出発点であるべき値）。
  // rank/alpha は LoRA のカテゴリ、ステップ数は取り込んだ枚数で決まる。
  const autoConfig = useMemo(() => {
    const { rank, alpha } = autoLoraRankAlpha(captionCategory);
    // SDXL は step の式が別（loraCredits.ts）。pricedArch はこの下で定義されるので同じ式をここで引く。
    const archForSteps = modelChoice === "__custom__" ? baseArchitecture : (loraPresetById(modelChoice)?.arch ?? "");
    return { rank, alpha, steps: autoLoraSteps(images.length, archForSteps) };
  }, [captionCategory, images.length, modelChoice, baseArchitecture]);

  // エキスパートへ入った瞬間に alpha 16→32 / steps 2830→2000 のように値が
  // 静かに変わっていた（DEFAULT_PRO が枚数もカテゴリも見ない固定値だった
  // ため）。まだ一度も触られていない場合に限り、オートの推奨値を初期値
  // として流し込む（2026-09-21、ホスト指摘）。
  // オートモードは廃止（2026-09-22、ホスト判断）。経路は1本で、設定値は
  // **入力画像から自動で決まる**。ユーザーはそれを見て、変えたければ変える。
  //
  // 「まだ一度も触っていない」間はオートの推奨値をそのまま見せ、触った瞬間に
  // その値が確定する。state を書き換えずに導出するので、枚数やカテゴリが
  // 変わればまだ触っていない項目は追従する（以前は『エキスパートに入った
  // 瞬間に固定値へ切り替わる』という挙動で、alpha と steps が黙って変わった）。
  const proPristine =
    pro.rank === DEFAULT_PRO.rank &&
    pro.alpha === DEFAULT_PRO.alpha &&
    pro.steps === DEFAULT_PRO.steps &&
    pro.learningRate === DEFAULT_PRO.learningRate &&
    !pro.lrCustom &&
    pro.optimizer === DEFAULT_PRO.optimizer;
  const effPro: ProConfig = useMemo(
    () =>
      proPristine
        ? { ...pro, rank: autoConfig.rank, alpha: autoConfig.alpha, alphaLinked: false, steps: autoConfig.steps }
        : pro,
    [proPristine, pro, autoConfig],
  );
  /** 設定を1つ変える。未編集だった場合はオートの推奨値ごと確定させる。 */
  const updatePro = useCallback(
    (patch: Partial<ProConfig>) => setPro((p) => ({ ...(proPristine ? effPro : p), ...patch })),
    [proPristine, effPro],
  );
  // Live YAML syntax check for the raw-YAML editor — drives the badge below
  // the textarea and gates the submit button. Only meaningful in yamlMode.
  const yamlCheck = useMemo(
    () => (yamlMode ? validateLoraYaml(pro.rawYaml) : null),
    [yamlMode, pro.rawYaml],
  );
  // In raw-YAML mode the YAML's config.name / process[0].trigger_word are
  // authoritative — the form's LoRA-name / trigger fields are disabled and
  // just mirror these values.
  const yamlIdentity = useMemo(
    () => (yamlMode && yamlCheck?.ok ? loraYamlIdentity(yamlCheck.data) : null),
    [yamlMode, yamlCheck],
  );
  const effectiveLoraName = yamlMode ? (yamlIdentity?.name ?? "") : loraName.trim();
  const effectiveTrigger = yamlMode ? (yamlIdentity?.triggerWord ?? "") : triggerWord.trim();
  const yamlNameValid = !yamlMode || LORA_NAME_RE.test(effectiveLoraName);
  // Mirrors the worker's _derive_trigger: explicit trigger, else the first
  // alnum run of the LoRA name. Used to protect the token during translation.
  const curationTrigger = effectiveTrigger || (effectiveLoraName.match(/[A-Za-z0-9]+/)?.[0] ?? "");

  // Heavy-config warning: 1280px + 100+ images → the 3D-VAE latent-cache
  // phase alone can blow past the worker's early-safety-stop.
  const resolutionHas1280 = useMemo(() => {
    if (yamlMode && yamlCheck?.ok) {
      const p0 = (yamlCheck.data as { config?: { process?: Array<{ datasets?: Array<{ resolution?: unknown }> }> } })
        ?.config?.process?.[0];
      const rs = p0?.datasets?.[0]?.resolution;
      return Array.isArray(rs) && rs.some((r) => Number(r) >= 1280);
    }
    return Number(resolution) >= 1280;
  }, [yamlMode, yamlCheck, resolution]);
  const heavyConfigWarn = resolutionHas1280 && images.length > 100;

  // 確定済みの identity リスト（日本語表示があれば日本語、無ければ英タグ）。
  // 2026-09-21 の宣言方式移行で、これがキャプションのブラックリストになる。
  // 被写体が複数いる場合は「◯◯: a, b / △△: c」の形で全員ぶんを渡す。
  const confirmedIdentityJa = useMemo(() => {
    const parts = allSubjects
      .map((sub) => {
        const list = (sub.identityTagsJa ?? "").trim() || (sub.identityTags ?? "").trim();
        return list ? `${sub.trigger.trim() || "被写体"}: ${list}` : "";
      })
      .filter(Boolean);
    return parts.join(" / ");
  }, [allSubjects]);

  const captionSpec: LoraCaptionSpec = useMemo(
    () => ({
      category: captionCategory,
      // 手入力欄より確定リストを優先する。リストが空のときだけ手入力
      // （および、それも空ならカテゴリ既定）へフォールバックする。
      fixed: confirmedIdentityJa || captionFixed.trim(),
      varying: captionVarying.trim(),
    }),
    [captionCategory, confirmedIdentityJa, captionFixed, captionVarying],
  );
  const captionSpecFilled = captionSpecHasInput(captionSpec);
  const captionCategoryMeta = LORA_CAPTION_CATEGORY_META[captionCategory];

  // A stable identity for "what the captions currently reflect": trigger +
  // spec + any manual override. Re-analysis is only needed when this changes.
  // キャプションが「どの設定で作られたか」の記録（reflectedSpecKey）が空のとき
  // は**不明**であって「変わった」ではない（2026-09-22、ホスト報告「何も変えて
  // ないのに作り直しの警告が出た」）。キャッシュからキャプションを戻しただけの
  // 状態がこれに当たり、以前は毎回「食い違っているかも」と判定して警告を出し、
  // 次へ進むと全キャプションを作り直していた。記録はキャプション解析が一度でも
  // 走れば埋まり、下書きにも保存されるので、空のままなのは初回だけ。
  const captionSpecStale = (key: string, reflected: string) => reflected !== "" && key !== reflected;
  // 記録済みキーから「学習したい特徴」だけ取り出す（差分表示用）。キーは
  // JSON.stringify([trigger, override, category, filled ? [fixed, varying] : null])。
  const reflectedSpecSummary = useMemo(() => {
    if (!reflectedSpecKey) return "";
    try {
      const parsed = JSON.parse(reflectedSpecKey) as unknown[];
      const pair = parsed[3];
      return Array.isArray(pair) ? String(pair[0] ?? "") : "";
    } catch {
      return "";
    }
  }, [reflectedSpecKey]);

  const captionSpecKey = useMemo(
    () =>
      JSON.stringify([
        curationTrigger,
        captionPromptOverride.trim(),
        // Category always counts — even with no fixed/varying text it now
        // drives the server-side blacklist/whitelist policy, so switching it
        // must invalidate the "captions already reflect the spec" guard.
        captionSpec.category,
        captionSpecFilled ? [captionSpec.fixed, captionSpec.varying] : null,
      ]),
    [curationTrigger, captionPromptOverride, captionSpecFilled, captionSpec],
  );
  const captionSpecKeyRef = useRef(captionSpecKey);
  useEffect(() => {
    captionSpecKeyRef.current = captionSpecKey;
  }, [captionSpecKey]);
  // Selected training type, mirrored into a ref so the caption callbacks can
  // forward it to /api/studio/lora/caption without re-creating themselves.
  const captionCategoryRef = useRef<LoraCaptionCategory>(captionCategory);
  useEffect(() => {
    captionCategoryRef.current = captionCategory;
  }, [captionCategory]);
  // 複数被写体リスト（2件以上で有効）。同じ理由で ref 経由にする。
  const subjectsRef = useRef<LoraSubject[]>(allSubjects);
  useEffect(() => {
    subjectsRef.current = allSubjects;
  }, [allSubjects]);

  // The English instruction to hand the vision API *right now*, with zero
  // network round-trip: a manual override wins, else the deterministic
  // fallback built from the JP fixed/varying spec, else "" (worker default).
  const currentCaptionPrompt = useCallback((): string => {
    const manual = captionPromptOverride.trim();
    if (manual) return manual;
    if (hasUserCaptionsRef.current || !captionSpecFilled) return "";
    return (
      resolvedCaptionPromptRef.current.trim() ||
      buildCaptionFallbackPrompt(captionSpec, curationTrigger)
    );
  }, [captionPromptOverride, captionSpecFilled, captionSpec, curationTrigger]);

  // Escape a user string for use inside a RegExp.
  const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Swap the leading trigger token of one caption from `from` to `to`. Leaves
  // a caption that doesn't start with `from` untouched (so a user caption with
  // no trigger isn't force-prefixed) unless `force` (AI captions always get
  // the current trigger).
  const swapLeadingTrigger = useCallback(
    (text: string, from: string, to: string, force: boolean): string => {
      const t = text.trim();
      if (!t) return text;
      let body = t;
      let had = false;
      // Leading token must BE the trigger — not merely start with it
      // ("cat" must not match "catgirl, …").
      const leadRe = (tok: string) =>
        new RegExp(`^\\s*${reEscape(tok)}(?=$|[\\s,、])\\s*[,、]?\\s*`, "i");
      if (from) {
        const re = leadRe(from);
        if (re.test(body)) {
          body = body.replace(re, "").trim();
          had = true;
        }
      }
      // Already carries the new trigger (e.g. route set it) — normalise spacing.
      if (to) {
        const hasNew = leadRe(to);
        if (hasNew.test(body)) return body.replace(hasNew, `${to}, `).trim();
      }
      if (!to) return had ? body : text;
      if (had) return body ? `${to}, ${body}` : to;
      return force ? `${to}, ${body}` : text;
    },
    [],
  );
  // Alpha follows Rank unless the user explicitly unlinks it. Nullish (a
  // pre-existing `pro` object from before this flag existed, kept across a
  // dev Fast Refresh) counts as linked so the default is genuinely ON.
  const alphaLinked = pro.alphaLinked ?? true;
  // When linked, Alpha is always exactly Rank regardless of what's stored.
  const effectiveAlpha = alphaLinked ? pro.rank : pro.alpha;

  const isCustom = modelChoice === "__custom__";
  const customBlocked = isCustom && isBlockedLoraModel(customModelId);
  const customValid = isCustom && customModelId.trim().length >= 2 && !customBlocked;
  const modelValid = !isCustom || customValid;

  const targetModel = isCustom ? "custom" : modelChoice;
  const selectedPreset = isCustom ? undefined : loraPresetById(modelChoice);
  const pricedArch = isCustom ? baseArchitecture : (selectedPreset?.arch ?? "");
  // sd-scriptsワーカー（Illustrious/Juggernaut等）限定のメタデータタグ
  // 埋め込み機能。arch==="sdxl"のジョブだけ対象（route.tsのisSdxlJobと同じ
  // 判定）。生YAMLモードは生YAML自体をsd-scriptsワーカーが受け付けないため
  // 対象外（route.tsが400で拒否する）。
  const isSdxlJob = pricedArch === "sdxl";
  // 非同期コールバック（runVisionCaptions の完了処理）から参照するため。
  const isSdxlJobRef = useRef(isSdxlJob);
  useEffect(() => {
    isSdxlJobRef.current = isSdxlJob;
  }, [isSdxlJob]);

  // metadata に何か埋め込む LoRA では、内容を目視確認するまで学習させない。
  // 納品物に焼かれてユーザーの手元へ渡るものなので、黙って確定させない。
  const needsIdentityConfirm = useMemo(
    () => !yamlMode && isSdxlJob && autoEmbedTags.trim().length > 0 && !identityConfirmed,
    [yamlMode, isSdxlJob, autoEmbedTags, identityConfirmed],
  );

  // Caption FORMAT resolved for the model in the dropdown right now. The key
  // blends preset id + arch + label + (custom) base architecture so a tag
  // hint anywhere (illustrious / juggernaut / sdxl / pony / sd15) routes to
  // the CLIP tag pipeline; everything else is dense prose.
  const captionModelKey = isCustom
    ? `${customModelId} ${baseArchitecture}`
    : `${modelChoice} ${selectedPreset?.arch ?? ""} ${selectedPreset?.label ?? ""}`;
  const resolvedCaptionMode: ResolvedCaptionMode = resolveCaptionMode(captionModelKey, captionMode);
  const captionModelLabel = isCustom
    ? customModelId.trim() || "カスタムモデル"
    : (selectedPreset?.label ?? modelChoice);
  // Read by the (async) vision passes when a request resolves, long after any
  // render — a ref keeps them on the current model's format without threading
  // it through every recaption entry point.
  const resolvedCaptionModeRef = useRef<ResolvedCaptionMode>(resolvedCaptionMode);
  useEffect(() => {
    resolvedCaptionModeRef.current = resolvedCaptionMode;
  }, [resolvedCaptionMode]);

  // A job dispatched this session that is still running server-side.
  // Non-null independent of `phase` — it stays true after the tracking
  // panel's soft "フォームに戻る（学習は継続）", which leaves `job` /
  // polling alone and only flips phase back to "form". Drives the form's
  // "戻る" banner and the multi-submit guard below.
  const inFlightJob =
    job && (job.status === "queued" || job.status === "processing") ? job : null;
  // Short progress descriptor for the in-flight banner / disabled submit
  // button — "起動準備中" while queued, else the live % (or a plain
  // "学習中" fallback before the first progress tick arrives).
  const inFlightProgressLabel = inFlightJob
    ? inFlightJob.status === "queued"
      ? "起動準備中"
      : inFlightJob.progressPercent != null
        ? `${inFlightJob.progressPercent}%`
        : "学習中"
    : "";
  // A finished job whose artefact-download panel must stay reachable until the
  // user explicitly starts a new run. Like `inFlightJob`, it survives a soft
  // "フォームに戻る" — only resetForm() / a fresh dispatch drops it.
  const completedJob = job && job.status === "completed" ? job : null;

  // 推定GPU秒ベースの動的価格、live (src/lib/loraPricing.ts):
  //   ceil( (prep(枚数) + steps × s/it(arch, 解像度, バッチ)) × クレジット単価 )
  //  - エキスパート(生YAML): price the live-parsed ai-toolkit config; an
  //    unparseable / step-less YAML shows the worst-case ceiling.
  //  - エキスパート(スライダー): pro.rank / pro.steps をそのまま使う。
  //  - オート: 画像枚数に応じて動的に決まる autoLoraSteps() と、LoRAタイプ
  //    （人物 vs 画風寄り）で決まる autoLoraRankAlpha() を使う
  //    （2026-09-14/15〜。以前はどちらも一律固定値だった — ホスト指摘・
  //    外部一次情報に基づく見直し）。サーバー側(/api/studio/lora/train)も
  //    同じ関数で同じ値を再計算するので見積りと実際の課金・学習パラメータが
  //    食い違わない。
  const priceBreakdown = useMemo(() => {
    if (yamlMode) {
      if (yamlCheck?.ok)
        return loraPriceBreakdown(yamlCheck.data, {
          archFallback: pricedArch,
          imageCount: images.length,
          knobs: pricingKnobs,
        });
      return null; // worst-case shown below
    }
    return loraPriceBreakdown(
      guiLoraPricingConfig({
        arch: pricedArch,
        resolution,
        linearRank: effPro.rank,
        steps: effPro.steps,
      }),
      {
        spiOverride: selectedPreset?.spiOverride,
        imageCount: images.length,
        knobs: pricingKnobs,
      },
    );
  }, [
    yamlMode,
    yamlCheck,
    pricedArch,
    resolution,
    effPro.rank,
    effPro.steps,
    images.length,
    selectedPreset,
    pricingKnobs,
  ]);
  const requiredCredits =
    priceBreakdown && priceBreakdown.credits > 0
      ? Math.min(LORA_CREDIT_WORST_CASE, priceBreakdown.credits)
      : LORA_CREDIT_WORST_CASE;
  const insufficientCredits = Boolean(user) && !creditsLoading && (credits ?? 0) < requiredCredits;

  // Model dropdown change — resolution はもう手動で追従させない。pricedArch
  // が決まった直後の useEffect が recommendedResolution() から自動で同期する
  // （下記参照）。Rank / Steps / LR / optimizer は引き続きユーザーの調整を
  // そのまま残す。
  const handleModelChange = (value: string) => {
    setModelChoice(value);
    // 性別/人数タグ・複数人物UIはSDXL限定表示（下記JSX）。表示が消えても
    // stateが残っていると、SDXLで設定→非SDXLへ切り替え後もキャプション
    // 生成に古い固定タグが黙って効き続けてしまうため、SDXL以外へ切り替えた
    // 瞬間にクリアする（同じ理由でembed_tags側は非SDXLでは送信自体を
    // isSdxlJobでガードしているが、こちらは送信有無ではなくキャプション
    // 生成ロジック自体が参照するのでstateごと消す必要がある）。
    const nextArch = value === "__custom__" ? baseArchitecture : (loraPresetById(value)?.arch ?? "");
    if (nextArch !== "sdxl") {
      setPrimaryFixedTags("");
      setPrimaryDescription("");
      setExtraSubjects([]);
    }
  };

  const canSubmit =
    phase === "form" &&
    images.length >= 1 &&
    totalBytes <= MAX_TOTAL_BYTES &&
    (yamlMode ? yamlNameValid : nameValid) &&
    modelValid &&
    (yamlMode ? pro.rawYaml.trim().length > 20 && yamlCheck?.ok === true : true);

  // Re-fetches the authoritative credits balance from `profiles` and
  // broadcasts it — used right after a server-side refund (e.g. a normal
  // training failure) where the client never learns the refunded amount
  // from the poll response, so it can't just add it to the local balance
  // the way the pending-timeout failover does.
  const refreshCredits = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase.from("profiles").select("credits").eq("id", user.id).single();
    if (!error && typeof data?.credits === "number") {
      broadcastCreditsUpdate(user.id, data.credits);
    }
  }, [user]);

  const startPolling = useCallback(
    (jobId: string, opts?: { immediate?: boolean }) => {
      // Kill any tick still scheduled by a previous startPolling / keep-alive
      // loop so we never run two overlapping loops for the same job.
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
      pollCancelledRef.current = false;
      activeJobIdRef.current = jobId;
      queuedSinceRef.current = Date.now();
      consecutiveErrorsRef.current = 0;
      setPollRetry(0);
      setPollLost(false);
      console.log(`[lora] startPolling job=${jobId}${opts?.immediate ? " (immediate)" : ""}`);

      const tick = async () => {
        if (pollCancelledRef.current) return;
        const pollingId = activeJobIdRef.current;
        const elapsed = Math.round((Date.now() - (queuedSinceRef.current || Date.now())) / 1000);
        let next: LoraJobStatus | null = null;
        try {
          next = await pollLoraJob(pollingId);
          console.log(`[lora] tick job=${pollingId} status=${next.status} elapsed=${elapsed}s retryCount=${next.retryCount}`);
          if (pollCancelledRef.current || pollingId !== activeJobIdRef.current) return;
          // A good response wipes any accumulated transient-failure state —
          // including a raised "connection lost" card: the progress bar snaps
          // straight back to the live value and any terminal status below now
          // drives the screen to its completed / failed panel.
          if (consecutiveErrorsRef.current !== 0) {
            consecutiveErrorsRef.current = 0;
            setPollRetry(0);
          }
          setPollLost((wasLost) => (wasLost ? false : wasLost));
          setJob(next);
        } catch (err) {
          if (pollCancelledRef.current || pollingId !== activeJobIdRef.current) return;
          const e = (err ?? {}) as Partial<LoraPollError>;
          const fatal = e.isFatal === true || e.status === 404;
          const attempt = consecutiveErrorsRef.current + 1;
          console.error(
            `[lora] poll FAILED job=${pollingId} elapsed=${elapsed}s ` +
              `(fatal=${fatal}, attempt=${attempt}/${MAX_RETRY_COUNT}):`,
            err,
          );

          if (fatal) {
            // Unrecoverable (404 — job row gone / wrong account). Stop the
            // loop for good and show the degraded card; nothing to poll.
            consecutiveErrorsRef.current = MAX_RETRY_COUNT;
            pollCancelledRef.current = true;
            if (pollTimeoutRef.current) {
              clearTimeout(pollTimeoutRef.current);
              pollTimeoutRef.current = null;
            }
            setPollRetry(MAX_RETRY_COUNT);
            setPollLost(true);
            return;
          }

          consecutiveErrorsRef.current = Math.min(attempt, MAX_RETRY_COUNT);
          setPollRetry(consecutiveErrorsRef.current);

          if (attempt >= MAX_RETRY_COUNT) {
            // Fast retries spent — raise the degraded card, but DO NOT stop:
            // drop to a slow keep-alive tick so the screen catches the job's
            // completion on its own the moment the API / network recovers.
            setPollLost(true);
            if (!pollCancelledRef.current) pollTimeoutRef.current = setTimeout(tick, POLL_KEEPALIVE_MS);
            return;
          }

          // Transient failure with fast retries left: the light "再接続中
          // (n/6)…" hint, next tick on an exponential backoff (2s * 1.5^n,
          // capped at 10s).
          const backoff = Math.min(2000 * Math.pow(1.5, attempt), 10000);
          if (!pollCancelledRef.current) pollTimeoutRef.current = setTimeout(tick, backoff);
          return;
        }

        if (next) {
          if (
            next.status === "completed" ||
            next.status === "failed" ||
            next.status === "failed_timeout" ||
            next.status === "cancelled"
          ) {
            // A plain 'failed' (training errored) or 'cancelled' (aborted +
            // refunded internally) auto-refunds server-side, but this poll
            // response carries no refunded amount, so re-fetch the balance.
            if (next.status === "failed" || next.status === "cancelled") void refreshCredits();
            // 'failed' / 'cancelled' keep the key like 'completed' does — the
            // error panel carries the Salvage button, which must survive a
            // page reload. Only 'failed_timeout' (never left the queue, no
            // GPU, nothing on the Volume) is dropped.
            if (next.status === "failed_timeout" && typeof window !== "undefined") {
              localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
            }
            return;
          }
          if (next.status === "processing") {
            queuedSinceRef.current = 0;
          }
        }

        if (!pollCancelledRef.current) pollTimeoutRef.current = setTimeout(tick, JOB_POLL_INTERVAL_MS);
      };
      pollTimeoutRef.current = setTimeout(tick, opts?.immediate ? 0 : JOB_POLL_INTERVAL_MS);
    },
    [refreshCredits],
  );

  // "[今すぐ再接続]" on the degraded card — restarts the poll loop against the
  // same job id with an IMMEDIATE first fetch (no 3s wait), so the newest
  // Modal-side status lands right away and the panel restores / advances to
  // its completed screen.
  const retryPolling = useCallback(() => {
    const id = activeJobIdRef.current;
    if (!id) return;
    startPolling(id, { immediate: true });
  }, [startPolling]);

  // Auto-recovery while the degraded card is up: the moment the tab regains
  // focus or the network comes back, fire an immediate re-poll instead of
  // waiting out the slow keep-alive tick. Belt-and-suspenders on top of the
  // in-loop keep-alive so a user returning to a long-idle tab sees the real
  // (often already-completed) state at once.
  useEffect(() => {
    if (!pollLost) return;
    const kick = () => {
      const id = activeJobIdRef.current;
      if (id && !pollCancelledRef.current) startPolling(id, { immediate: true });
    };
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") kick();
    };
    window.addEventListener("online", kick);
    window.addEventListener("focus", kick);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", kick);
      window.removeEventListener("focus", kick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pollLost, startPolling]);

  // Restores an in-flight or just-finished job after the page re-mounts —
  // the job survives server-side (generation_jobs) regardless; only this
  // component's phase/job state was lost. If the saved job has since become
  // unreachable (deleted, belongs to a different account) this just clears
  // the stale key instead of getting stuck.
  useEffect(() => {
    if (!user) return;
    // Run EXACTLY ONCE per successful mount. `user` is only a dependency so
    // this waits for auth — its identity churns on every token refresh / tab
    // refocus, and a re-run here is precisely how a job the user already left
    // gets re-attached seconds later.
    //
    // The guard is set in the async `finally` — NOT synchronously up here —
    // so React 18/19 StrictMode's mount→unmount→remount in dev doesn't leave
    // it stuck: the first (immediately torn-down) run would set it, `cancelled`
    // would make every `stale()` check bail, and the real remount would then
    // early-return forever — the just-completed job never rehydrating. Marking
    // "done" only when a run actually finished un-cancelled fixes that while
    // still blocking the token-refresh re-attach trap.
    if (restoreDoneRef.current) return;

    let cancelled = false;
    // Snapshot the binding generation. resetForm() / Start-Training bump this;
    // if it moves while we're awaiting, this restore is stale — bail.
    const gen = jobBindGenRef.current;
    // True once the user is demonstrably driving the form (not the initial
    // "form" default). Any state write that would move them to "tracking" is
    // physically blocked once this holds.
    const stale = () =>
      cancelled || jobBindGenRef.current !== gen || phaseRef.current !== "form";
    // Marks the restore attempt as spent — but only if THIS run reached the
    // end without being torn down. A cancelled run (StrictMode's throw-away
    // first mount) leaves the guard clear so the real mount still runs.
    const markDone = () => {
      if (!cancelled) restoreDoneRef.current = true;
    };
    void (async () => {
      try {
        const clearKey = () => {
          if (typeof window === "undefined") return;
          try {
            localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
            for (const k of LEGACY_ACTIVE_JOB_KEYS) localStorage.removeItem(k);
          } catch {
            /* storage disabled */
          }
        };

        let targetId =
          typeof window !== "undefined" ? localStorage.getItem(ACTIVE_JOB_STORAGE_KEY) : null;
        // A job the user explicitly dismissed this session — never re-attach.
        if (targetId && dismissedJobIdsRef.current.has(targetId)) {
          clearKey();
          targetId = null;
        }
        let fromRecent = false;

        // No explicit pointer — fall back to the user's most recent LoRA job
        // to re-attach a still-running one, or to surface a recently-COMPLETED
        // one's download banner. A recent FAILED / cancelled job must NOT
        // hijack the form on every visit — that's the trap this fixes.
        if (!targetId) {
          try {
            const recent = await fetchRecentLoraJob();
            if (stale()) return;
            const reattachable =
              recent &&
              !dismissedJobIdsRef.current.has(recent.jobId) &&
              (recent.status === "queued" ||
                recent.status === "processing" ||
                (recent.status === "completed" &&
                  (() => {
                    const ref = recent.updatedAt || recent.createdAt;
                    const ageMs = ref ? Date.now() - new Date(ref).getTime() : Infinity;
                    return ageMs < RECENT_COMPLETED_MAX_AGE_MS;
                  })()));
            if (reattachable) {
              targetId = recent.jobId;
              fromRecent = true;
            }
          } catch {
            /* recent lookup is best-effort */
          }
        }
        if (!targetId || stale()) return;

        const persist = () => {
          if (typeof window !== "undefined") {
            try {
              localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, targetId!);
            } catch {
              /* storage disabled */
            }
          }
        };
        try {
          const restored = await pollLoraJob(targetId);
          // The user moved on (started a new job / reset) while this was in
          // flight — the whole point of the guard. Do NOT touch phase/job.
          if (stale()) return;
          if (restored.status === "queued" || restored.status === "processing") {
            persist();
            activeJobIdRef.current = targetId;
            setJob(restored);
            setPhase("tracking");
            startPolling(targetId);
          } else if (restored.status === "completed") {
            // An un-downloaded completed job. Persist the pointer and, when the
            // form is still untouched (a plain reload / server restart — NOT a
            // user who's begun a new dataset), land straight on the artefact /
            // download screen and KEEP them there. "フォームに戻る（成果物は
            // 保持されます）" is the explicit way out; the form-top "🏆 直前の
            // 学習が完了しています" banner then links back. Only the async yank
            // of a job the user has moved past is the bug — the pristine-form
            // guard + stale() together stop exactly that.
            persist();
            activeJobIdRef.current = targetId;
            setJob(restored);
            if (!stale() && imagesRef.current.length === 0) {
              setPhase("tracking");
              scrollStudioIntoView();
            }
          } else if (restored.status === "failed" || restored.status === "cancelled") {
            // HARD RULE: a failed / cancelled job NEVER drives
            // setPhase("tracking") from this async callback. Drop the pointer
            // and (for an explicit pointer — a job the user was actually
            // watching) surface a small dismissible banner so the Salvage /
            // download panel is one click away without ever yanking the user
            // off the form.
            clearKey();
            if (!fromRecent) setRecoveredJob(restored);
          } else {
            // failed_timeout / unknown — drop the pointer, stay on the form
            // (nothing to salvage).
            clearKey();
          }
        } catch (err) {
          // ONLY a definitive 404 (job deleted / belongs to another account)
          // clears the pointer. A transient 5xx / network blip during mount
          // must not strand a perfectly good job — leave the pointer so the
          // next load simply retries.
          const httpStatus = (err as { status?: number } | null)?.status;
          if (!stale() && httpStatus === 404) clearKey();
        }
      } finally {
        markDone();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Uploads `imgs` to Storage and starts the training job. `ownCaptions`, when
  // given and non-empty, is a caption list aligned to `imgs` that the user
  // authored (semi mode edits, a ZIP's .txt files, or curation) — sent as
  // custom_captions + skip_captioning so the worker never loads the 27B VLM.
  const runTraining = async (
    imgs: DatasetImage[],
    ownCaptions: string[] | null,
    captionsFromUser: boolean,
  ) => {
    if (!user) return;
    // HARD-DETACH any previous job BEFORE anything async runs. A lingering
    // mount-restore / poll must not be able to bind its old id or shove the
    // old ProgressPanel back after we've started a fresh job.
    jobBindGenRef.current += 1;
    pollCancelledRef.current = true;
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    dismissJob(activeJobIdRef.current);
    activeJobIdRef.current = "";
    setRecoveredJob(null);
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
        for (const k of LEGACY_ACTIVE_JOB_KEYS) localStorage.removeItem(k);
      } catch {
        /* storage disabled */
      }
    }
    // Immediate, synchronous lock + phase flip in the same render pass — the
    // form (price card, credit warning) is gone before the next paint.
    setSubmitting(true);
    setPhase("starting");
    setErrorMessage(null);
    setJob(null);
    // Baton pass — the previous (completed / running) job is now fully
    // detached; its label must not linger onto the new run's banner.
    setActiveJobModelLabel(null);
    setUploadProgress({ done: 0, total: imgs.length });
    setUploadBytes(null);
    setOptimizeProgress(null);

    // Phase 1 — upload every image to Storage first. If even one fails we
    // abort here and NEVER call /api/studio/lora/train (calling it with a
    // partial / empty dataset is what produced the mystery 500s).
    //
    // Skip entirely when the exact same image set was already uploaded this
    // session — re-tuning params / YAML and hitting start again reuses the
    // existing Storage objects (they aren't deleted between runs).
    const datasetSignature =
      `${imgs.length}::` +
      imgs.map((i) => `${i.file.name}:${i.file.size}:${i.file.lastModified}`).join("|");

    let paths: string[];
    const cached = uploadedDatasetRef.current;
    if (cached && cached.signature === datasetSignature && cached.paths.length === imgs.length) {
      paths = cached.paths;
      setUploadProgress({ done: imgs.length, total: imgs.length });
      console.log(`[lora] reusing ${paths.length} already-uploaded images — upload skipped (0s)`);
    } else {
      try {
        const uploaded = await uploadLoraDataset(
          user.id,
          imgs.map((i) => i.file),
          (done, total) => setUploadProgress({ done, total }),
          (sent, total) => setUploadBytes({ sent, total }),
          (done, total) => setOptimizeProgress(done < total ? { done, total } : null),
        );
        paths = uploaded.paths;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error("[LoraStudioTab] dataset upload failed:", err);
        setErrorMessage(`画像のアップロードに失敗しました: ${detail}`);
        setPhase("form");
        setSubmitting(false);
        setUploadProgress(null);
        return;
      }
      if (paths.length !== imgs.length) {
        setErrorMessage(
          `画像のアップロードに失敗しました: ${imgs.length} 枚中 ${paths.length} 枚しか完了しませんでした。もう一度お試しください。`,
        );
        setPhase("form");
        setSubmitting(false);
        setUploadProgress(null);
        return;
      }
      // Only cache a fully-successful upload.
      uploadedDatasetRef.current = { signature: datasetSignature, paths };
    }

    // Phase 2 — start the training job with only the storage paths.
    try {
      const captionList = (ownCaptions ?? []).map((c) => (c ?? "").trim());
      const anyCaption = captionList.some((c) => c.length > 0);
      // "Bring your own" — the worker writes exactly these captions, never
      // loads its (tag-format) caption VLM, and NEVER consults the Volume
      // caption cache. A blank slot becomes the trigger word.
      //
      // We now take this path as soon as ONE real caption exists, whoever
      // authored it. Previously an AI-captioned set had to have EVERY slot
      // filled to qualify, so a single Gemini quota/safety miss dropped the
      // whole (Dense) set onto the plain `captions` path — where a stale
      // tag-format cache for the same dataset_id would silently overwrite it,
      // and tag-format VLM gap-fill would contaminate the rest (the yukipas
      // Dense→tags swap). Safe side: honour the confirmed captions verbatim.
      const bringOwn = anyCaption || captionsFromUser;

      const trainingConfig = yamlMode
        ? { custom_yaml_override: pro.rawYaml }
        : {
            rank: effPro.rank,
            alpha: effectiveAlpha,
            learning_rate: effPro.learningRate,
            steps: effPro.steps,
            optimizer: effPro.optimizer,
          };

      setUploadProgress({ done: imgs.length, total: imgs.length });
      console.log(`[lora] dataset uploaded (${paths.length} files) — calling /api/studio/lora/train`);
      const startRes = await startLoraTraining({
        storagePaths: paths,
        captions: captionList,
        // imgs と paths は同じ並び（アップロード順）なので、そのまま添える。
        repeats: imgs.map((i) => i.repeats ?? 1),
        targetModel,
        customModelId: isCustom ? customModelId.trim() : undefined,
        baseArchitecture: isCustom ? baseArchitecture : undefined,
        trainingConfig,
        resolution,
        // Raw-YAML mode: send the YAML's own name / trigger (the form fields
        // are disabled). The server re-derives these from the YAML too.
        outputLoraName: effectiveLoraName,
        triggerWord: effectiveTrigger,
        customCaptions: bringOwn ? captionList : undefined,
        skipCaptioning: bringOwn || undefined,
        // The resolved caption FORMAT for this base model — forwarded to the
        // worker so its persisted-caption cache is keyed per-format (a dense
        // run and a tags run of the same dataset never share a cache dir).
        captionMode: resolvedCaptionModeRef.current,
        captionPrompt: resolvedCaptionPromptRef.current.trim() || undefined,
        // The structured LoRA-type spec — the server rebuilds caption_prompt
        // from this if the browser couldn't (Gemini down here).
        captionSpec: captionSpecFilled ? captionSpec : undefined,
        // SDXL/sd-scriptsワーカー限定のメタデータタグ埋め込み。yamlMode/非SDXL
        // では常にundefined（サーバー側isSdxlJob判定と同じくopt-out）。
        embedTags: !yamlMode && isSdxlJob && effectiveEmbedTags ? effectiveEmbedTags : undefined,
        // 画像ごとの keep_tokens はキャプションから数える（ユーザー入力ではない）。
        // キャプションの固定ブロック（trigger 群 + 数/性別タグ）の長さと
        // ズレると trigger が本文へ紛れ込むので、値を入力させる設計をやめた。
        keepTokensPerImage:
          !yamlMode && isSdxlJob && allSubjects.length > 0
            ? captionList.map((c) => keepTokensForCaption(c, allSubjects, 4))
            : undefined,
      });
      const { jobId, remainingCredits } = startRes;
      console.log("[lora] train ->", startRes);
      broadcastCreditsUpdate(user.id, remainingCredits);
      setActiveJobModelLabel(
        isCustom ? customModelId.trim() || "カスタムモデル" : (loraPresetById(targetModel)?.label ?? targetModel),
      );
      setJob({
        jobId,
        status: "queued",
        errorMessage: null,
        resultPath: null,
        progressPercent: 0,
        progressMessage: "queued",
        retryCount: 0,
        vramUsedGb: null,
        currentStep: null,
        totalSteps: null,
        etaSeconds: null,
        loss: null,
        logs: null,
        checkpoints: [],
        refunded: null,
        customYaml: yamlMode,
        safetyStop: false,
        safetyKind: null,
        queue: null,
      });
      setPhase("tracking");
      // 送信ロックはここで解く。以前は成功経路で true のまま残り、完了後に
      // 「フォームに戻る」（ソフト復帰）で phase が form に戻っても busy が立ち
      // 続け、それを解除できる唯一の「フォームを初期化」ボタン自身が busy で
      // 無効化される詰みになっていた（2026-09-23、ホスト報告）。
      setSubmitting(false);
      if (typeof window !== "undefined") localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, jobId);
      startPolling(jobId);
    } catch (err) {
      const e = err as LoraApiError;
      setErrorMessage(e.message || "LoRA学習の開始に失敗しました。");
      setPhase("form");
      setSubmitting(false);
      setUploadProgress(null);
      if (typeof e.remainingCredits === "number" && user) broadcastCreditsUpdate(user.id, e.remainingCredits);
    }
  };

  const userCaptionCount = useMemo(
    () =>
      images.filter(
        (img) => userCaptionIds.has(img.id) && (captions[img.id] ?? "").trim().length > 0,
      ).length,
    [images, captions, userCaptionIds],
  );
  const aiCaptionedCount = useMemo(
    () =>
      images.filter(
        (img) => !userCaptionIds.has(img.id) && (captions[img.id] ?? "").trim().length > 0,
      ).length,
    [images, captions, userCaptionIds],
  );
  const hasUserCaptions = userCaptionCount > 0;
  useEffect(() => {
    hasUserCaptionsRef.current = hasUserCaptions;
  }, [hasUserCaptions]);

  // --- Real-time trigger-word sync (no re-analysis) --------------------------
  // When the trigger word changes, rewrite the leading token of every existing
  // caption (EN + JA, and any curation pairs) on the spot. Debounced lightly
  // so holding a key doesn't thrash, but effectively instant.
  useEffect(() => {
    if (prevTriggerRef.current === null) {
      prevTriggerRef.current = curationTrigger;
      return;
    }
    const from = prevTriggerRef.current;
    const to = curationTrigger;
    if (from === to) return;
    const handle = setTimeout(() => {
      prevTriggerRef.current = to;
      const remap = (
        map: Record<string, string>,
        isUser: (id: string) => boolean,
      ): Record<string, string> => {
        let changed = false;
        const out: Record<string, string> = {};
        for (const [id, v] of Object.entries(map)) {
          const nv = swapLeadingTrigger(v, from, to, !isUser(id));
          out[id] = nv;
          if (nv !== v) changed = true;
        }
        return changed ? out : map;
      };
      setCaptions((m) => remap(m, (id) => userCaptionIds.has(id)));
      setCaptionsJa((m) => remap(m, (id) => userCaptionIds.has(id)));
      setCurationPairs((prev) => {
        if (!prev.length) return prev;
        let changed = false;
        const next = prev.map((p) => {
          const isUser = userCaptionIds.has(p.id);
          const caption = swapLeadingTrigger(p.caption, from, to, !isUser);
          const captionJa = swapLeadingTrigger(p.captionJa, from, to, !isUser);
          if (caption !== p.caption || captionJa !== p.captionJa) changed = true;
          return { ...p, caption, captionJa };
        });
        return changed ? next : prev;
      });
      // The stored captions now reflect the new trigger — advance the
      // re-analysis guard so "次へ" doesn't re-run the vision pass just for this.
      markCaptionsReflect(captionSpecKeyRef.current);
    }, 200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curationTrigger]);

  // Images that are the AI pass's responsibility (everything the user didn't
  // caption themselves) — the live denominator for the progress badge.
  const aiTargetCount = useMemo(
    () => images.filter((img) => !userCaptionIds.has(img.id)).length,
    [images, userCaptionIds],
  );
  // Images still waiting on the AI vision pass — no user caption, no AI
  // caption yet. This is exactly the set the "未完了を再解析" button targets.
  const incompleteImages = useMemo(
    () => images.filter((img) => !userCaptionIds.has(img.id) && !(captions[img.id] ?? "").trim()),
    [images, captions, userCaptionIds],
  );
  const pendingCaptionCount = incompleteImages.length;

  // 抽出が終わったらメタデータの確認へ送る（2026-09-22、ホスト提案）。
  // ここで確定させてからキャプションを作るので、作り直しが起きない。
  const scrolledToMetaRef = useRef(false);
  const prevIdentityRunningRef = useRef(false);
  useEffect(() => {
    const running = identityExtracting !== null;
    const finished = prevIdentityRunningRef.current && !running;
    prevIdentityRunningRef.current = running;
    if (!finished || scrolledToMetaRef.current || !needsIdentityConfirm) return;
    scrolledToMetaRef.current = true;
    setEmbedTagsOpen(true);
    document
      .getElementById(METADATA_PANEL_ID)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [identityExtracting, needsIdentityConfirm]);

  // 確認が済んだら診断へ送る（キャプション解析はここから始まる）。
  const scrolledAfterConfirmRef = useRef(false);
  useEffect(() => {
    if (!analysisStarted || needsIdentityConfirm || scrolledAfterConfirmRef.current) return;
    if (!scrolledToMetaRef.current) return; // 確認欄を経由していないなら送らない
    scrolledAfterConfirmRef.current = true;
    document
      .getElementById(DIAGNOSTICS_PANEL_ID)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [analysisStarted, needsIdentityConfirm]);

  // 解析が終わった瞬間に診断へ送る（2026-09-22、ホスト指摘「取り込み終わった
  // 後に何をすればいいか分からない」）。1データセットにつき1回だけ。
  const scrolledToDiagRef = useRef(false);
  const prevCapRunningRef = useRef(false);
  useEffect(() => {
    // 走っていた解析が止まった、または（キャッシュで解析が要らず）開始直後から
    // 未解析ゼロ、のどちらでも送る。後者はホスト報告「すぐ終わってもスクロール
    // しない」への対応。
    const finished =
      (prevCapRunningRef.current && !autoCap.running) ||
      (analysisStarted && !autoCap.running && pendingCaptionCount === 0);
    prevCapRunningRef.current = autoCap.running;
    // 確認待ちの間は診断へ送らない（2026-09-22、ホスト報告「開始直後に診断へ
    // 飛んでから確認欄へ飛ぶ」）。確認後の遷移は scrolledAfterConfirmRef が担う。
    if (needsIdentityConfirm || scrolledToMetaRef.current) return;
    if (!finished || scrolledToDiagRef.current || images.length === 0 || !analysisStarted) return;
    scrolledToDiagRef.current = true;
    document
      .getElementById(DIAGNOSTICS_PANEL_ID)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [autoCap.running, images.length, analysisStarted, pendingCaptionCount, needsIdentityConfirm]);


  // 診断は DatasetDiagnosticsPanel も内部で同じ計算をするが、導線の判定にも
  // 要る。純関数なので二重に走っても実害は無い（数百件で数ms）。
  const flowDiag = useMemo(() => analyzeDataset(diagnosticItems, allSubjects), [diagnosticItems, allSubjects]);

  // 「次にやること」を光らせる（2026-09-22、ホスト提案）。状態は持たず、
  // 画面の状態から毎回導出する。判定は src/lib/loraFlowStep.ts。
  const flow = useMemo(
    () =>
      loraFlowStep({
        isSdxlJob,
        yamlMode,
        busy: phase !== "form" || submitting,
        baseModelTouched,
        loraNameFilled: Boolean(effectiveLoraName.trim()),
        triggerFilled: Boolean(effectiveTrigger.trim()),
        genderTagMissing: allSubjects.some((x) => !(x.fixedTags ?? "").trim()),
        descriptionMissing: allSubjects.some((x) => !(x.description ?? "").trim()),
        imageCount: images.length,
        analysisStarted,
        needsIdentityConfirm,
        identityRunning: identityExtracting !== null,
        captionRunning: autoCap.running,
        pendingCaptionCount,
        diagnosticErrors: flowDiag.issues.filter((x) => x.level === "error").length,
        cropPrepared: selectedImageIds.size > 0,
        cropAvailable: flowDiag.issues.some(
          (x) => x.fixableWith === "smart_crop" && (x.cropKinds?.length ?? 0) > 0,
        ),
      }),
    [
      isSdxlJob,
      yamlMode,
      phase,
      submitting,
      baseModelTouched,
      effectiveLoraName,
      effectiveTrigger,
      allSubjects,
      images.length,
      analysisStarted,
      needsIdentityConfirm,
      identityExtracting,
      autoCap.running,
      pendingCaptionCount,
      flowDiag,
      selectedImageIds,
    ],
  );
  const flowRing = (t: LoraFlowTarget) => (flow.targets.includes(t) ? " flow-next" : "");
  // 被写体ごとの欄は「未入力の最初の1人」だけ光らせる（2026-09-22、ホスト指摘
  // 「2人目を追加すると1人目の欄も光る」）。allSubjects の 0 番が1人目。
  const genderMissingIdx = allSubjects.findIndex((x) => !(x.fixedTags ?? "").trim());
  const descMissingIdx = allSubjects.findIndex((x) => !(x.description ?? "").trim());
  const flowRingAt = (t: "genderTag" | "description", idx: number) => {
    if (!flow.targets.includes(t)) return "";
    const want = t === "genderTag" ? genderMissingIdx : descMissingIdx;
    return want === idx ? " flow-next" : "";
  };
  // ヒント文は「光る場所が1つ」のときだけ出す（2026-09-22、ホスト指摘）。
  // 2つ光っている場面はボタンのラベル自体が選択肢になっているので、それを
  // 並べ直した文は冗長なだけ。
  const flowHint = (t: LoraFlowTarget) =>
    flow.targets.length === 1 && flow.targets.includes(t) ? (
      <p className="mt-1 text-[10px] font-medium text-neon-pink">→ {flow.hint}</p>
    ) : null;

  // Of the incomplete ones, how many actually errored out (vs. never started).
  const captionErrorCount = useMemo(
    () => incompleteImages.filter((img) => captionErrorIds.has(img.id)).length,
    [incompleteImages, captionErrorIds],
  );

  // Locks each trigger's Danbooru gender/age tag (1girl/1boy/1man/1woman) to
  // whichever value appears most often across its own SOLO-shot captions —
  // see normalizeSubjectTags() in loraCaptionSpec.ts for the shared
  // logic (also reused by DatasetCurationUI.tsx's own recaption path).
  // Reads/writes via a functional setCaptions updater so it always sees the
  // freshest map regardless of this callback's own (stable) closure.
  const applyGenderTagConsistency = useCallback(() => {
    const subjects = subjectsRef.current.length ? subjectsRef.current : [{ trigger: triggerWord.trim(), description: "" }];
    if (!subjects[0]?.trigger) return;
    setCaptions((prev) => {
      const fixes = normalizeSubjectTags(
        Object.entries(prev).map(([id, caption]) => ({ id, caption })),
        subjects,
      );
      if (!fixes.size) return prev;
      const next = { ...prev };
      fixes.forEach((caption, id) => {
        next[id] = caption;
      });
      return next;
    });
  }, [triggerWord]);

  // --- AI-vision auto-captioning ----------------------------------------
  // Fires on drop: downscales each new image in the browser and calls
  // /api/studio/lora/caption in batches (see src/lib/loraCaption.ts). The
  // ".txt-bearing ZIP -> use as-is, skip AI" route is preserved (those ids
  // are pre-marked in captionAttemptedRef / userCaptionIdsRef).
  const runVisionCaptions = useCallback(
    async (
      targets: DatasetImage[],
      trigger: string,
      captionPrompt: string,
    ): Promise<{ cap: Record<string, string>; ja: Record<string, string> } | null> => {
      if (targets.length === 0) return null;
      autoCaptionAbortRef.current?.abort();
      const ac = new AbortController();
      autoCaptionAbortRef.current = ac;
      recaptionPromptRef.current = captionPrompt;
      // The captions produced here reflect the current trigger + spec.
      markCaptionsReflect(captionSpecKeyRef.current);
      setAutoCap({ running: true, done: 0, total: targets.length, error: null, note: null, everRan: true });

      // Merge each batch as it lands, dropping any target the user has
      // removed since the pass started (its id is gone from imageIdsRef).
      // Every landed caption is also written through to the localStorage
      // cache and clears the id's error flag.
      const mergeLive = (
        entries: { index: number; en: string; ja: string }[],
      ): { cap: Record<string, string>; ja: Record<string, string> } => {
        const live = imageIdsRef.current;
        const cap: Record<string, string> = {};
        const capJa: Record<string, string> = {};
        const cacheWrites: { key: string; en: string; ja: string }[] = [];
        for (const e of entries) {
          const t = targets[e.index];
          if (!t || !live.has(t.id)) continue;
          if (e.en.trim()) cap[t.id] = e.en.trim();
          if (e.ja.trim()) capJa[t.id] = e.ja.trim();
          if (e.en.trim() || e.ja.trim()) {
            cacheWrites.push({ key: captionFileKey(t.file), en: e.en.trim(), ja: e.ja.trim() });
          }
        }
        if (Object.keys(cap).length) setCaptions((prev) => ({ ...prev, ...cap }));
        if (Object.keys(capJa).length) setCaptionsJa((prev) => ({ ...prev, ...capJa }));
        if (cacheWrites.length) {
          persistCaptionCache(cacheWrites);
          const doneIds = new Set(Object.keys(cap).concat(Object.keys(capJa)));
          setCaptionErrorIds((prev) => {
            if (![...doneIds].some((id) => prev.has(id))) return prev;
            const next = new Set(prev);
            doneIds.forEach((id) => next.delete(id));
            return next;
          });
        }
        return { cap, ja: capJa };
      };

      const markErrors = (indices: number[]) => {
        const live = imageIdsRef.current;
        const ids = indices
          .map((i) => targets[i]?.id)
          .filter((id): id is string => Boolean(id) && live.has(id));
        if (!ids.length) return;
        setCaptionErrorIds((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.add(id));
          return next;
        });
      };

      const merged: { cap: Record<string, string>; ja: Record<string, string> } = { cap: {}, ja: {} };
      let res: Awaited<ReturnType<typeof generateDatasetCaptions>>;
      try {
        res = await generateDatasetCaptions(
          targets.map((t) => t.file),
          {
            triggerWord: trigger,
            subjects: subjectsRef.current,
            captionPrompt: captionPrompt || undefined,
            category: captionCategoryRef.current,
            captionMode: resolvedCaptionModeRef.current,
            signal: ac.signal,
            onProgress: (done, total) => setAutoCap((s) => ({ ...s, done, total, note: null })),
            onBatch: (entries) => {
              const m = mergeLive(entries);
              Object.assign(merged.cap, m.cap);
              Object.assign(merged.ja, m.ja);
            },
            onRetry: () =>
              setAutoCap((s) => ({
                ...s,
                note: "混雑のため少し待ってから自動で再試行しています…",
              })),
            onError: markErrors,
            isStale: (i) => {
              const id = targets[i]?.id;
              return !id || !imageIdsRef.current.has(id);
            },
          },
        );
      } catch {
        setAutoCap((s) => ({ ...s, running: false, error: "自動解析に失敗しました。" }));
        return null;
      }
      if (ac.signal.aborted) {
        // 中断された経路で running を下ろしていなかった（2026-09-22、ホスト
        // 報告「解析は完了したのに解析中表示がぐるぐるしたまま」）。後続の
        // パスが走っていれば旗はそちらが管理するので、自分がまだ最新の
        // 中断コントローラを持っているときだけ下ろす。
        if (autoCaptionAbortRef.current === ac) {
          setAutoCap((st) => ({ ...st, running: false, note: null }));
        }
        return null;
      }

      // Safety net: fold in anything onBatch missed, still live-filtered.
      const tail = mergeLive(
        targets.map((t, k) => ({ index: k, en: res.captions[k] ?? "", ja: res.captionsJa[k] ?? "" })),
      );
      Object.assign(merged.cap, tail.cap);
      Object.assign(merged.ja, tail.ja);

      // "Missed" counts only images that still exist AND still have no caption.
      const live = imageIdsRef.current;
      const missed = targets.filter(
        (t) => live.has(t.id) && !(merged.cap[t.id] ?? "").trim(),
      ).length;
      // Of those, how many the safety filter genuinely refused (vs. gave up on).
      const safetyMissed = res.safetyRejected
        .map((i) => targets[i]?.id)
        .filter((id): id is string => Boolean(id) && live.has(id)).length;

      setAutoCap((s) => ({
        ...s,
        running: false,
        done: s.total,
        note: null,
        // ⚠️ 「学習時に自動補完されます」は SDXL では**嘘**だった
        // （2026-09-22）。modal_sdxl_lora_worker.py の _stage_dataset は
        // VLM 補完を持たず、キャプションが空の画像は**トリガーワードだけ**で
        // 学習される。その画像のポーズ・背景・服装がすべてトリガーへ
        // 焼き込まれるので、放置していい話ではない。
        error:
          missed === 0
            ? null
            : `${missed} 枚は自動解析できませんでした` +
              // 断定しない（2026-09-22、ホスト指摘）。空応答の理由は安全性
              // フィルタとは限らないので、API が返した文字列をそのまま出す。
              (safetyMissed > 0
                ? `（うち ${safetyMissed} 枚は解析AIが空の結果を返しました` +
                  (res.safetyReason ? `／理由: ${res.safetyReason}` : "") +
                  "）"
                : "") +
              (isSdxlJobRef.current
                ? "。このままだと、その画像は**トリガーワードだけ**で学習されます（写っている服装・背景・ポーズがトリガーに焼き込まれます）。下の「🔄 未完了の画像を再解析」を押してください。"
                : "（学習時に自動補完されます）。"),
      }));
      applyGenderTagConsistency();
      // Pass finished while still on the form — leave the user exactly where
      // they are (no forced scroll; the completion badge is inline).
      return { cap: merged.cap, ja: merged.ja };
    },
    [markCaptionsReflect, applyGenderTagConsistency],
  );

  // Kick the vision pass for images that have no caption yet and haven't been
  // tried. Debounced so a 30-file drop is one pass, and serialised (waits for
  // a running pass) so a second drop mid-run doesn't abort the first.
  useEffect(() => {
    if (!user || phase !== "form" || autoCap.running) return;
    // 取り込みの途中で走らせない（上の抽出と同じ理由）。
    if (!analysisStarted) return;
    // ⚠️ メタデータの確認が済むまで待つ（2026-09-22、ホスト提案）。特徴は
    // 「キャプションに書いてはいけない言葉」のリストなので、確認時に直されると
    // 解析済みのキャプションが全部作り直しになる。確定してから作れば起きない。
    if (needsIdentityConfirm) return;
    // ⚠️ **特徴の抽出が終わるまでキャプションを始めない**（2026-09-22）。
    // 抽出結果は「キャプションに書いてはいけない言葉」のリストとして使う。
    // 以前は解析の待ちが 500ms、抽出が 4秒で**解析のほうが先に始まっており**、
    // 抽出が届いた時点で「設定が変わった」と判定されて全キャプションを作り
    // 直していた。抽出は被写体あたり1リクエスト、作り直しは165枚で42リクエスト
    // なので、待つほうが圧倒的に安い。
    //
    // 待つのは「抽出が走る条件が揃っているのに、まだ結果が無い」間だけ。
    // 性別タグ未選択などで抽出自体が走らない場合は待たない（デッドロック防止）。
    const identityPending =
      identityExtracting !== null ||
      allSubjects.some((sub) => {
        const trigger = (sub.trigger ?? "").trim();
        if (!trigger || !(sub.fixedTags ?? "").trim()) return false;
        if ((sub.identityTags ?? "").trim()) return false;
        const idx = allSubjects.indexOf(sub) - 1; // 0番=1人目は index -1 で登録
        return !autoExtractedRef.current.has(`${idx}:${trigger}:${sub.fixedTags ?? ""}`);
      });
    if (identityPending) return;
    const pending = images.filter(
      (img) =>
        !captionAttemptedRef.current.has(img.id) &&
        !userCaptionIds.has(img.id) &&
        !(captions[img.id] ?? "").trim(),
    );
    if (pending.length === 0) return;
    const t = setTimeout(() => {
      pending.forEach((img) => captionAttemptedRef.current.add(img.id));
      // Feed the already-entered fixed/varying spec straight into the first
      // pass (deterministic prompt — no extra round-trip) so the captions
      // respect the blacklist from the start.
      void runVisionCaptions(pending, curationTrigger, currentCaptionPrompt());
    }, 500);
    return () => clearTimeout(t);
    // identityExtracting / allSubjects を依存に入れて、抽出が終わった瞬間に
    // この effect が走り直すようにする（待ちが解ける）。
    // curationTrigger / currentCaptionPrompt / runVisionCaptions は毎レンダー
    // 作り直されるので依存に入れない（入れると取り込みのたびに解析が再起動する）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisStarted, needsIdentityConfirm, images, captions, userCaptionIds, user, phase, autoCap.running, identityExtracting, allSubjects]);

  // Re-run the vision pass over every AI-captioned image with the current
  // trigger word + synthesised instruction (the "🔄 AI再解析" button, and
  // handleStart when the category instruction changed).
  const recaptionAll = useCallback(async () => {
    const targets = images.filter((img) => !userCaptionIds.has(img.id));
    if (targets.length === 0) return null;
    targets.forEach((img) => captionAttemptedRef.current.add(img.id));
    return runVisionCaptions(
      targets,
      curationTrigger,
      resolvedCaptionPromptRef.current.trim() || currentCaptionPrompt(),
    );
  }, [images, userCaptionIds, curationTrigger, runVisionCaptions, currentCaptionPrompt]);

  // "🔄 未完了の画像（N枚）を再解析" — re-run the full pass over ONLY the
  // images that still have no caption (never started, or errored out).
  const recaptionIncomplete = useCallback(async () => {
    const targets = incompleteImages;
    if (targets.length === 0 || autoCap.running) return null;
    setCaptionErrorIds((prev) => {
      if (!targets.some((t) => prev.has(t.id))) return prev;
      const next = new Set(prev);
      targets.forEach((t) => next.delete(t.id));
      return next;
    });
    targets.forEach((img) => captionAttemptedRef.current.add(img.id));
    return runVisionCaptions(
      targets,
      curationTrigger,
      resolvedCaptionPromptRef.current.trim() || currentCaptionPrompt(),
    );
  }, [incompleteImages, autoCap.running, curationTrigger, runVisionCaptions, currentCaptionPrompt]);

  // Per-card "🔄 再解析" — one image, on its own lightweight path so it never
  // touches the batch pass's abort controller or progress UI.
  const recaptionOne = useCallback(
    async (id: string) => {
      const img = imagesRef.current.find((i) => i.id === id);
      if (!img || recaptioningIds.has(id)) return;
      setRecaptioningIds((prev) => new Set(prev).add(id));
      captionAttemptedRef.current.add(id);
      try {
        const res = await generateDatasetCaptions([img.file], {
          triggerWord: curationTrigger,
          subjects: subjectsRef.current,
          captionPrompt: resolvedCaptionPromptRef.current.trim() || currentCaptionPrompt() || undefined,
          category: captionCategoryRef.current,
          captionMode: resolvedCaptionModeRef.current,
          onBatch: (entries) => {
            const e = entries[0];
            if (!e) return;
            if (!imageIdsRef.current.has(id)) return;
            if (e.en.trim()) setCaptions((prev) => ({ ...prev, [id]: e.en.trim() }));
            if (e.ja.trim()) setCaptionsJa((prev) => ({ ...prev, [id]: e.ja.trim() }));
            persistCaptionCache([{ key: captionFileKey(img.file), en: e.en.trim(), ja: e.ja.trim() }]);
          },
        });
        const ok = (res.captions[0] ?? "").trim().length > 0;
        setCaptionErrorIds((prev) => {
          const next = new Set(prev);
          if (ok) next.delete(id);
          else next.add(id);
          return next;
        });
        applyGenderTagConsistency();
      } catch {
        setCaptionErrorIds((prev) => new Set(prev).add(id));
      } finally {
        setRecaptioningIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [recaptioningIds, curationTrigger, currentCaptionPrompt, applyGenderTagConsistency],
  );

  // Re-analyze handler for the curation screen: runs the vision pass over the
  // supplied cards and hands the results back so DatasetCurationUI can patch
  // its own `pairs` state. Also writes through to the caption cache.
  const recaptionForCuration = useCallback(
    async (
      targets: { id: string; file: File; caption?: string; captionJa?: string }[],
      opts?: { forceOverwrite?: boolean },
    ): Promise<Record<string, { en: string; ja: string }>> => {
      if (targets.length === 0) return {};
      const force = opts?.forceOverwrite ?? false;
      const res = await generateDatasetCaptions(
        targets.map((t) => t.file),
        {
          triggerWord: curationTrigger,
          subjects: subjectsRef.current,
          captionPrompt: resolvedCaptionPromptRef.current.trim() || currentCaptionPrompt() || undefined,
          category: captionCategoryRef.current,
          captionMode: resolvedCaptionModeRef.current,
          forceOverwrite: force,
          // Without a force, skip cards that already carry a caption (only the
          // blank ones are re-analysed); with a force, re-do everything.
          preCaptioned: force ? undefined : targets.map((t) => t.caption ?? ""),
          preCaptionedJa: force ? undefined : targets.map((t) => t.captionJa ?? ""),
        },
      );
      const out: Record<string, { en: string; ja: string }> = {};
      const cacheWrites: { key: string; en: string; ja: string }[] = [];
      targets.forEach((t, k) => {
        const en = (res.captions[k] ?? "").trim();
        const ja = (res.captionsJa[k] ?? "").trim();
        out[t.id] = { en, ja };
        if (en || ja) cacheWrites.push({ key: captionFileKey(t.file), en, ja });
      });
      if (cacheWrites.length) persistCaptionCache(cacheWrites);
      return out;
    },
    [curationTrigger, currentCaptionPrompt],
  );

  // Runs on "次へ" / "学習を開始" — turns the selected LoRA type + JP feature
  // notes into the English Qwen instruction (Gemini, with a deterministic
  // fallback) and stashes it in resolvedCaptionPromptRef for runTraining.
  // A manual edit in the textarea wins outright; an empty spec leaves the
  // worker on its built-in default caption instruction.
  const resolveCaptionPrompt = async (ownCaptionsKnown: boolean) => {
    const manual = captionPromptOverride.trim();
    if (manual) {
      resolvedCaptionPromptRef.current = manual;
      setCaptionGen({ state: "done", prompt: manual, fromGemini: false, error: null });
      return;
    }
    if (ownCaptionsKnown || !captionSpecFilled) {
      resolvedCaptionPromptRef.current = "";
      setCaptionGen({ state: "idle", prompt: "", fromGemini: false, error: null });
      return;
    }
    setCaptionGen({ state: "generating", prompt: "", fromGemini: false, error: null });
    try {
      const result = await generateCaptionPrompt(captionSpec, curationTrigger);
      const prompt = result?.captionPrompt ?? "";
      resolvedCaptionPromptRef.current = prompt;
      setCaptionGen({
        state: prompt ? "done" : "error",
        prompt,
        fromGemini: result?.fromGemini ?? false,
        error: prompt ? null : "プロンプトを生成できませんでした。",
      });
    } catch {
      resolvedCaptionPromptRef.current = "";
      setCaptionGen({
        state: "error",
        prompt: "",
        fromGemini: false,
        error: "プロンプト自動生成に失敗しました（既定の指示で続行します）。",
      });
    }
  };

  // Client-side dataset ZIP (image + its caption .txt) — available on every
  // screen that still holds the images in memory (curation is handled inside
  // DatasetCurationUI; this covers the form / launching / in-progress views).
  const downloadDatasetZipLocal = async () => {
    if (datasetZipBusy || images.length === 0) return;
    setDatasetZipBusy(true);
    setErrorMessage(null);
    try {
      const entries = images.map((img) => ({
        file: img.file,
        caption: (captions[img.id] || captionsJa[img.id] || curationTrigger).trim(),
      }));
      const blob = await buildDatasetZip(entries);
      downloadBlob(blob, `dataset_${images.length}img.zip`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "データセット ZIP の作成に失敗しました。");
    } finally {
      setDatasetZipBusy(false);
    }
  };

  const handleStart = async () => {
    if (submitting || phase !== "form") return; // already in flight — ignore re-clicks
    // Physical double-submit guard — a job dispatched this session is still
    // queued/processing (the button is disabled for this too, but Enter-key
    // submits or a stale render must not slip through).
    if (inFlightJob) return;
    if (!user) {
      setLoginOpen(true);
      return;
    }
    if (insufficientCredits) {
      if (typeof document !== "undefined") {
        document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" });
        try {
          window.history.replaceState(null, "", "#pricing");
        } catch {
          /* no-op */
        }
      }
      return;
    }
    if (!canSubmit) return;

    // Let any in-flight AI-vision pass finish so curation / training see the
    // completed captions.
    if (autoCap.running) {
      setErrorMessage("AI キャプション解析の完了をお待ちください…");
      return;
    }
    setErrorMessage(null);
    // Lock NOW — every path below is async; the button and the price/credit
    // cards must not be interactive again until phase leaves "form".
    setSubmitting(true);
    try {
      await runHandleStart();
    } catch (e) {
      // A throw here must NOT bubble to an unhandled rejection (which can trip
      // a framework error boundary and remount the whole form, wiping the
      // uploaded images). Surface it and leave the user on the form with the
      // dataset intact — they can retry.
      console.error("[lora] handleStart failed:", e);
      setErrorMessage(
        e instanceof Error && e.message
          ? `処理に失敗しました: ${e.message}`
          : "処理中にエラーが発生しました。もう一度お試しください。",
      );
    } finally {
      // If we're still on the form (an early guard tripped, or curation was
      // cancelled), release the lock; once phase is starting/tracking/curation
      // the early-return render owns the screen and this is a no-op.
      setSubmitting(false);
    }
  };

  const runHandleStart = async () => {

    let cap: Record<string, string> = captions;
    let capJa: Record<string, string> = captionsJa;

    // (1) Images that never went through the vision pass — e.g. the user
    //     clicked before the on-drop debounce fired. Caption them now.
    const neverTried = images.filter(
      (img) =>
        !userCaptionIds.has(img.id) &&
        !(cap[img.id] ?? "").trim() &&
        !captionAttemptedRef.current.has(img.id),
    );
    if (neverTried.length > 0) {
      neverTried.forEach((img) => captionAttemptedRef.current.add(img.id));
      const d = await runVisionCaptions(neverTried, curationTrigger, currentCaptionPrompt());
      if (d) {
        cap = { ...cap, ...d.cap };
        capJa = { ...capJa, ...d.ja };
      }
    }

    // (2) Did the fixed/varying spec (or manual override) actually change since
    //     the captions were last generated? A bare trigger-word edit does NOT
    //     count — that was already swapped in client-side.
    const specChanged = captionSpecStale(captionSpecKey, reflectedSpecKey);

    // (3) Synthesise the LoRA-type instruction for the worker's VLM gap-fill,
    //     and — only when the spec changed — re-run the vision pass so the new
    //     blacklist / detail instructions are reflected in the captions.
    if (specChanged) {
      await resolveCaptionPrompt(hasUserCaptions);
    } else if (!resolvedCaptionPromptRef.current.trim()) {
      // Nothing changed — use the deterministic instruction, no round-trip.
      resolvedCaptionPromptRef.current = currentCaptionPrompt();
    }
    const aiCount = images.filter(
      (img) => !userCaptionIds.has(img.id) && (cap[img.id] ?? "").trim(),
    ).length;
    if (!hasUserCaptions && aiCount > 0 && specChanged) {
      const delta = await recaptionAll();
      if (delta) {
        cap = { ...cap, ...delta.cap };
        capJa = { ...capJa, ...delta.ja };
      }
    }

    if (curationEnabled) {
      setCurationPairs(
        images.map((img) => ({
          id: img.id,
          file: img.file,
          url: img.url,
          name: img.file.name,
          caption: cap[img.id] ?? "",
          captionJa: capJa[img.id] ?? "",
          excluded: false,
        })),
      );
      setPhase("curation");
      scrollStudioIntoView();
      return;
    }

    const list = images.map((img) => (cap[img.id] ?? "").trim());
    const ownCaptions = list.some((c) => c.length > 0) ? list : null;
    await runTraining(images, ownCaptions, hasUserCaptions);
  };

  // Push the curation screen's working copy (`curationPairs`) back into the
  // form's own state so LEAVING curation — via "戻る" or by starting training —
  // never drops an edit or a removal. Kept images only: an excluded pair is a
  // deletion (the user excluded it), so its image, its captions and every
  // side-channel trace are purged here. Also writes the curated captions
  // through to the localStorage cache (keyed by file identity) so a reload
  // re-hydrates the curated text, not the stale pre-curation captions.
  const flushCurationToForm = useCallback((pairs: CurationPair[]) => {
    const kept = pairs.filter((p) => !p.excluded);
    const keptIds = new Set(kept.map((p) => p.id));

    // Revoke object URLs for images removed in curation (skip any URL still
    // referenced by a kept pair — the pair carries the same url string).
    const keptUrls = new Set(kept.map((p) => p.url));
    imagesRef.current.forEach((i) => {
      if (!keptIds.has(i.id) && !keptUrls.has(i.url)) {
        try {
          URL.revokeObjectURL(i.url);
        } catch {
          /* no-op */
        }
      }
    });

    // ⚠️ ここで画像オブジェクトを作り直すと **repeats（学習回数）と cropKind が
    // 落ちる**（2026-09-22、ホスト報告「構図の偏りはやっているのにログが
    // repeats x1」）。キュレーションを既定 ON にしたので全ジョブがこの経路を
    // 通り、学習回数は毎回失われていた。元の画像から id で引いて引き継ぐ。
    const srcById = new Map(images.map((i) => [i.id, i]));
    const keptImages: DatasetImage[] = kept.map((p) => {
      const src = srcById.get(p.id);
      return {
        id: p.id,
        file: p.file,
        url: p.url,
        repeats: src?.repeats,
        cropKind: src?.cropKind,
        sizeVerdict: src?.sizeVerdict,
      };
    });
    // Keep the async-read refs consistent immediately (their sync effects only
    // run after the next commit, but runTraining / an in-flight pass may read
    // them before that).
    imageIdsRef.current = keptIds;
    imagesRef.current = keptImages;
    pairs.forEach((p) => {
      if (!keptIds.has(p.id)) captionAttemptedRef.current.delete(p.id);
    });

    setUserCaptionIds((prev) => {
      if ([...prev].every((id) => keptIds.has(id))) return prev;
      return new Set([...prev].filter((id) => keptIds.has(id)));
    });
    setImages(keptImages);
    setCaptions(Object.fromEntries(kept.map((p) => [p.id, p.caption])));
    setCaptionsJa(Object.fromEntries(kept.map((p) => [p.id, p.captionJa])));

    persistCaptionCache(
      kept.map((p) => ({
        key: captionFileKey(p.file),
        en: p.caption.trim(),
        ja: p.captionJa.trim(),
      })),
    );
    // images は repeats / cropKind を引き継ぐために読む。
  }, [images]);

  // While the curation screen is open, mirror every caption edit / removal
  // back to the form state + the localStorage cache on a short debounce. This
  // is the write-through half of the sync (the flush above is the on-exit
  // half): a hard reload or a crash mid-curation now keeps the user's work.
  // Merge (not replace) so an excluded pair's caption survives here too — the
  // exit flush is what finally drops excluded ids.
  useEffect(() => {
    if (phase !== "curation" || curationPairs.length === 0) return;
    const t = setTimeout(() => {
      persistCaptionCache(
        curationPairs
          .filter((p) => !p.excluded)
          .map((p) => ({
            key: captionFileKey(p.file),
            en: p.caption.trim(),
            ja: p.captionJa.trim(),
          })),
      );
      setCaptions((prev) => ({
        ...prev,
        ...Object.fromEntries(curationPairs.map((p) => [p.id, p.caption])),
      }));
      setCaptionsJa((prev) => ({
        ...prev,
        ...Object.fromEntries(curationPairs.map((p) => [p.id, p.captionJa])),
      }));
    }, 400);
    return () => clearTimeout(t);
  }, [phase, curationPairs]);

  // From the curation screen — flush the curated dataset back into the form
  // state, then train on exactly what's kept.
  const confirmCuration = async () => {
    const kept = curationPairs.filter((p) => !p.excluded);
    if (!kept.length) return;
    flushCurationToForm(curationPairs);
    // ⚠️ ここで画像オブジェクトを作り直すと **repeats（学習回数）と cropKind が
    // 落ちる**（2026-09-22、ホスト報告「構図の偏りはやっているのにログが
    // repeats x1」）。キュレーションを既定 ON にしたので全ジョブがこの経路を
    // 通り、学習回数は毎回失われていた。元の画像から id で引いて引き継ぐ。
    const srcById = new Map(images.map((i) => [i.id, i]));
    const keptImages: DatasetImage[] = kept.map((p) => {
      const src = srcById.get(p.id);
      return {
        id: p.id,
        file: p.file,
        url: p.url,
        repeats: src?.repeats,
        cropKind: src?.cropKind,
        sizeVerdict: src?.sizeVerdict,
      };
    });
    const caps = kept.map((p) => p.caption.trim());
    // A .txt/ZIP dataset stays "bring your own" (blank = intentional). An
    // AI-captioned one keeps its VLM gap-fill even after culling images.
    await runTraining(keptImages, caps.some((c) => c.length > 0) ? caps : null, hasUserCaptions);
  };

  // The one place the progress panel hands control back to the form. Must be
  // total: stop polling, drop the active-job pointer (every known key),
  // remember this job so the mount-restore effect can't re-attach to it, and
  // flip to "form" — WITHOUT touching the saved settings draft.
  const resetForm = () => {
    // Invalidate any async restore / poll captured before this point.
    jobBindGenRef.current += 1;
    pollCancelledRef.current = true;
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    dismissJob(job?.jobId ?? activeJobIdRef.current);
    activeJobIdRef.current = "";
    consecutiveErrorsRef.current = 0;
    setPollRetry(0);
    setPollLost(false);
    setPhase("form");
    setSubmitting(false);
    setJob(null);
    setActiveJobModelLabel(null);
    setRecoveredJob(null);
    setErrorMessage(null);
    setUploadProgress(null);
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
        for (const k of LEGACY_ACTIVE_JOB_KEYS) localStorage.removeItem(k);
      } catch {
        /* storage disabled — state reset above still returns the user to the form */
      }
    }
  };

  // The "フォームに戻る" affordance on the progress / result panel. A job that
  // is still running OR has just completed does a SOFT return — `job`,
  // polling, and the active-job pointer are left intact so the progress /
  // artefact-download panel stays one click away (a form-top banner links
  // back). Only a failed / cancelled / timed-out job (nothing left to keep
  // reachable this way — the mount-restore banner re-surfaces those) does the
  // full resetForm(). A fresh dispatch is the only other thing that drops a
  // kept job (see runTraining's hard-detach).
  const returnToForm = () => {
    if (
      job &&
      (job.status === "queued" || job.status === "processing" || job.status === "completed")
    ) {
      setPhase("form");
      setSubmitting(false);
    } else {
      resetForm();
    }
  };

  // Wipes the saved draft and returns every form field to its default —
  // the ONLY place FORM_DRAFT_STORAGE_KEY is cleared. Confirmation gated.
  const resetFormDraft = () => {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "入力内容（トリガーワード・生YAML・こだわりテキスト・アップロード画像など）をすべて消去して、新規LoRA作成を最初から始めますか？\nこの操作は取り消せません。",
      );
      if (!ok) return;
      try {
        window.localStorage.removeItem(FORM_DRAFT_STORAGE_KEY);
      } catch {
        /* best-effort */
      }
    }
    autoCaptionAbortRef.current?.abort();
    captionAttemptedRef.current = new Set();
    recaptionPromptRef.current = "";
    prevTriggerRef.current = null;
    lastCaptionSpecKeyRef.current = "";
    setReflectedSpecKey("");
    setUserCaptionIds(new Set());
    setCaptionErrorIds(new Set());
    setRecaptioningIds(new Set());
    setAutoCap({ running: false, done: 0, total: 0, error: null, note: null, everRan: false });
    images.forEach((i) => URL.revokeObjectURL(i.url));
    setImages([]);
    setCaptions({});
    setCaptionsJa({});
    setModelChoice("minimax_h3");
    setCustomModelId("");
    setBaseArchitecture("sdxl");
    // resolution はもう state ではない（modelChoice/baseArchitecture から
    // 自動導出。上の2行のリセットで自然に 1024 へ戻る）。
    setTriggerWord("");
    setPrimaryDescription("");
    setPrimaryFixedTags("");
    setPrimaryIdentityTags("");
    setPrimaryIdentityTagsJa("");
    setExtraSubjects([]);
    setLoraName("");
    setEmbedTagsOpen(false);
    setPro(DEFAULT_PRO);
    setCaptionCategory("character");
    setCaptionFixed("");
    setCaptionVarying("");
    setCaptionPromptOverride("");
    setCaptionMode("auto");
    setCaptionPromptOpen(false);
    // Re-arm the zombie-draft prompt for the next fresh dataset.
    zombieDraftDecidedRef.current = false;
    setCaptionGen({ state: "idle", prompt: "", fromGemini: false, error: null });
    // 既定は ON（2026-09-22、ホスト判断）。リセットで false に戻していたため
    // 「完全リセットするとチェックが外れている」状態になっていた。
    setCurationEnabled(true);
    setAnalysisStarted(false);
    setCurationPairs([]);
    setErrorMessage(null);
    uploadedDatasetRef.current = null;
    resolvedCaptionPromptRef.current = "";
  };

  // `submitting` folds in so every form control locks the instant "開始" is
  // pressed, through the async prep window before phase flips to "starting".
  const busy = phase !== "form" || submitting;

  // Job in flight — the form (dataset grid, all settings, price card, the
  // "クレジット不足" card) is torn down completely and only the progress
  // panel renders. No form re-render can flash a stale credit warning while
  // a paid job is running (requirement: phase="tracking" full isolation).
  if (phase === "starting" || phase === "tracking") {
    return (
      <div
        ref={progressRef}
        data-source-file="src/components/studio/LoraStudioTab.tsx"
        className="scroll-mt-20 space-y-6"
      >
        <div className="rounded-2xl border-gradient bg-surface/40 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
              <Sparkles size={15} className="text-neon-violet" />
              {phase === "starting" ? "学習ジョブを起動中…" : "学習の進行状況"}
            </h3>
            {/* Escape hatch — ALWAYS available. A running OR just-completed job
                is kept (soft return: polling / artefact panel stay reachable
                via the form-top banner); a failed / cancelled one is a full
                reset. */}
            <button
              type="button"
              onClick={returnToForm}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[11px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
            >
              <ArrowLeft size={12} />
              {job && (job.status === "queued" || job.status === "processing")
                ? "フォームに戻る（学習は継続）"
                : job && job.status === "completed"
                  ? "フォームに戻る（成果物は保持されます）"
                  : "フォームに戻る / リセット"}
            </button>
          </div>
          <div className="mt-4 space-y-3">
            {phase === "starting" && (
              <div className="rounded-xl border border-neon-violet/30 bg-neon-violet/5 p-4">
                <div className="flex items-center gap-2 text-sm text-neon-violet">
                  <Loader2 size={15} className="animate-spin" />
                  {optimizeProgress
                    ? `画像を送信用に最適化中… ${optimizeProgress.done}/${optimizeProgress.total} 枚`
                    : uploadProgress && uploadProgress.done < uploadProgress.total
                    ? `画像をアップロード中… ${uploadProgress.done}/${uploadProgress.total} 枚` +
                      (uploadBytes
                        ? `（${(uploadBytes.sent / 1024 / 1024).toFixed(0)} / ${(uploadBytes.total / 1024 / 1024).toFixed(0)} MB 送信済み）`
                        : "")
                      : "🚀 学習ジョブを起動しています…"}
                </div>
                {uploadProgress && (
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-background/70">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-violet transition-[width] duration-300"
                      style={{
                        // バイト基準にする（枚数は16並列ぶんまとめて動くので、
                        // 2分以上 0% のまま止まって見える）。
                        width: `${Math.round(
                          optimizeProgress
                            ? (optimizeProgress.done / Math.max(1, optimizeProgress.total)) * 100
                            : uploadBytes && uploadBytes.total > 0
                              ? (uploadBytes.sent / uploadBytes.total) * 100
                              : (uploadProgress.done / Math.max(1, uploadProgress.total)) * 100,
                        )}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            )}
            <ProgressPanel job={job} queuedElapsedSec={queuedElapsedSec} onUseLora={onUseLora} />

            {/* Transient poll failure — still retrying with backoff. A light,
                non-alarming hint; the progress bar above keeps its last value. */}
            {pollRetry > 0 && !pollLost && (
              <div className="flex items-center gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[12px] text-amber-300/90">
                <Loader2 size={13} className="shrink-0 animate-spin" />
                <span>
                  再接続中 ({pollRetry}/{MAX_RETRY_COUNT})… サーバー応答を待機しています。学習はバックエンドで継続中です。
                </span>
              </div>
            )}

            {/* Fast retries spent (or the job 404'd). Safe degraded card — the
                screen never crashed, the job keeps running server-side, and a
                slow keep-alive poll (+ an instant re-poll on tab focus /
                network recovery) is still running underneath, so this clears
                itself the moment the backend is reachable again. */}
            {pollLost && (
              <div className="space-y-3 rounded-xl border border-amber-400/40 bg-amber-400/10 p-4 text-[12px] text-amber-100">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-300" />
                  <p className="leading-relaxed">
                    ⚠️ サーバーとの通信が一時的に途絶えました。学習ジョブはバックエンドで継続中です。
                    自動で再接続を試み続けています（接続が回復すると最新の状態に自動で追いつきます）。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={retryPolling}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/40 bg-amber-300/10 px-3 py-1.5 text-[11px] font-medium text-amber-100 transition-colors hover:border-amber-300/70 hover:bg-amber-300/20"
                >
                  <RotateCcw size={12} />
                  今すぐ再接続
                </button>
              </div>
            )}

            {images.length > 0 && job?.status === "processing" && (
              <button
                type="button"
                onClick={downloadDatasetZipLocal}
                disabled={datasetZipBusy}
                title="学習に使用中の画像とキャプション(.txt)を1つのZIPにまとめて保存します。"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {datasetZipBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                📦 データセットDL (画像+txt) ・ {images.length} 枚
              </button>
            )}
            {job &&
              (job.status === "completed" ||
                job.status === "failed" ||
                job.status === "failed_timeout" ||
                job.status === "cancelled") && (
                <button
                  type="button"
                  onClick={returnToForm}
                  className="rounded-lg border border-border px-4 py-2 text-xs text-muted transition-colors hover:text-foreground"
                >
                  {job.status === "completed"
                    ? "フォームに戻って次の LoRA を作る"
                    : "新しい LoRA を学習する"}
                </button>
              )}
          </div>
        </div>
        <LoginModal
          open={loginOpen}
          onClose={() => setLoginOpen(false)}
          message="LoRA Studio でキャラクター学習を行うにはログインしてください。"
        />
      </div>
    );
  }

  if (phase === "curation") {
    return (
      <div
        ref={studioRef}
        data-source-file="src/components/studio/LoraStudioTab.tsx"
        className="scroll-mt-20 space-y-6"
      >
        <DatasetCurationUI
          pairs={curationPairs}
          onChange={setCurationPairs}
          onConfirm={confirmCuration}
          onCancel={() => {
            // Flush & Sync: carry the curated image list + latest captions
            // back to the form before leaving — "戻る" must never discard edits.
            flushCurationToForm(curationPairs);
            setPhase("form");
          }}
          requiredCredits={requiredCredits}
          triggerWord={curationTrigger}
          subjects={allSubjects.length >= 1 ? allSubjects : undefined}
          maxImages={MAX_IMAGES}
          maxTotalBytes={MAX_TOTAL_BYTES}
          canDownloadDataset={isAdmin}
          onRecaption={recaptionForCuration}
          resolvedCaptionMode={resolvedCaptionMode}
        />
        <LoginModal
          open={loginOpen}
          onClose={() => setLoginOpen(false)}
          message="LoRA Studio でキャラクター学習を行うにはログインしてください。"
        />
      </div>
    );
  }

  return (
    <div
      ref={studioRef}
      data-source-file="src/components/studio/LoraStudioTab.tsx"
      className="scroll-mt-20 space-y-6"
    >
      {/* Return-to-progress banner — always on top while a job dispatched
          this session is still queued/processing and the user has soft-
          returned to the form ("フォームに戻る（学習は継続）"). Also backs
          the multi-submit guard on the button at the bottom of this form. */}
      {inFlightJob && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neon-violet/50 bg-neon-violet/10 p-3">
          <p className="flex items-center gap-2 text-[12px] font-semibold text-neon-violet">
            <Loader2 size={14} className="animate-spin" />
            ⚡ 学習が進行中です
            {activeJobModelLabel && ` (${activeJobModelLabel} / ${inFlightProgressLabel})`}
          </p>
          <button
            type="button"
            onClick={() => setPhase("tracking")}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-1.5 text-[11px] font-semibold text-white transition-all hover:opacity-90"
          >
            進行状況パネルへ戻る
            <ArrowLeft size={12} className="rotate-180" />
          </button>
        </div>
      )}

      {/* Just-completed job — its artefact-download panel stays one click away,
          and survives a reload (mount-restore re-opens it), until the user
          either starts a new run OR explicitly dismisses it here. */}
      {completedJob && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-green-500/40 bg-green-500/10 p-3">
          <p className="flex items-center gap-2 text-[12px] font-semibold text-green-400">
            <Check size={14} />
            🏆 直前の学習が完了しています
            {activeJobModelLabel && ` (${activeJobModelLabel})`}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPhase("tracking")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-1.5 text-[11px] font-semibold text-white transition-all hover:opacity-90"
            >
              成果物をダウンロードする
              <ArrowLeft size={12} className="rotate-180" />
            </button>
            <button
              type="button"
              onClick={() => {
                dismissJob(completedJob.jobId);
                activeJobIdRef.current = "";
                setJob(null);
                setActiveJobModelLabel(null);
                if (typeof window !== "undefined") {
                  try {
                    localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
                    for (const k of LEGACY_ACTIVE_JOB_KEYS) localStorage.removeItem(k);
                  } catch {
                    /* storage disabled */
                  }
                }
              }}
              title="ダウンロード済みの場合はこれで閉じられます（成果物はサーバー側に14日間保持されます）"
              className="rounded-lg border border-border px-2.5 py-1.5 text-[11px] text-muted transition-colors hover:text-foreground"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* A previous failed / cancelled job was found at mount. It NEVER
          auto-opens (that async yank is the bug) — the user opts in here, or
          dismisses it for good. */}
      {recoveredJob && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="flex items-center gap-2 text-[12px] text-amber-300">
            <AlertTriangle size={14} />
            前回の学習ジョブは{recoveredJob.status === "cancelled" ? "中断" : "失敗"}しました（クレジットは返金済み）。中間データ・キャプションを取得できます。
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const rj = recoveredJob;
                setRecoveredJob(null);
                jobBindGenRef.current += 1;
                pollCancelledRef.current = true;
                activeJobIdRef.current = rj.jobId;
                setJob(rj);
                setPhase("tracking");
                if (typeof window !== "undefined") {
                  try {
                    localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, rj.jobId);
                  } catch {
                    /* storage disabled */
                  }
                }
              }}
              className="rounded-lg border border-amber-500/40 px-3 py-1.5 text-[11px] text-amber-200 transition-colors hover:bg-amber-500/10"
            >
              詳細・中間データを見る
            </button>
            <button
              type="button"
              onClick={() => {
                dismissJob(recoveredJob.jobId);
                setRecoveredJob(null);
              }}
              className="rounded-lg border border-border px-2.5 py-1.5 text-[11px] text-muted transition-colors hover:text-foreground"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* Draft persistence — inputs auto-save to localStorage; this button is
          the only way to wipe them. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] text-muted">
          <Check size={12} className="text-green-400" />
          入力内容は自動保存されます（リロードしても復元）
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={resetFormDraft}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[11px] text-muted transition-colors hover:border-red-400/50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw size={12} />
          フォームを初期化して新規LoRAを作成
        </button>
      </div>

      {/* オートモードは廃止（2026-09-22、ホスト判断）。経路は1本で、設定値は
          入力画像から自動で決まる。分からない人はそのまま進めばよく、変えたい
          人だけ設定欄を触る。 */}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr] lg:items-start">
        {/* Left column — dataset + captions */}
        <div className="space-y-4 rounded-2xl border-gradient bg-surface/40 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
              <ImagePlus size={15} className="text-neon-violet" />
              学習データセット
            </h3>
            {/* 2026-09-21: 学習前のデータセットDLは admin 限定にした
                （ホスト方針「生成ボタンを押す前に成果物の提供が出来ないように」）。
                自動キャプションは Gemini 無料枠で動くので、ここを開けておくと
                「画像を入れて解析させ、ZIP を落としてローカルで焼く」が成立して
                しまい、学習の対価を取れない。学習開始後（=課金済み）の
                データセットDLは従来どおり誰でも使える。 */}
            {isAdmin && images.length > 0 && (
              <button
                type="button"
                onClick={downloadDatasetZipLocal}
                disabled={busy || datasetZipBusy}
                title="【admin限定】現在の画像とキャプション(.txt)を1つのZIPにまとめて保存します。"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {datasetZipBusy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                📦 データセットDL（admin）
              </button>
            )}
          </div>
          {/* 2026-09-21: トリガーワード未入力での取り込みを弾く（ホスト指摘
              「トリガーワードとかを先にやらないとうまくいかないなら、画像の
              取り込みとかも弾くようにした方がいい」）。被写体が未登録のまま
              キャプションを走らせると、AI が誰を指すか分からず全部やり直しに
              なり、しかも無料枠を食い潰す。 */}
          {!yamlMode && !triggerWord.trim() && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-400">
              <strong>先にトリガーワードを入力してください。</strong>
              被写体が決まっていない状態で画像を解析すると、AI がどの人物か判断できず、キャプションをやり直すことになります。
            </p>
          )}
          {/* 取り込み口のすぐ上に置く（2026-09-22、ホスト指摘）。設定側に
              あると、取り込みに集中している間は視界に入らず、押し忘れたまま
              学習が始まる。文言も実態に合わせた——「アップロード後」ではなく
              実際には開始ボタンを押した直後に確認画面へ移動する。 */}
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-background/40 px-3 py-2">
            <input
              type="checkbox"
              checked={curationEnabled}
              onChange={(e) => setCurationEnabled(e.target.checked)}
              disabled={busy}
              className="mt-0.5 accent-neon-pink"
            />
            <span className="text-[11px] leading-relaxed text-muted">
              <span className="font-medium text-foreground">
                学習を始める前に、キャプションを1枚ずつ確認・編集する
              </span>
              <br />
              開始ボタンを押すと学習には進まず、確認画面へ移動します。そこで自動生成された
              キャプションを日本語で見ながら直し、そのうえで学習を開始します。
            </span>
          </label>

          <div className={`rounded-xl${flowRing("dropzone")}`}>
          <ImageDropzone
            images={images}
            onAdd={addImages}
            onRemove={removeImage}
            disabled={busy || (!yamlMode && !triggerWord.trim())}
            warnIds={multiSubjectCropIds}
            notice={addNotice}
            onDismissNotice={() => setAddNotice(null)}
            onRejectedDrop={() =>
              setErrorMessage(
                busy
                  ? "処理中は画像を追加できません。完了までお待ちください。"
                  : "先に上の「トリガーワード」を入力してください。キャプションの作り方がトリガーワードで変わるため、入力前の取り込みは受け付けていません。",
              )
            }
            recaptioningIds={recaptioningIds}
            onRecaption={(id) => void recaptionOne(id)}
            captionState={(id) =>
              (captions[id] ?? "").trim() || userCaptionIds.has(id)
                ? "ok"
                : captionErrorIds.has(id)
                  ? "error"
                  : "pending"
            }
            selectedIds={selectedImageIds}
            onSelectedChange={setSelectedImageIds}
            belowDropArea={
              <>
                {/* 解析の開始はユーザーが決める（2026-09-22、ホスト判断）。タイマーで
                    「取り込みが終わった」を判定すると、前半のフォルダに片方の被写体
                    しか無い状態で特徴を確定してしまう。 */}
                {images.length > 0 && !analysisStarted && !yamlMode && (
                  <div
                    className={`rounded-xl border border-neon-pink/40 bg-neon-pink/5 px-3 py-2.5${flowRing("startAnalysis")}`}
                  >
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setAnalysisStarted(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      <Sparkles size={13} />
                      解析を開始する（{images.length} 枚）
                    </button>
                    <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
                      画像を<strong className="text-foreground">全部入れ終えてから</strong>押してください。
                      押すと、被写体の特徴を抽出してからキャプションを作ります。
                      途中で始めると、先に入れたフォルダにしか写っていない被写体の特徴が取れません。
                      <strong className="text-foreground">押したあとに画像を足しても構いません</strong>
                      （追加分だけ解析されます）。
                    </p>
                  </div>
                )}
              </>
            }
          />
          </div>
          {flowHint("dropzone")}


          {/* キャプションの状態は取り込み欄の真下に出す（2026-09-22、ホスト
              指摘）。取り込んだ直後に「いま解析している」「終わったら診断を
              見る」が見えていないと、何をすればいいか分からない。 */}
          {/* Resume: re-analyze every image that has no caption yet (never
              started, timed out, or errored). Always visible while any remain. */}
          {!autoCap.running && images.length > 0 && pendingCaptionCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300">
              <span className="flex items-center gap-1.5">
                <AlertTriangle size={13} className="shrink-0" />
                {captionErrorCount > 0
                  ? `${pendingCaptionCount} 枚が未解析です（うち ${captionErrorCount} 枚はエラー / タイムアウト）。`
                  : `${pendingCaptionCount} 枚がまだ解析されていません。`}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void recaptionIncomplete()}
                className={`inline-flex items-center gap-1.5 rounded-md border border-amber-400/60 bg-amber-400/10 px-3 py-1.5 font-semibold text-amber-200 transition-colors hover:bg-amber-400/20 disabled:opacity-50${flowRing("recaption")}`}
              >
                <RotateCcw size={12} />
                🔄 未完了の画像（{pendingCaptionCount}枚）を再解析
              </button>
              {/* どれが未解析なのかを特定する手段が無かった（2026-09-22、
                  ホスト指摘）。選んで目で見る／まとめて捨てる、の2つを置く。
                  未解析のまま学習すると、その画像はトリガーワードだけで
                  学習され、写っている服装・背景がキャラへ焼き込まれる。 */}
              <div className="flex w-full flex-wrap items-center gap-2 border-t border-amber-500/30 pt-2">
                <span className="text-[10px] text-amber-200/80">
                  未解析のまま学習すると、その画像はトリガーワードだけで学習されます
                  （写っている服装・背景がキャラに焼き込まれます）。
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setSelectedImageIds(new Set(uncaptionedImages.map((i) => i.id)))}
                  className="rounded-md border border-amber-400/50 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:opacity-50"
                >
                  未解析の {pendingCaptionCount} 枚を選択して確認
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `未解析の ${pendingCaptionCount} 枚をデータセットから削除します。よろしいですか？`,
                      )
                    )
                      return;
                    const ids = uncaptionedImages.map((i) => i.id);
                    ids.forEach((id) => removeImage(id));
                    setSelectedImageIds(new Set());
                    setAddNotice(`未解析だった ${ids.length} 枚を削除しました。`);
                  }}
                  className="rounded-md border border-red-500/50 bg-red-500/10 px-2 py-1 text-[10px] text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                >
                  未解析の {pendingCaptionCount} 枚を削除
                </button>
              </div>
            </div>
          )}


          {/* Auto-routing badge: reflects the customCaptions / skipCaptioning
              the payload will carry, decided by what was dropped in + the AI
              vision pass result. No vendor names (CLAUDE.md §2). */}
          {images.length > 0 &&
            (autoCap.running && pendingCaptionCount > 0 ? (
              <p className="flex items-center gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/5 px-3 py-2 text-[11px] leading-relaxed text-neon-violet">
                <Loader2 size={13} className="shrink-0 animate-spin" />
                <span>
                  <span className="font-medium">高速AIビジョンが全画像を自動解析中…</span>（
                  {Math.min(aiCaptionedCount, aiTargetCount)}/{aiTargetCount}）
                  {autoCap.note && (
                    <span className="ml-1 text-neon-violet/70">— {autoCap.note}</span>
                  )}
                </span>
              </p>
            ) : hasUserCaptions ? (
              <p className="flex items-start gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-[11px] leading-relaxed text-green-400">
                <span className="shrink-0">📄</span>
                <span>
                  自前キャプション（{userCaptionCount} 件）を検知：
                  <span className="font-medium">AI解析をスキップして高速学習</span>します
                  {userCaptionCount < images.length &&
                    `（キャプション無し ${images.length - userCaptionCount} 枚はトリガーワードのみ）`}
                  。
                </span>
              </p>
            ) : aiCaptionedCount > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-[11px] leading-relaxed text-green-400">
                <span className="flex items-start gap-2">
                  <span className="shrink-0">✨</span>
                  <span>
                    <span className="font-medium">
                      高速AIビジョンが全画像を自動解析しました（最適タグを即時付与）
                    </span>

          {pendingCaptionCount > 0 &&
                      `。${pendingCaptionCount} 枚は解析できず、学習時に自動補完されます`}
                    。
                  </span>
                </span>
              </div>
            ) : (
              <p className="flex items-start gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/5 px-3 py-2 text-[11px] leading-relaxed text-neon-violet">
                <span className="shrink-0">✨</span>
                <span>
                  <span className="font-medium">高速AIビジョンが全画像を自動解析</span>
                  し、最適なタグを即時付与します（画像＋同名 .txt の ZIP を入れると自前キャプション扱い）。
                </span>
              </p>
            ))}
          {autoCap.error && !autoCap.running && (
            <p className="text-[10px] text-amber-400">⚠️ {autoCap.error}</p>
          )}

          {/* Live confirmation that the trigger word + fixed/varying spec are
              reflected in the current captions (client-side sync, no re-run). */}
          {!autoCap.running && aiCaptionedCount > 0 && curationTrigger && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-green-400">
              <span className="inline-flex items-center gap-1">
                <Check size={10} />
                キャプション {captionSubjectCounts.total} 件に被写体タグを反映済み:{" "}
                {captionSubjectCounts.rows.map(([key, n], k) => (
                  <span key={key}>
                    {k > 0 && " / "}
                    <span className="font-mono font-medium">{key}</span> {n}
                  </span>
                ))}
                {captionSubjectCounts.none > 0 && (
                  <span className="text-amber-400"> / 被写体不明 {captionSubjectCounts.none}</span>
                )}
              </span>
              {captionSpecFilled && (
                <span className="text-muted">
                  {/* 警告は「変えた場所の近く」＝被写体の設定欄へ移した
                      （2026-09-22、ホスト指摘）。ここには反映済みの事実だけ。 */}
                  ・「学習したい特徴」もキャプションに反映済み
                </span>
              )}
            </p>
          )}

          {/* 短辺が足りない画像の警告と、超解像タブへの導線（2026-09-21）。
              ワーカーは bucket_no_upscale なので小さい画像は引き伸ばされず、
              そのまま小さく学習される＝甘い LoRA になる。ホスト方針:
              「小さいときは当サイトの超解像で大きくしてから再投入」。 */}
          {/* 切り出した画像は人手で点検しないと使えない（2026-09-22）。
              判断基準と**切り出した画像だけのグリッド**をクロップ欄の直下に
              置く。上のサムネイル一覧まで戻って探させない（ホスト指摘）。 */}
          {croppedImages.length > 0 && (
            <div
              id={CROP_REVIEW_PANEL_ID}
              className="space-y-2 scroll-mt-24 rounded-lg border border-neon-violet/30 bg-neon-violet/5 px-3 py-2"
            >
              <p className="text-[11px] font-medium text-neon-violet">
                切り出した {croppedImages.length} 枚を確認してください
              </p>
              <ul className="space-y-0.5 text-[10px] leading-relaxed text-muted">
                <li>
                  ・
                  <strong className="text-foreground">
                    顔（目・鼻・口）がフレームから欠けている画像は削除してください。
                  </strong>
                  顔が欠けた絵を学習させると、その構図での再現性が落ちます。頭頂部が少し切れている程度は問題ありません。
                </li>
                <li>・体が胸や腰で切れているのは問題ありません。それが上半身クロップの目的です。</li>
                <li>
                  ・
                  <strong className="text-foreground">
                    別の被写体が顔なしで大きく写り込んでいる画像も削除してください。
                  </strong>
                  顔が無いとその被写体の学習には使えず、かといって主役の特徴として吸収されてしまいます。
                </li>
                <li>・端にわずかに他の被写体が入る程度（細い帯）は無視して構いません。</li>
              </ul>
              {multiSubjectCrops.length > 0 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
                  <p className="text-[10px] leading-relaxed text-amber-400">
                    このうち <strong>{multiSubjectCrops.length} 枚</strong>{" "}
                    は、切り出したあとも2人以上写っていると判定されました。
                    <strong>上のサムネイル一覧で琥珀色の枠が付いているものがそれです。</strong>
                    <br />
                    <strong>両方の顔がはっきり写っているなら残してください</strong>
                    ——2人が同じ絵にいる構図は貴重な素材です。
                    <strong>腕や服の端だけが残っているものは削除してください</strong>
                    ——その人物の学習には使えないうえ、主役の特徴として吸収されてしまいます。
                  </p>
                </div>
              )}
              {/* 専用グリッドは廃止（2026-09-22、ホスト指摘）。切り出した画像は
                  上のサムネイル一覧の末尾に入るので、そちらで確認する。被写体が
                  2人以上いると、ここに一覧があると2人目のために上へ戻る往復が
                  増えるため。 */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedImageIds(new Set(croppedImages.map((i) => i.id)))}
                  className="inline-flex items-center gap-1 rounded-lg border border-neon-violet/40 bg-neon-violet/10 px-2.5 py-1 text-[10px] font-medium text-neon-violet transition-colors hover:bg-neon-violet/20"
                >
                  <Scissors size={11} />
                  切り出した {croppedImages.length} 枚を選択して目立たせる
                </button>
                {/* 点検が済んだら次の工程へ送る（2026-09-22、ホスト指摘）。
                    まだ切り出しが要るなら診断側の準備ボタンが光っているし、
                    要らなければ学習回数と実行が光っている。どちらにせよ
                    「次に光っている場所」へ着地させればよい。 */}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedImageIds(new Set());
                    document
                      .getElementById(DIAGNOSTICS_PANEL_ID)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  className="inline-flex items-center gap-1 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-2.5 py-1 text-[10px] font-semibold text-white transition-opacity hover:opacity-90"
                >
                  点検が終わったので次へ進む →
                </button>
              </div>
            </div>
          )}

          {tooSmallImages.length > 0 && (
            <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
              <p className="text-[11px] leading-relaxed text-amber-400">
                <strong>{tooSmallImages.length} 枚</strong> は短辺が {MIN_SHORT_EDGE_ERROR}px
                 未満です。このまま学習すると、その画像だけ解像度が足りないまま学習され、仕上がりが甘くなります
                （引き伸ばしはしません。ぼけた絵を学習するほうが害が大きいため）。
              </p>
              {onOpenUpscale && (
                <button
                  type="button"
                  onClick={onOpenUpscale}
                  className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-500/20"
                >
                  <Wand2 size={11} />
                  ✨ 超解像で拡大してから入れ直す
                </button>
              )}
              <p className="text-[10px] leading-relaxed text-muted">
                該当:{" "}
                {tooSmallImages
                  .slice(0, 5)
                  .map((i) => i.file.name)
                  .join(", ")}
                {tooSmallImages.length > 5 ? " ほか" : ""}
              </p>
            </div>
          )}


          {/* データセット構成の自動診断（2026-09-21）。キャプションが1枚でも
              揃った時点から出す。「この構成だと誰がどう弱くなるか」を焼く前に
              知らせるのが目的で、オートモードでのクレーム防止が本題。
              src/lib/datasetDiagnostics.ts のヘッダに動機と実データの検証あり。 */}
          {diagnosticItems.length > 0 && (
            <div id={DIAGNOSTICS_PANEL_ID} className={`scroll-mt-24 rounded-xl${flowRing("diagnostics")}`}>
            <DatasetDiagnosticsPanel
              // 未解析が残っていないなら「解析中」と出す意味が無い（旗が
              // 立ちっぱなしでも診断が固まらないようにする二重の保険）。
              provisional={autoCap.running && pendingCaptionCount > 0}
              // 解析が止まっているのに「解析中」と出し続けない（2026-09-22、
              // ホスト報告）。空の結果が返った画像は「試行済み」扱いになり
              // 自動では再試行されないので、件数と再解析の導線を出す。
              stalledCount={!autoCap.running ? pendingCaptionCount : 0}
              items={diagnosticItems}
              subjects={allSubjects}
              onOpenMultiAngle={onOpenMultiAngle}
              onPrepareCrop={prepareCropForSubject}
              highlightPrepare={flow.targets.includes("cropPrepare")}
            />
            </div>
          )}

          {/* 診断の下にクロップ欄を置く（2026-09-22、ホスト指摘）。
              何が足りないかを見てから切り出す、という順番にする。 */}
          <div>
          <SmartCropPanel
            images={images}
            disabled={busy}
            selectedIds={selectedImageIds}
            onSelectedChange={setSelectedImageIds}
            distanceById={distanceById}
            cropKinds={cropKindSelection}
            onCropKindsChange={setCropKindSelection}
            smartCropBusy={smartCropBusy}
            smartCropProgress={smartCropProgress}
            onSmartCrop={(ids, kinds) => void runSmartCropForDataset(ids, kinds)}
            highlightRun={flow.targets.includes("crop")}
          />
          </div>
          {flowHint("crop")}

          {/* データセットを触る工程の最後（2026-09-22、ホスト指摘）。
              取り込み → クロップ → 診断 を見てから比率を決める操作なので、
              順番として最後でないと「これで終わりなのか」が分からなくなる。 */}
          {images.length > 0 && (
            <div>
            <RepeatWeightPanel
              images={images}
              disabled={busy}
              onSetRepeats={setImageRepeats}
              selectionGroups={selectionGroups}
              selectedIds={selectedImageIds}
              onSelectedChange={setSelectedImageIds}
              onSuggestRepeats={captionSubjectCounts.total > 0 ? applySuggestedRepeats : undefined}
              onGoToSettings={() =>
                document
                  .getElementById(LORA_SETTINGS_ANCHOR_ID)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              highlightSuggest={flow.targets.includes("suggestRepeats")}
              suggestNotice={repeatsNotice}
            />
            </div>
          )}
          {flowHint("suggestRepeats")}

          {zipBusy && (
            <p className="flex items-center gap-1.5 text-[11px] text-neon-violet">
              <Loader2 size={12} className="animate-spin" />
              ZIP を展開しています…
            </p>
          )}
          {totalBytes > MAX_TOTAL_BYTES && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-400">
              画像の合計サイズが上限（{(MAX_TOTAL_BYTES / 1024 / 1024 / 1024).toFixed(1)} GB）を超えています。枚数を減らしてください（画質はサーバー側で自動最適化されます）。
            </p>
          )}


        </div>

        {/* Right column — settings */}
        <div className="space-y-4 rounded-2xl border-gradient bg-surface/40 p-5">
          {/* ベースモデルは一番上（2026-09-22、ホスト指摘）。学習対象や
              複数人物の指定が SDXL 系かどうかで変わるため、これを先に
              決めないと下の欄が出たり消えたりして混乱する。 */}
          <div className="space-y-2">
            <label className="block text-[11px] font-medium text-muted">ベースモデル</label>
            <div className={`rounded-xl${flowRing("baseModel")}`}>
            <select
              value={modelChoice}
              onChange={(e) => {
                setBaseModelTouched(true);
                handleModelChange(e.target.value);
              }}
              disabled={busy}
              className={fieldCls}
            >
              {PRESET_GROUPS.map((g) => (
                <optgroup key={g} label={LORA_PRESET_GROUP_LABELS[g]}>
                  {LORA_PRESETS.filter((p) => p.group === g).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} — {p.note}
                    </option>
                  ))}
                </optgroup>
              ))}
              {/* "任意の HuggingFace Repo ID を手動指定" is sealed out of the
                  general UI — the 12-model commercial lineup above is the
                  only base-model entry point. isCustom / customModelId /
                  baseArchitecture stay wired underneath (handleModelChange,
                  runTraining, pricing) as inert dead code so a still-saved
                  old form draft with modelChoice="__custom__" degrades to
                  "no matching preset" rather than a crash — nothing in this
                  UI can set modelChoice to "__custom__" any more. */}
            </select>
            </div>
            {flowHint("baseModel")}
          </div>
          <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
            <Cpu size={15} className="text-neon-violet" />
            学習設定
          </h3>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted">LoRA 名</label>
            <input
              value={yamlMode ? (yamlIdentity?.name ?? "") : loraName}
              onChange={(e) => setLoraName(e.target.value)}
              placeholder={yamlMode ? "生YAML の config.name" : "yukipas_h3"}
              disabled={busy || yamlMode}
              className={`${fieldCls} font-mono ${
                yamlMode
                  ? "opacity-60"
                  : loraName && !nameValid
                    ? "border-red-500/50"
                    : ""
              }${flowRing("loraName")}`}
            />
            {flowHint("loraName")}
            {yamlMode ? (
              <p className="mt-1 text-[10px] text-muted">
                生YAML モードでは YAML内の <code className="text-neon-violet">config.name</code> が LoRA 名になります。
                {!yamlNameValid && (
                  <span className="text-red-400">
                    {" "}
                    YAML に有効な <code>config.name</code> を記述してください。
                  </span>
                )}
              </p>
            ) : (
              loraName &&
              !nameValid && (
                <p className="mt-1 text-[10px] text-red-400">
                  英数字・ハイフン・アンダースコア・ドットのみ（64文字以内）
                </p>
              )
            )}
          </div>

          <div>
            {/* 2026-09-21: 複数人物モードの見分けがつかない問題を直した
                （ホスト指摘「一人目と二人目の境が無く、よく考えたらわかるん
                だけどちょっと戸惑う」）。1人目だけ枠もラベルも無く、しかも
                1人目の「特徴」欄は2人目を追加した瞬間に現れるので、2人目の
                ブロックの一部に見えていた。複数人物のときは1人目も同じ枠で
                囲んで「N人目」の見出しを付ける。1人だけのときは従来どおり
                素のまま（枠と番号はノイズにしかならない）。 */}
            <label
              id={SUBJECTS_PANEL_ID}
              className="mb-1 block scroll-mt-24 text-[11px] font-medium text-muted"
            >
              トリガーワード（任意）
            </label>
            {(() => {
              const multiSubject = !yamlMode && isSdxlJob && extraSubjects.length > 0;
              const triggerInput = (
                <input
                  value={yamlMode ? (yamlIdentity?.triggerWord ?? "") : triggerWord}
                  onChange={(e) => setTriggerWord(e.target.value)}
                  placeholder={
                    yamlMode
                      ? "生YAML の process[0].trigger_word"
                      : multiSubject
                        ? "1人目のtrigger word（例: yukipas）"
                        : "yukipas（空欄なら LoRA 名から自動）"
                  }
                  disabled={busy || yamlMode}
                  className={`${fieldCls} font-mono ${yamlMode ? "opacity-60" : ""}${flowRing("trigger")}`}
                />
              );
              const triggerHint = (
                <>
                  {flowHint("trigger")}
                  {flowHint("genderTag")}
                  {flowHint("description")}
                  {flowHint("addSubject")}
                </>
              );
              if (!multiSubject) {
                return (
                  <>
                    {triggerInput}
                    {!yamlMode && isSdxlJob && (
                      <>
                        <div className={`rounded-xl${flowRingAt("genderTag", 0)}`}>
                          <GenderTagPicker value={primaryFixedTags} onChange={setPrimaryFixedTags} disabled={busy} />
                        </div>
                        {triggerHint}
                        <input
                          value={primaryDescription}
                          onChange={(e) => setPrimaryDescription(e.target.value)}
                          placeholder="どんな人物か（例: 太った禿頭の男性）"
                          disabled={busy}
                          className={`${fieldCls} mt-1.5 text-[11px]${flowRingAt("description", 0)}`}
                        />
                        <p className="mt-0.5 text-[10px] leading-relaxed text-muted">
                          下の特徴を画像から自動抽出するときの精度を上げるためのメモです。
                          <strong className="text-foreground">学習内容には影響しません</strong>。
                        </p>
                        {/* 「画像から抽出」が主経路なので、画像が入るまで出さない（2026-09-21）。 */}
                        {images.length > 0 && (
                        <IdentityTagsField
                          value={primaryIdentityTags}
                          valueJa={primaryIdentityTagsJa}
                          onChange={(next) => {
                            setPrimaryIdentityTags(next.en);
                            setPrimaryIdentityTagsJa(next.ja);
                            setIdentityConfirmed(false);
                          }}
                          extracting={identityExtracting === -1}
                          onTranslateTag={translateIdentityTag}
                          onRedo={() => redoIdentityExtract(-1)}
                          blockedReason={
                            primaryFixedTags.trim()
                              ? null
                              : "上の「性別/人数タグ」を選ぶと、画像から自動で抽出します（誰を見るかの判定に必要です）。"
                          }
                          disabled={busy}
                        />
                        )}
                      </>
                    )}
                  </>
                );
              }
              return (
                <div className="rounded-lg border border-neon-violet/30 bg-neon-violet/5 p-2">
                  <div className="mb-1 text-[10px] font-semibold text-neon-violet">1人目</div>
                  {triggerInput}
                  <div className={`rounded-xl${flowRingAt("genderTag", 0)}`}>
                          <GenderTagPicker value={primaryFixedTags} onChange={setPrimaryFixedTags} disabled={busy} />
                        </div>
                  {triggerHint}
                  <input
                    value={primaryDescription}
                    onChange={(e) => setPrimaryDescription(e.target.value)}
                    placeholder="1人目を見分ける手がかり（例: 太った禿頭の男性）"
                    disabled={busy}
                    className={`${fieldCls} mt-1.5 text-[11px]${flowRingAt("description", 0)}`}
                  />
                  <p className="mt-0.5 text-[10px] leading-relaxed text-muted">AI がどちらの人物かを判定するためのメモです。<strong className="text-foreground">学習内容には影響しません</strong>（学習させる特徴は下で決めます）。</p>
                  {/* 「画像から抽出」が主経路なので、画像が入るまで出さない（2026-09-21）。 */}
                  {images.length > 0 && (
                  <IdentityTagsField
                    value={primaryIdentityTags}
                    valueJa={primaryIdentityTagsJa}
                    onChange={(next) => {
                      setPrimaryIdentityTags(next.en);
                      setPrimaryIdentityTagsJa(next.ja);
                      setIdentityConfirmed(false);
                    }}
                    extracting={identityExtracting === -1}
                    onTranslateTag={translateIdentityTag}
                    onRedo={() => redoIdentityExtract(-1)}
                    blockedReason={
                      primaryFixedTags.trim()
                        ? null
                        : "上の「性別/人数タグ」を選ぶと、画像から自動で抽出します（誰を見るかの判定に必要です）。"
                    }
                    disabled={busy}
                  />
                  )}
                </div>
              );
            })()}
            {yamlMode && (
              <p className="mt-1 text-[10px] text-muted">
                生YAML モードでは YAML内の{" "}
                <code className="text-neon-violet">process[0].trigger_word</code> が使われます。
              </p>
            )}
            {/* 性別/人数タグ・複数人物UIはSDXL（Danbooruタグ形式のkeep_tokens
                運用）限定。それ以外のモデルはトリガーワード入力のみにする
                （2026-09-15 ホスト指示）。 */}
            {!yamlMode &&
              isSdxlJob &&
              extraSubjects.map((s, i) => (
                <div
                  key={i}
                  className="mt-1.5 rounded-lg border border-neon-violet/30 bg-neon-violet/5 p-2"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-neon-violet">{i + 2}人目</span>
                    <button
                      type="button"
                      onClick={() => setExtraSubjects((prev) => prev.filter((_, k) => k !== i))}
                      disabled={busy}
                      title="この人物を削除"
                      className="rounded-lg border border-border px-1.5 py-0.5 text-muted transition-colors hover:border-red-500/50 hover:text-red-400 disabled:opacity-50"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <input
                    value={s.trigger}
                    onChange={(e) =>
                      setExtraSubjects((prev) =>
                        prev.map((p, k) => (k === i ? { ...p, trigger: e.target.value } : p)),
                      )
                    }
                    placeholder={`${i + 2}人目のtrigger word（例: kocho）`}
                    disabled={busy}
                    // 追加した直後はここへカーソルを置く（2026-09-22、ホスト指摘）。
                    ref={(el) => {
                      if (el && focusSubjectRef.current === i) {
                        focusSubjectRef.current = null;
                        el.focus();
                      }
                    }}
                    className={`${fieldCls} font-mono`}
                  />
                  <div className={`rounded-xl${flowRingAt("genderTag", i + 1)}`}>
                  <GenderTagPicker
                    value={s.fixedTags ?? ""}
                    onChange={(next) =>
                      setExtraSubjects((prev) => prev.map((p, k) => (k === i ? { ...p, fixedTags: next } : p)))
                    }
                    disabled={busy}
                  />
                  </div>
                  <input
                    value={s.description}
                    onChange={(e) =>
                      setExtraSubjects((prev) =>
                        prev.map((p, k) => (k === i ? { ...p, description: e.target.value } : p)),
                      )
                    }
                    placeholder={`${i + 2}人目を見分ける手がかり（例: 銀髪ロングの女性）`}
                    disabled={busy}
                    className={`${fieldCls} mt-1.5 text-[11px]${flowRingAt("description", i + 1)}`}
                  />
                  <p className="mt-0.5 text-[10px] leading-relaxed text-muted">AI がどちらの人物かを判定するためのメモです。<strong className="text-foreground">学習内容には影響しません</strong>（学習させる特徴は下で決めます）。</p>
                  {/* 「画像から抽出」が主経路なので、画像が入るまで出さない（2026-09-21）。 */}
                  {images.length > 0 && (
                  <IdentityTagsField
                    value={s.identityTags ?? ""}
                    valueJa={s.identityTagsJa ?? ""}
                    onChange={(next) => {
                      setExtraSubjects((prev) =>
                        prev.map((p, k) =>
                          k === i ? { ...p, identityTags: next.en, identityTagsJa: next.ja } : p,
                        ),
                      );
                      setIdentityConfirmed(false);
                    }}
                    extracting={identityExtracting === i}
                    onTranslateTag={translateIdentityTag}
                    onRedo={() => redoIdentityExtract(i)}
                    blockedReason={
                      (s.fixedTags ?? "").trim()
                        ? null
                        : "上の「性別/人数タグ」を選ぶと、画像から自動で抽出します（誰を見るかの判定に必要です）。"
                    }
                    disabled={busy}
                  />
                  )}
                </div>
              ))}
            {/* 初回だけ出す（2026-09-22、ホスト指摘）。一度読めば済む説明で、
                毎回出ると画面の密度を上げるだけ。localStorage に既読を持つ。 */}
            {!yamlMode && isSdxlJob && extraSubjects.length > 0 && !subjectHintSeen && (
              <p className="mt-1.5 rounded-lg border border-border/60 bg-background/60 px-2 py-1.5 text-[10px] leading-relaxed text-muted">
                「特徴」は、自動キャプションのAIが画像ごとに
                <strong className="text-foreground">どちらが写っているかを判定するための手がかり</strong>
                です。髪色・性別・服装など、写真を見て区別できる見た目だけで十分です。
                <strong className="text-foreground">空のままだとAIが2人を見分けられず、トリガーワードが取り違えられます。</strong>
              </p>
            )}
            {!yamlMode && isSdxlJob && (
              <button
                type="button"
                onClick={() =>
                  setExtraSubjects((prev) => {
                    focusSubjectRef.current = prev.length;
                    return [...prev, { trigger: "", description: "", fixedTags: "" }];
                  })
                }
                disabled={busy}
                className={`mt-1.5 inline-flex items-center gap-1 rounded-lg px-1 text-[11px] text-muted transition-colors hover:text-neon-violet disabled:opacity-50${flowRing("addSubject")}`}
              >
                <Plus size={12} />
                別の人物を追加（複数人物・被写体を1つのLoRAで区別したい場合）
              </button>
            )}
            {/* キャプションが古くなった警告は、変えた場所の近くに出す
                （2026-09-22、ホスト指摘）。以前はキャプション欄にあり、
                設定を変えた本人が気付けなかった。 */}
            {aiCaptionedCount > 0 && captionSpecStale(captionSpecKey, reflectedSpecKey) && (
              <div className="mt-2 space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-400">
                <p>
                  <strong>キャプションを作り直します。</strong>
                  いまのキャプションは「作成時」の内容で作られていて、「現在」と食い違っています。
                  「学習したい特徴」はキャプションに書いてはいけない言葉のリストとして使われるため、
                  ずれたままにはできません。次へ進むと {aiCaptionedCount} 枚ぶんを作り直します（数分）。
                </p>
                {/* 何が変わったのかを出す（2026-09-22、ホスト指摘「特に何もして
                    いないのに出る」）。自分で変えていなくても、特徴の自動抽出が
                    前回と違う結果を返せばここは変わる。差分が見えれば納得できる。 */}
                {/* 「前回」だと前のセッションと誤解される（2026-09-22、ホスト指摘）。
                    比べているのは同じセッション内の「キャプションを作った時点」と
                    「現在」。リセット時は記録も消すので、前のセッションは残らない。 */}
                <p className="text-muted">
                  作成時: <span className="text-foreground">{reflectedSpecSummary || "（なし）"}</span>
                </p>
                <p className="text-muted">
                  現在: <span className="text-foreground">{captionSpec.fixed || "（なし）"}</span>
                </p>
              </div>
            )}
          </div>

          {/* SDXL/sd-scriptsワーカー限定: 完成した.safetensorsに書き込む
              「おすすめタグ」を手動指定する任意機能（2026-09-15）。未指定なら
              sd-scripts純正のメタデータ（実際のキャプション由来）のまま。 */}
          {/* 画像が1枚も無いうちは出さない（2026-09-21、ホスト指摘）。
              「画像から抽出」が主経路なので、素材が無い状態で見せても
              できることが無い。 */}
          {!yamlMode && isSdxlJob && images.length > 0 && (
            <div
              id={METADATA_PANEL_ID}
              className="scroll-mt-24 rounded-xl border border-neon-violet/30 bg-neon-violet/5"
            >
              <button
                type="button"
                onClick={() => setEmbedTagsOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
              >
                <span className="flex items-center gap-2 text-[11px] font-medium text-neon-violet">
                  <Tag size={13} />
                  🏷️ メタデータタグ埋め込み（任意・SDXL限定）
                </span>
                <ChevronDown
                  size={14}
                  className={`shrink-0 text-muted transition-transform ${
                    embedTagsOpen || needsIdentityConfirm ? "rotate-180" : ""
                  }`}
                />
              </button>

              {/* 確認が済むまでは畳ませない。ボタンが「埋め込むタグを確認して
                  ください」と言っているのに、確認欄が折りたたみの中にあると
                  詰まるため。 */}
              {(embedTagsOpen || needsIdentityConfirm) && (
                <div className="space-y-2 px-3 pb-3">
                  {/* 2026-09-21: 自動生成に切り替えた。ここは「この LoRA を
                      正しく呼び出すためのトークン」であり、キャプションから
                      意図的に外したもの（trigger / 数・性別タグ / identity）と
                      ちょうど逆の関係にある。被写体登録から機械的に作れるので、
                      書式（"tag:頻度"）をユーザーに説明する必要はもう無い。
                      keep_tokens の手入力欄は廃止（キャプションから自動算出）。 */}
                  <p className="text-[10px] leading-relaxed text-muted">
                    学習完了後の .safetensors に、ComfyUI / Civitai / A1111 等が「Trained words」として読むタグを書き込みます。
                    ComfyUI 側で「LoRA を読み込んだらメタデータのタグをプロンプトへ追加する」運用をしている場合、ここが生成時の再現性に直結します。
                  </p>
                  <div className="rounded-lg border border-border/60 bg-background/60 px-2 py-1.5">
                    <div className="text-[10px] font-medium text-foreground">実際に書き込まれる内容</div>
                    <code className="mt-1 block break-all font-mono text-[10px] text-neon-violet">
                      {effectiveEmbedTags || "（トリガーワードを入力すると表示されます）"}
                    </code>
                    {/* 2026-09-21: 納品物（.safetensors の metadata）に焼かれて
                        ユーザーの手元へ渡るものなので、目視確認するまで学習を
                        開始させない（ホスト方針）。 */}
                    {effectiveEmbedTags.trim() && (
                      <label
                        className={`mt-2 flex cursor-pointer items-start gap-1.5 rounded-lg p-1 text-[10px] leading-relaxed text-foreground${flowRing("identityConfirm")}`}
                      >
                        {/* 抽出が終わる前に確認させない（2026-09-22、ホスト報告
                            「何もしていないのに作り直しの警告が出る」）。先に
                            チェックするとキャプション解析が特徴の空な状態で
                            始まり、直後に抽出が入って必ず食い違う。 */}
                        <input
                          type="checkbox"
                          checked={identityConfirmed}
                          onChange={(e) => setIdentityConfirmed(e.target.checked)}
                          disabled={busy || identityExtracting !== null}
                          className="mt-0.5 accent-neon-violet"
                        />
                        <span>
                          {identityExtracting !== null
                            ? "特徴を抽出しています… 終わるまでお待ちください"
                            : "この内容で書き込むことを確認しました"}
                          {!identityConfirmed && (
                            <span className="ml-1 text-amber-400">（チェックするまで学習を開始できません）</span>
                          )}
                        </span>
                      </label>
                    )}
                    {flowHint("identityConfirm")}
                    {/* 確認して直す場所は上の「学習したい特徴」（2026-09-22、
                        ホスト指摘）。ここからジャンプできるようにする。 */}
                    {needsIdentityConfirm && (
                      <button
                        type="button"
                        onClick={() =>
                          document
                            .getElementById(SUBJECTS_PANEL_ID)
                            ?.scrollIntoView({ behavior: "smooth", block: "start" })
                        }
                        className="mt-1 inline-flex items-center gap-1 rounded-lg border border-neon-pink/50 bg-neon-pink/15 px-2.5 py-1 text-[10px] font-semibold text-neon-pink transition-colors hover:bg-neon-pink/25"
                      >
                        ↑ 抽出した特徴を見に行く（直せます）
                      </button>
                    )}
                    <p className="mt-1 text-[10px] leading-relaxed text-muted">
                      {/* 日本語で入れた特徴が英タグへ変換されて入ることを明示する
                          （2026-09-22、ホスト指摘）。ここだけ見ると英語がどこから
                          来たのか分からない。 */}
                      トリガーワード＋性別/人数タグ＋
                      <strong className="text-foreground">「学習したい特徴」</strong>
                      から組み立てています。特徴は日本語で表示していますが、
                      <strong className="text-foreground">
                        ここには英語のタグへ自動変換されたものが入ります
                      </strong>
                      （例:「禿頭」→ <code className="text-neon-violet">bald</code>）。
                      これらは
                      <strong className="text-foreground">キャプションには書かれず（＝トリガーに焼き込まれ）</strong>
                      、生成時にプロンプトへ戻して使います。
                    </p>
                  </div>
                  {/* 2026-09-22: 「追加で埋め込むタグ」欄は廃止（ホスト判断）。
                      ここに足したいものは結局「トリガーワードに焼き込みたい
                      特徴」であり、それは上の「学習したい特徴」に足せば英タグに
                      変換されて自動でここへ入る。同じ情報の入口が2つあると、
                      片方（この欄）だけ日本語のまま metadata に焼かれる事故が
                      起きる（実際に起きた）。 */}
                </div>
              )}
            </div>
          )}


          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted">学習解像度</label>
            <p className={`${fieldCls} flex items-center text-muted`}>{LORA_RESOLUTION_LABELS[resolution]}</p>
            <p className="mt-1 text-[10px] text-muted">
              モデルに最適な解像度で自動的に学習します（選択の必要はありません）。
            </p>
          </div>

          {/* LoRA-type-aware auto-caption spec — category + JP fixed/varying */}
          <div className={`rounded-xl border border-neon-violet/30 bg-neon-violet/5${flowRing("captionSpec")}`}>
            <button
              type="button"
              onClick={() => setCaptionPromptOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
            >
              <span className="flex items-center gap-2 text-[11px] font-medium text-neon-violet">
                <Bot size={13} />
                🤖 学習タイプ別 キャプション自動最適化
                <span className="rounded bg-neon-violet/15 px-1.5 py-0.5 text-[9px] font-semibold text-neon-violet">
                  {captionCategoryMeta.icon} {captionCategoryMeta.label}
                </span>
              </span>
              <ChevronDown
                size={14}
                className={`shrink-0 text-muted transition-transform ${captionPromptOpen ? "rotate-180" : ""}`}
              />
            </button>

            {captionPromptOpen && (
              <div className="space-y-3 px-3 pb-3">
                <p className="text-[10px] leading-relaxed text-muted">
                  学習タイプを選ぶと、その種類に合ったキャプションの方針が自動で適用されます。
                  「次へ」を押すと、画像解析エンジン向けの英語キャプション指示をAIが組み立てて反映します。
                </p>
                {/* 2026-09-21: 「入力しないと何も効かない」と誤解されていた
                    （ホスト確認）。実際は学習タイプごとの既定ルールが常に
                    効いていて、入力はその追加。以前は入力すると既定が
                    置き換わる実装で、1語足しただけで顔や髪色が
                    ブラックリストから外れる事故があった（loraCaptionSpec.ts
                    の buildCaptionMetaPrompt のコメント参照）。 */}
                {/* 確定リストがある間は、手入力の固定/変化を出さない
                    （2026-09-21 の宣言方式移行）。上の「学習したい特徴」が
                    ブラックリストそのものになるので、同じことを2箇所で
                    指定させると矛盾するため。代わりに結果を日本語で見せる。 */}
                {confirmedIdentityJa ? (
                  <div className="rounded-lg border border-border/60 bg-background/60 px-2 py-1.5 text-[10px] leading-relaxed text-muted">
                    <p>
                      上の<strong className="text-foreground">「学習したい特徴」</strong>がそのまま適用されます。
                    </p>
                    <p className="mt-1">
                      🔒 <strong className="text-foreground">トリガーワードに焼き込む</strong>（キャプションに書かない）:
                      <span className="ml-1 text-neon-pink">{confirmedIdentityJa}</span>
                    </p>
                    <p className="mt-1">
                      ✏️ <strong className="text-foreground">毎回キャプションに書く</strong>（学習しない）:
                      <span className="ml-1">上記以外すべて — 顔立ち・髪型・髪色・目の色も含め、ポーズ・表情・構図・背景・光</span>
                    </p>
                    <p className="mt-1 opacity-80">
                      焼き込みたくないものは、上のリストから <strong className="text-foreground">×</strong> で外してください。
                    </p>
                  </div>
                ) : (
                <p className="rounded-lg border border-border/60 bg-background/60 px-2 py-1.5 text-[10px] leading-relaxed text-muted">
                  <strong className="text-foreground">通常は両方とも空欄のままで構いません。</strong>
                  学習タイプを選んだ時点で既定ルールが効いています。人物なら、顔立ち・髪型・髪色・目の色・固有の装飾品は
                  <strong className="text-foreground">キャプションに書かれず、トリガーワードに焼き込まれます</strong>。
                  ポーズ・表情・構図・背景・光だけが描写されます。
                  <br />
                  <span className="text-foreground">入力が要るのは、その既定を変えたいときだけです。</span>
                  例:「全部の画像で眼鏡をかけているが、眼鏡はこのキャラの特徴にしたくない（外した絵も出したい）」→
                  <strong className="text-foreground">変化させたい特徴に「眼鏡」</strong>と入力。
                  逆に既定では拾われない持ち物などを焼き込みたければ、固定したい特徴に書きます。
                  <strong className="text-foreground">ここに書いた指定は既定より優先されます。</strong>
                  <br />
                  ⚠️ 学習タイプを「衣装」にすると<strong className="text-foreground">逆になります</strong>（衣装を書かず、着ている人の顔や髪を描写）。人物LoRAでは「キャラクター／人物」を選んでください。
                </p>
                )}

                {/* Caption FORMAT — dense prose vs. comma tags, routed by the
                    selected base model unless the user pins it. */}
                <div className="space-y-1.5 rounded-lg border border-border bg-background/40 p-2">
                  <label className="block text-[10px] font-medium text-foreground">
                    📝 キャプション形式
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        { id: "auto", label: "自動判定（推奨）" },
                        { id: "dense", label: "Dense（自然言語散文）" },
                        { id: "tags", label: "Tags（タグ列）" },
                      ] as { id: CaptionMode; label: string }[]
                    ).map((o) => {
                      const active = captionMode === o.id;
                      return (
                        <button
                          key={o.id}
                          type="button"
                          disabled={busy}
                          onClick={() => setCaptionMode(o.id)}
                          className={`rounded-lg border px-2.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                            active
                              ? "border-neon-violet/50 bg-neon-violet/10 text-neon-violet"
                              : "border-border bg-background/60 text-muted hover:border-neon-violet/40"
                          }`}
                        >
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[10px] leading-relaxed text-muted">
                    {captionMode === "auto" ? (
                      <>
                        現在「{captionModelLabel}」選択中：自動的に
                        <span className="font-semibold text-neon-violet">
                          {resolvedCaptionMode === "dense"
                            ? "【Dense（自然言語）】"
                            : "【Tags（タグ列）】"}
                        </span>
                        が適用されます
                        {resolvedCaptionMode === "dense"
                          ? "（LLM/VLM テキストエンコーダ搭載の次世代モデル向け）。"
                          : "（77トークン CLIP・Danbooru タグ特化の SDXL 系向け）。"}
                      </>
                    ) : (
                      <>
                        手動指定：
                        <span className="font-semibold text-neon-violet">
                          {resolvedCaptionMode === "dense"
                            ? "【Dense（自然言語）】"
                            : "【Tags（タグ列）】"}
                        </span>
                        を使用します（モデル自動判定を上書き）。
                      </>
                    )}
                  </p>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {LORA_CAPTION_CATEGORIES.map((c) => {
                    const m = LORA_CAPTION_CATEGORY_META[c];
                    const active = captionCategory === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        disabled={busy}
                        onClick={() => setCaptionCategory(c)}
                        title={m.hint}
                        className={`rounded-lg border px-2.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                          active
                            ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                            : "border-border bg-background/60 text-muted hover:border-neon-violet/40"
                        }`}
                      >
                        {m.icon} {m.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted">{captionCategoryMeta.hint}</p>

                <div>
                  <label className="mb-1 block text-[10px] font-medium text-foreground">
                    🔒 固定したい特徴（学習させる／キャプションに書かない）
                  </label>
                  <textarea
                    value={captionFixed}
                    onChange={(e) => setCaptionFixed(e.target.value)}
                    rows={3}
                    disabled={busy}
                    placeholder={captionCategoryMeta.fixedPlaceholder}
                    className={`${fieldCls} resize-y text-[11px] leading-relaxed`}
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[10px] font-medium text-foreground">
                    🔄 変化させたい特徴（キャプションで描写する）
                  </label>
                  <textarea
                    value={captionVarying}
                    onChange={(e) => setCaptionVarying(e.target.value)}
                    rows={3}
                    disabled={busy}
                    placeholder={captionCategoryMeta.varyingPlaceholder}
                    className={`${fieldCls} resize-y text-[11px] leading-relaxed`}
                  />
                </div>

                {!captionSpecFilled && !captionPromptOverride.trim() && (
                  <p className="text-[10px] text-muted opacity-80">
                    未入力の場合はワーカー標準のキャプション指示で学習します。
                  </p>
                )}

                {captionGen.state === "generating" && (
                  <p className="flex items-center gap-1.5 text-[10px] text-neon-violet">
                    <Loader2 size={11} className="animate-spin" />
                    英語プロンプトを生成中…
                  </p>
                )}
                {captionGen.state === "done" && captionGen.prompt && (
                  <div className="space-y-1 rounded-lg border border-border bg-background/50 p-2">
                    <p className="flex items-center gap-1.5 text-[10px] font-medium text-foreground">
                      <Check size={11} className="text-green-400" />
                      生成済み
                      <span className="rounded bg-neon-violet/15 px-1 py-0.5 text-[9px] text-neon-violet">
                        {captionGen.fromGemini ? "AI 生成" : "簡易生成（オフライン）"}
                      </span>
                    </p>
                    <p className="max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted">
                      {captionGen.prompt}
                    </p>
                  </div>
                )}
                {captionGen.state === "error" && captionGen.error && (
                  <p className="text-[10px] text-amber-400">⚠️ {captionGen.error}</p>
                )}

                <details className="group">
                  <summary className="cursor-pointer text-[10px] text-muted transition-colors hover:text-foreground">
                    詳細: 英語キャプション指示を直接指定する（上級者向け）
                  </summary>
                  <div className="mt-1.5 space-y-1">
                    <textarea
                      value={captionPromptOverride}
                      onChange={(e) => setCaptionPromptOverride(e.target.value)}
                      rows={4}
                      disabled={busy}
                      placeholder="空欄 = 上記から自動生成。ここに英語で書くと自動生成を上書きします。"
                      className={`${fieldCls} resize-y font-mono text-[10px] leading-relaxed`}
                    />
                    {captionPromptOverride.trim() && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setCaptionPromptOverride("")}
                        className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/60 px-2 py-1 text-[10px] text-muted transition-colors hover:text-foreground disabled:opacity-50"
                      >
                        <RotateCcw size={10} />
                        自動生成に戻す
                      </button>
                    )}
                  </div>
                </details>

                {/* 再解析はここに置く（2026-09-22、ホスト指摘）。押す理由は
                    「この欄の設定を変えたから」しかないので、解析完了バッジの
                    横にあると誤爆するだけで、なぜそこにあるのかも分からない。 */}
                {aiCaptionedCount > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-neon-violet/20 pt-2">
                    <button
                      type="button"
                      disabled={busy || autoCap.running}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `この設定で ${aiCaptionedCount} 枚のキャプションを作り直します。数分かかります。よろしいですか？`,
                          )
                        )
                          return;
                        void recaptionAll();
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-neon-violet/40 bg-neon-violet/10 px-2 py-1 text-[10px] font-medium text-neon-violet transition-colors hover:bg-neon-violet/20 disabled:opacity-50"
                    >
                      <RotateCcw size={10} />
                      この設定でキャプションを作り直す（{aiCaptionedCount} 枚）
                    </button>
                    <span className="text-[10px] text-muted">
                      上の設定を変えたときだけ押してください。数分かかります。
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 画像を取り込む前は rank / ステップ数の欄を出さない（2026-09-21、
              ホスト指摘）。推奨値は枚数とカテゴリから決まるので、素材が無い
              段階で数字だけ並べても迷わせるだけ。 */}
          {images.length > 0 && (
            <div
              id={LORA_SETTINGS_ANCHOR_ID}
              className="space-y-3 scroll-mt-24 rounded-xl border border-neon-pink/30 bg-neon-pink/5 p-3"
            >
              {/* オートモード廃止後の説明（2026-09-22）。モード選択が無くなった
                  ので、ここが「自動で決まった値」であることを明示する。 */}
              <p className="text-[11px] leading-relaxed text-muted">
                <strong className="text-foreground">学習設定は取り込んだ画像から自動で決まっています。</strong>
                このままで問題ありません。変えたい場合だけ触ってください。
              </p>
              {isAdmin ? (
                <label className="flex items-center gap-2 text-[11px] font-medium text-neon-pink">
                  <input
                    type="checkbox"
                    checked={pro.useRawYaml}
                    onChange={(e) => updatePro({ useRawYaml: e.target.checked })}
                    disabled={busy}
                    className="h-3.5 w-3.5 accent-neon-pink"
                  />
                  生 YAML を直接編集（学習ジョブ設定）
                  <span className="rounded bg-neon-pink/15 px-1 py-0.5 text-[9px] font-semibold text-neon-pink">
                    ADMIN
                  </span>
                </label>
              ) : adminLoading ? (
                <p className="flex items-center gap-1.5 text-[10px] text-muted">
                  <Loader2 size={11} className="animate-spin" />
                  権限を確認中…
                </p>
              ) : (
                <YamlVipLockCard />
              )}

              {yamlMode ? (
                <>
                  <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug font-medium text-amber-400">
                    ⚠️ [Pro Custom YAML] パラメータ不正や非互換オプションによる学習失敗時、消費されたクレジットは返金されません（自己責任）。
                  </p>
                  <textarea
                    value={pro.rawYaml}
                    onChange={(e) => updatePro({ rawYaml: e.target.value })}
                    rows={12}
                    disabled={busy}
                    placeholder={"job: extension\nconfig:\n  name: my_lora\n  process:\n    - type: sd_trainer\n      ..."}
                    className={`${fieldCls} resize-y font-mono text-[11px]`}
                  />
                  {/* Live YAML syntax + schema validation */}
                  {yamlCheck && !yamlCheck.ok ? (
                    yamlCheck.errors && yamlCheck.errors.length > 0 ? (
                      <div className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] font-medium text-red-400">
                        {yamlCheck.errors.map((e, i) => (
                          <p key={i}>{e}</p>
                        ))}
                      </div>
                    ) : (
                      <p className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] font-medium text-red-400">
                        ❌ YAMLエラー
                        {yamlCheck.line != null
                          ? ` [行 ${yamlCheck.line}${yamlCheck.column != null ? `, 列 ${yamlCheck.column}` : ""}]`
                          : ""}
                        : {yamlCheck.message}
                      </p>
                    )
                  ) : yamlCheck && yamlCheck.ok ? (
                    <>
                      <p className="text-[10px] font-medium text-green-400">✅ YAML構文正常（有効な設定）</p>
                      {yamlCheck.warnings.map((w, i) => (
                        <p key={i} className="text-[10px] text-amber-400">
                          ⚠️ {w}
                        </p>
                      ))}
                    </>
                  ) : null}
                  <p className="text-[10px] leading-relaxed text-muted">
                    {priceBreakdown && priceBreakdown.steps > 0
                      ? `${loraPriceMultiplierSummary(priceBreakdown)} → 消費 ${requiredCredits} C`
                      : `steps / パラメータを解析できません → 安全側で上限 ${requiredCredits} C を適用`}
                  </p>
                </>
              ) : (
                <div className="space-y-3">
                  {/* Rank — discrete choices only */}
                  <div>
                    <label className="mb-1 block text-[10px] text-muted">Rank（LoRA の表現力）</label>
                    <div className="flex flex-wrap gap-1.5">
                      {RANK_OPTIONS.map((r) => (
                        <button
                          key={r}
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            updatePro({
                              rank: r,
                              alpha: (effPro.alphaLinked ?? true) ? r : effPro.alpha,
                            })
                          }
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                            effPro.rank === r
                              ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                              : "border-border bg-background/60 text-muted hover:border-neon-violet/40"
                          }`}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Alpha — auto-linked to Rank by default */}
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[10px] text-muted">
                      <span>Alpha（学習の効き）</span>
                      <label className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={alphaLinked}
                          onChange={(e) =>
                            updatePro({
                              alphaLinked: e.target.checked,
                              alpha: e.target.checked ? effPro.rank : effPro.alpha,
                            })
                          }
                          disabled={busy}
                          className="h-3 w-3 accent-neon-pink"
                        />
                        Rank に自動連動
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {ALPHA_OPTIONS.map((a) => (
                        <button
                          key={a}
                          type="button"
                          disabled={busy || alphaLinked}
                          onClick={() => updatePro({ alpha: a, alphaLinked: false })}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
                            effectiveAlpha === a
                              ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                              : "border-border bg-background/60 text-muted hover:border-neon-violet/40"
                          }`}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Steps — slider + clamped number input + quick picks */}
                  <div>
                    <label className="mb-1 block text-[10px] text-muted">Steps（学習ステップ数）</label>
                    <div className="flex w-full items-center gap-2">
                      <input
                        type="range"
                        min={STEPS_MIN}
                        max={STEPS_MAX}
                        step={STEPS_STEP}
                        value={effPro.steps}
                        onChange={(e) => updatePro({ steps: Number(e.target.value) })}
                        disabled={busy}
                        className="h-1.5 min-w-0 flex-1 accent-neon-pink"
                      />
                      <input
                        type="number"
                        min={STEPS_MIN}
                        max={STEPS_MAX}
                        step={STEPS_STEP}
                        value={effPro.steps}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          updatePro({
                            steps: Number.isFinite(v)
                              ? Math.min(STEPS_MAX, Math.max(STEPS_MIN, Math.round(v)))
                              : effPro.steps,
                          });
                        }}
                        disabled={busy}
                        className="w-20 shrink-0 rounded-lg border border-border bg-background px-2 py-2 text-sm tabular-nums outline-none transition-colors focus:border-neon-violet/50"
                      />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {STEPS_QUICK.map((s) => (
                        <button
                          key={s.value}
                          type="button"
                          disabled={busy}
                          onClick={() => updatePro({ steps: s.value })}
                          className={`rounded-lg border px-2.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                            effPro.steps === s.value
                              ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                              : "border-border bg-background/60 text-muted hover:border-neon-violet/40"
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Learning Rate — safe presets, free entry only on カスタム。
                      Prodigy は学習率フリー（内部で自己推定する）ため、この
                      値は使われない（サーバー側で強制的に1.0扱いになる）。 */}
                  <div>
                    <label className="mb-1 block text-[10px] text-muted">Learning Rate</label>
                    {effPro.optimizer === "prodigy" ? (
                      <p className="rounded-lg border border-border bg-background/60 px-3 py-2 text-[10px] leading-relaxed text-muted">
                        Prodigy は学習率を自動推定するため、この設定は使用されません。
                      </p>
                    ) : (
                      <>
                        <select
                          value={effPro.lrCustom ? "custom" : String(effPro.learningRate)}
                          onChange={(e) => {
                            if (e.target.value === "custom") {
                              updatePro({ lrCustom: true });
                            } else {
                              updatePro({ lrCustom: false, learningRate: Number(e.target.value) });
                            }
                          }}
                          disabled={busy}
                          className={fieldCls}
                        >
                          {LR_PRESETS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                          <option value="custom">カスタム（手動入力）</option>
                        </select>
                        {effPro.lrCustom && (
                          <input
                            type="number"
                            step="0.00001"
                            min={0}
                            value={effPro.learningRate}
                            onChange={(e) =>
                              updatePro({ learningRate: Number(e.target.value) || effPro.learningRate })
                            }
                            disabled={busy}
                            placeholder="0.0001"
                            className={`${fieldCls} mt-1.5`}
                          />
                        )}
                      </>
                    )}
                  </div>

                  {/* Optimizer */}
                  <div>
                    <label className="mb-1 block text-[10px] text-muted">Optimizer</label>
                    <select
                      value={effPro.optimizer}
                      onChange={(e) => updatePro({ optimizer: e.target.value })}
                      disabled={busy}
                      className={fieldCls}
                    >
                      {OPTIMIZERS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Credits — parameter-linked dynamic price. Hidden the instant a
              job is being submitted so a post-charge re-render can't flash a
              stale "insufficient" state over the launching job. */}
          {!submitting && (
            <div className="rounded-lg border border-border bg-background/60 px-3 py-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-neon-pink">
                  <Zap size={13} />
                  {requiredCredits} Credits
                </span>
                <span className="text-muted">保有: {creditsLoading ? "…" : (credits ?? 0)}</span>
              </div>
              {priceBreakdown && priceBreakdown.steps > 0 && (
                <p className="mt-1 text-[10px] leading-relaxed text-muted">
                  {loraPriceMultiplierSummary(priceBreakdown)}
                </p>
              )}
            </div>
          )}
          {insufficientCredits && !submitting && (
            <a
              href="#pricing"
              className="flex items-center justify-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-400"
            >
              <Zap size={13} />
              クレジットが不足しています — チャージする
            </a>
          )}

          {heavyConfigWarn && phase === "form" && !submitting && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-400">
              ⚠️ [警告]
              1280px高解像度かつ100枚超の設定は、準備処理（3D VAEエンコード）に莫大な時間を要し、コンテナが途中で早期安全停止される可能性が極めて高いです。解像度を最大1024pxに下げるか、画像枚数を減らすことを強く推奨します。
            </p>
          )}

          {/* Action — this render only runs for phase === "form" (starting /
              tracking / curation all early-return above). */}
          <div className="space-y-3">
            {errorMessage && (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {errorMessage}
              </p>
            )}
            <button
              type="button"
              onClick={handleStart}
              disabled={
                submitting ||
                Boolean(inFlightJob) ||
                (Boolean(user) && !insufficientCredits && !canSubmit) ||
                captionGen.state === "generating" ||
                (Boolean(user) && autoCap.running) ||
                (Boolean(user) && !insufficientCredits && needsIdentityConfirm)
              }
              className={`flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50${flowRing("submit")}`}
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {/* 確認画面へ進むだけの時に「学習ジョブを起動中」と出すのは嘘
                      （2026-09-22、ホスト指摘）。特徴が変わっていると、ここで
                      キャプションを全部作り直すので数分かかる。何をしているかを
                      出す。 */}
                  {/* 何をしているのか、なぜ待たされるのかを書く（2026-09-22、
                      ホスト指摘）。ここで作り直しが走るのは「学習したい特徴」
                      など、キャプションの作り方が変わったときだけ。 */}
                  {curationEnabled
                    ? autoCap.running
                      ? `学習したい特徴が変わったので、キャプションを作り直しています… ${autoCap.done}/${autoCap.total}`
                      : "データセットを準備しています…（学習はまだ始まりません）"
                    : "🚀 学習ジョブを起動中…"}
                </>
              ) : inFlightJob ? (
                <>
                  <AlertTriangle size={16} />
                  ⚠️ 別の学習が進行中です
                </>
              ) : !user ? (
                <>
                  <LogIn size={16} />
                  ログインして学習を開始
                </>
              ) : insufficientCredits ? (
                <>
                  <Zap size={16} />
                  クレジットをチャージ
                </>
              ) : autoCap.running ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  AIキャプションを解析中…（完了までお待ちください）
                </>
              ) : captionGen.state === "generating" ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  キャプションプロンプトを生成中…
                </>
              ) : needsIdentityConfirm ? (
                <>
                  <AlertTriangle size={16} />
                  埋め込むタグを確認してください
                </>
              ) : curationEnabled ? (
                <>
                  <Wand2 size={16} />
                  次へ：データセットを確認・編集する
                </>
              ) : (
                <>
                  <Wand2 size={16} />
                  {`🔥 高速 LoRA 学習を開始する (${requiredCredits} C)`}
                </>
              )}
            </button>
            {inFlightJob ? (
              // Two physical barriers against a double submit: the button
              // above is disabled, and this is the only live action here.
              <button
                type="button"
                onClick={() => setPhase("tracking")}
                className="flex w-full items-center justify-center gap-1.5 text-[11px] font-medium text-neon-violet hover:underline"
              >
                進行状況を確認する →
              </button>
            ) : (
              <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted">
                <Sparkles size={13} className="mt-0.5 shrink-0 text-neon-violet" />
                独自の高精度パイプラインで自動キャプション ➔
                深度最適化学習を完全自動で実行。完了したLoRAは即座にダウンロードしてご利用いただけます。
              </p>
            )}
          </div>
        </div>
      </div>

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        message="LoRA Studio でキャラクター学習を行うにはログインしてください。"
      />
    </div>
  );
}
