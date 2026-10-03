"use client";

// 素材づくり（2026-09-27、ホスト構想）: 1 枚の画像（＋参照最大 3 枚）から、ポーズ・場面・構図・向きを
// 変えた画像を指定枚数つくり、選んで LoRA Studio へ送る。マルチアングルと同じワーカー・同じ課金。
// 8 枚ずつのジョブに分けて順に投げ、最初の 1 ジョブで方向を確認してから残りを作る（既定）。
// 生成した画像は次の参照に使わない（ユーザーが選んだ参照だけを毎回使う）ので、ずれが連鎖しない。
//
// CLAUDE.md §6 のチェックリスト: ジョブはリロードで消えない（RUN_KEY）／「見つからない」は専用エラー／
// VramBadge／起動待ち表示／結果 URL は使い回さない（fresh URL で取り直し）／サムネは切り抜かない。

import { HelpNote } from "./HelpNote";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { zipLocalDate } from "@/lib/zipDate";
import { Check, ChevronDown, ChevronRight, Download, ImagePlus, Loader2, Sparkles, Wand2, X, Zap, ZoomIn } from "lucide-react";
import { MAX_SUB_REFERENCE_IMAGES } from "@/lib/angleStudio";
import {
  AngleJobNotFoundError,
  fetchAngleImageBlob,
  freshAngleImageUrl,
  listAngleJobs,
  pollAngleJob,
  startAngleJob,
  type AngleApiError,
  type AngleJob,
} from "@/lib/angleApi";
import {
  buildScenePlan,
  rebodyScenePlan,
  CHIPS_BY_AXIS,
  checkBatchCount,
  closeMainIndexFor,
  sceneItemUsesCloseSource,
  orderPlanForBatches,
  planBatches,
  sceneItemCredits,
  sceneItemGroup,
  sceneItemUsesFaceRef,
  scenePlanCredits,
  type CloseFraming,
  type CloseMainMap,
  DEFAULT_SCENE_SELECTION,
  SCENE_BATCH_SIZE,
  SCENE_DEFAULT_COUNT,
  SCENE_MAX_COUNT,
  SCENE_REST_BATCH_SIZE,
  LEGACY_SCENE_REST_BATCH_SIZE,
  sceneCreditsPerImage,
  scenePlanInstruction,
  scenePlanLabel,
  scenePlanPreviewJa,
  type SceneAxis,
  type SceneBatchOptions,
  type ScenePlanItem,
  type SceneSelection,
  DEFAULT_SCENE_RATIOS,
  effectiveRatios,
  EMPTY_BODY_DESIGN,
  bodyDesignBlockedReason,
  bodyDesignSpecs,
  mainRouteOf,
  bodyDesignSentence,
  sceneNegativePrompt,
  type SourceStyle,
  type BodyDesign,
  type MainRoute,
} from "@/lib/datasetBuilder";
import { BodyDesignForm } from "@/components/studio/BodyDesignForm";
import GenerationCaveat from "@/components/studio/GenerationCaveat";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { loadFormState, saveFormState, studioFormStorageKey } from "@/lib/studioFormPersistence";
import { requestStudioHandoff, sendLoraAdditions, takeStudioBatchHandoff } from "@/lib/studioHandoff";
import { VramBadge } from "@/components/studio/VramBadge";
import {
  AngleLightbox,
  ImageDropzone,
  InsufficientCreditsModal,
  SubReferenceSlots,
  useObjectUrl,
  type LightItem,
} from "@/components/studio/MultiAngleStudioTab";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useElapsedTimer, formatElapsedSeconds } from "@/hooks/useElapsedTimer";
import { useLocalWarmCountdown } from "@/hooks/useLocalWarmCountdown";
import { deriveFramingSources, type FramingSources } from "@/lib/smartCrop";
import { fileStoreClear, fileStoreGet, fileStorePut } from "@/lib/fileStore";
import {
  backViewSpecs,
  CandidatePanel,
  createGpuLock,
  DIAG_FACE_SPECS,
  FULL_BODY_SPECS,
  sideViewSpecs,
  type CandidatePick,
} from "@/components/studio/DatasetRefBuilder";
import { WarmCountdownBanner } from "@/components/studio/QueueChoiceModal";
import { RestorePrompt } from "@/components/studio/RestorePrompt";

const FORM_ID = "dataset-builder";
const RUN_KEY = "dataset-builder-run";
// 画像（メイン・参照・基準の全身）は IndexedDB に保存してリロード後に戻す（2026-09-28）。
const FILES_PREFIX = "dataset-builder:";
const FILES_META_KEY = "dataset-builder-files";
type FilesMeta = { subCount: number; backIndex: number | null; sideIndex: number | null; hasBaseFull: boolean; hasDiag?: boolean };
const POLL_MS = 2_000;

type SideFaceChoice = "auto" | "none" | "orig" | "bust" | number;

/** 真横の候補に添える顔の画像をサムネから選ぶ（2026-09-29）。選ばれた File に枠を付ける。 */
function SideFacePicker({
  options,
  selected,
  onSelect,
  costWith,
  costWithout,
}: {
  options: { key: Exclude<SideFaceChoice, "auto">; label: string; file: File | null }[];
  selected: File | null;
  onSelect: (key: Exclude<SideFaceChoice, "auto">) => void;
  costWith: number;
  costWithout: number;
}) {
  if (options.length <= 1) return null;
  return (
    <div className="space-y-1">
      <p className="text-[10px] text-muted">
        <span className="font-medium text-foreground">横顔を寄せるために添える画像</span>
        （任意。顔が大きく写った画像を添えると横顔が似やすくなります・4 枚 {costWith} C／添えないと {costWithout} C）
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = o.file === null ? selected === null : selected === o.file;
          return (
            <button
              key={String(o.key)}
              type="button"
              onClick={() => onSelect(o.key)}
              title={o.label}
              className={`flex w-20 flex-col items-center gap-0.5 rounded-md border-2 p-0.5 text-[9px] leading-tight ${
                on ? "border-neon-pink text-foreground" : "border-transparent text-muted hover:border-border"
              }`}
            >
              {o.file ? <FileThumb file={o.file} /> : <span className="flex h-16 w-full items-center justify-center rounded bg-black/20">なし</span>}
              <span className="line-clamp-2 text-center">{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FileThumb({ file }: { file: File }) {
  const url = useObjectUrl(file);
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className="h-16 w-full rounded bg-black/40 object-contain" />
  ) : (
    <span className="h-16 w-full rounded bg-black/20" />
  );
}

type PersistedForm = {
  sel: SceneSelection;
  count: number;
  confirmFirst: boolean;
  /** 体の設計（顔アップ→全身、2026-09-29）。 */
  body?: BodyDesign;
  routeOverride?: MainRoute | "auto";
  /** 取り込んだメイン画像の写り方（基準の全身を選んだ後は再判定できないので覚えておく）。 */
  mainFraming?: string;
  /** 顔アップの元画像も LoRA へ送るか（既定 true）。 */
  sendOriginal?: boolean;
  /** 後ろ髪の指定（任意・日本語可、真横・後ろ姿の候補に使う）。 */
  hairNote?: string;
  /** 作り方（2026-09-29）: careful＝基準の全身像・真横・後ろ姿を先に作る（既定）／quick＝顔アップのまますぐ作る。 */
  precision?: "careful" | "quick";
  /**
   * 真横の候補に添える顔の画像（2026-09-29）。auto＝元の画像（顔アップ・上半身から始めたとき）／切り出したバストアップ
   * （全身から始めたとき）、none＝添えない、orig＝元の画像、bust＝切り出したバストアップ、数値＝参照欄の N 番目。
   */
  sideFaceChoice?: SideFaceChoice;
  /** 全身から始めたとき体つきを調整するか（2026-09-29）。 */
  adjustBody?: boolean;
  /** 元画像の画風（2026-09-30）。実写ならアニメ・イラスト調をネガティブに入れる。 */
  sourceStyle?: SourceStyle;
};
/** 進行中／完了した「1 回の指定」。File は保存できないので、リロード後は結果の表示と LoRA への送りだけできる。 */
type PersistedRun = {
  plan: ScenePlanItem[];
  /** 投げた順のジョブ id（plan を SCENE_BATCH_SIZE ずつ）。 */
  jobIds: string[];
  /** 最初の 1 ジョブで止めて確認するか。 */
  confirmFirst: boolean;
  /** 「続きを作る」を押した後 true。 */
  confirmed: boolean;
  subCount: number;
  /** 構図ごとの「寄りの元画像」（参照の何番目か）。無ければメイン画像で作る。 */
  closeMain: CloseMainMap;
  /** メイン画像から自動で切り出した寄りの元を使う構図（リロード後は切り出し直す）。 */
  derived: Partial<Record<CloseFraming, boolean>>;
  /** 「最初に確認する行」の数（plan の先頭からこの数）。ここまでのジョブが終わったら止まって確認する。 */
  prefixLen: number;
  /** 後ろ姿・真横の参照が確定していたか（行ごとの参照枚数＝料金の計算に使う）。 */
  hasBackRef: boolean;
  hasSideRef: boolean;
  /** 斜めの顔の参照が確定していたか（斜めの行に付ける。2026-09-30）。 */
  hasDiagRef?: boolean;
  /** 寄りの行（後ろ以外）に元の顔アップを添えるか（構図ごと。2026-09-30）。 */
  faceRefFor?: Partial<Record<CloseFraming, boolean>>;
  /**
   * 送信中の印（2026-10-03）。送信を始めた時刻と枚数。返事（ジョブ id）を受け取る前にタブを閉じると、サーバーには
   * ジョブができて課金済みなのに jobIds に入らず、結果が出なくなっていた（録画中に実際に踏んだ）。開き直したとき、
   * この時刻以降にできた同じ枚数のジョブを拾い直す。
   */
  pendingSince?: number;
  pendingTotal?: number;
  /** 確認の後のジョブの区切り（2026-10-03〜。無い＝それ以前の実行で 16）。 */
  restBatchSize?: number;
};

/** run の行ごとの参照・切り出しの設定（料金・バッチ分けに使う）。 */
function runBatchOpt(r: PersistedRun): SceneBatchOptions {
  return {
    subCount: r.subCount,
    closeMain: r.closeMain,
    derived: r.derived,
    hasBackRef: r.hasBackRef,
    hasSideRef: r.hasSideRef,
    hasDiagRef: Boolean(r.hasDiagRef),
    faceRefFor: r.faceRefFor ?? {},
    restSize: r.restBatchSize ?? LEGACY_SCENE_REST_BATCH_SIZE,
  };
}

type Phase = "idle" | "review" | "submitting" | "running" | "paused" | "done" | "error";

const AXIS_TITLE: Record<SceneAxis, string> = {
  poses: "ポーズ",
  places: "場面",
  framings: "構図",
  views: "向き",
  expressions: "表情",
  outfits: "服装",
};

function ChipGroup({
  axis,
  selected,
  onToggle,
  onAll,
  onClear,
  custom,
  onAddCustom,
  onRemoveCustom,
  ratios,
  onRatio,
  onResetRatios,
}: {
  axis: SceneAxis;
  selected: string[];
  onToggle: (id: string) => void;
  onAll: () => void;
  onClear: () => void;
  /** 自分で足した項目（ポーズ・場面だけ）。日本語で書ける。 */
  custom?: string[];
  onAddCustom?: (text: string) => void;
  onRemoveCustom?: (text: string) => void;
  /** 構図・向きだけ: チップの比率（%、空欄＝残りを均等に）。 */
  ratios?: Record<string, number>;
  onRatio?: (id: string, pct: number) => void;
  onResetRatios?: () => void;
}) {
  const set = new Set(selected);
  const chosen = CHIPS_BY_AXIS[axis].filter((c) => set.has(c.id));
  const eff = ratios ? effectiveRatios(chosen, ratios) : [];
  const [draft, setDraft] = useState("");
  const commitDraft = () => {
    const t = draft.trim();
    if (!t || !onAddCustom) return;
    onAddCustom(t);
    setDraft("");
  };
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-xs font-medium text-muted">{AXIS_TITLE[axis]}</p>
        <span className="flex gap-2 text-[10px] text-muted">
          <button type="button" onClick={onAll} className="hover:text-foreground">
            全部
          </button>
          <button type="button" onClick={onClear} className="hover:text-foreground">
            解除
          </button>
          {onResetRatios && (
            <button type="button" onClick={onResetRatios} className="hover:text-foreground" title="比率を既定に戻す">
              比率を既定に
            </button>
          )}
        </span>
      </div>
      {onRatio && chosen.length > 1 && (
        <p className="mb-1 text-[10px] text-muted/80">
          実際の割合: {chosen.map((c, i) => `${c.label} ${Math.round(eff[i] * 100)}%`).join("・")}
          （合計が 100% でなくても比で割り振ります）
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {CHIPS_BY_AXIS[axis].map((c) => (
          <span key={c.id} className="inline-flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => onToggle(c.id)}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                set.has(c.id)
                  ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                  : "border-border bg-background text-muted hover:border-neon-violet/40 hover:text-foreground"
              }`}
            >
              {c.label}
            </button>
            {onRatio && set.has(c.id) && (
              <span className="inline-flex items-center text-[10px] text-muted">
                <input
                  type="number"
                  min={0}
                  max={100}
                  inputMode="numeric"
                  value={ratios?.[c.id] ? String(ratios[c.id]) : ""}
                  onChange={(e) => onRatio(c.id, Math.max(0, Math.min(100, Math.trunc(Number(e.target.value) || 0))))}
                  placeholder="自動"
                  aria-label={`${c.label}の比率（%、空欄で残りを均等に）`}
                  title="比率（%）。空欄なら 100% の残りを均等に分けます"
                  className="w-10 rounded border border-border bg-surface px-1 py-0.5 text-center text-[11px] text-foreground placeholder:text-muted/50"
                />
                %
              </span>
            )}
          </span>
        ))}
        {custom?.map((t) => (
          <span
            key={`custom:${t}`}
            className="inline-flex items-center gap-1 rounded-full border border-neon-violet/50 bg-neon-violet/10 px-2.5 py-1 text-[11px] text-neon-violet"
          >
            {t}
            <button type="button" onClick={() => onRemoveCustom?.(t)} aria-label="削除" className="hover:text-foreground">
              ×
            </button>
          </span>
        ))}
      </div>
      {onAddCustom && (
        <div className="mt-1.5 flex gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commitDraft();
              }
            }}
            placeholder={axis === "places" ? "場面を追加（日本語OK・例: 桜並木の下）" : "ポーズを追加（日本語OK・例: 傘をさして立つ）"}
            className="flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-[11px] text-foreground"
          />
          <button
            type="button"
            onClick={commitDraft}
            disabled={!draft.trim()}
            className="rounded-lg border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-40"
          >
            追加
          </button>
        </div>
      )}
    </div>
  );
}

export function DatasetBuilderTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs } = usePricingKnobs();

  const savedForm = useMemo(() => loadFormState<PersistedForm>(FORM_ID), []);
  const [image, setImageState] = useState<File | null>(null);
  const imagePreview = useObjectUrl(image);
  const [imageError, setImageError] = useState<string | null>(null);
  const [subImages, setSubImagesState] = useState<File[]>([]);
  // ポーリングの長寿命な effect から「今の画像」を読むための ref。setter を包んで state と同時に更新する。
  const imageRef = useRef<File | null>(null);
  const subImagesRef = useRef<File[]>([]);
  const setImage = useCallback((f: File | null) => {
    imageRef.current = f;
    setImageState(f);
  }, []);
  const setSubImages = useCallback((upd: File[] | ((prev: File[]) => File[])) => {
    const next = typeof upd === "function" ? upd(subImagesRef.current) : upd;
    subImagesRef.current = next;
    setSubImagesState(next);
  }, []);
  const [subError, setSubError] = useState<string | null>(null);
  // 上半身・バストアップの行の元にする参照（index）。文章では寄りにならないので、寄った画像を元にする（2026-09-27）。
  // 構図ごとの元画像の選び方: "auto"＝メインから自動で切り出し（既定）／"main"＝メインのまま／number＝参照 N。
  const [closeChoice, setCloseChoice] = useState<Record<CloseFraming, "auto" | "main" | number>>({ upper: "auto", bust: "auto" });
  const [derived, setDerived] = useState<FramingSources>({});
  // 取り込んだメイン画像そのものの写り方（derived は基準の全身を選ぶとそちらの判定になる）。経路の判定に使う。
  const [mainFraming, setMainFraming] = useState<string | undefined>(() => savedForm?.mainFraming);
  const [deriving, setDeriving] = useState(false);
  // 基準の全身（元が寄っているとき、候補から選んだ 1 枚）。以後の「メインだけ」の行と切り出しの元になる。
  const [baseFull, setBaseFull] = useState<File | null>(null);
  // 作り方（2026-09-29）: careful＝こだわり（既定）／quick＝かんたん。かんたんでは基準の全身像を使わない
  // （確定済みでも無視してメイン画像のまま作る）。
  const [precision, setPrecision] = useState<"careful" | "quick">(() => savedForm?.precision ?? "careful");
  const activeBaseFull = precision === "careful" ? baseFull : null;
  const effectiveMain = activeBaseFull ?? image;
  const effectiveMainRef = useRef<File | null>(null);
  const derivedRef = useRef<FramingSources>({});
  // タブ内の GPU ジョブは 1 本ずつ（候補づくり・本生成が同時に走ってコンテナが 2 台立たないように）。
  const [gpuLock] = useState(() => createGpuLock());
  const gpuReleaseRef = useRef<(() => void) | null>(null);
  const derivedUpperUrl = useObjectUrl(derived.upper ?? null);
  const derivedBustUrl = useObjectUrl(derived.bust ?? null);
  // メイン画像が変わったら、上半身・バストアップの元画像を自動で切り出す（無料・ブラウザ内）。
  useEffect(() => {
    let alive = true;
    effectiveMainRef.current = effectiveMain;
    if (!effectiveMain) {
      derivedRef.current = {};
      queueMicrotask(() => setDerived({}));
      return;
    }
    // effect 本体では同期 setState しない（react-hooks/set-state-in-effect）。
    queueMicrotask(() => setDeriving(true));
    const isOriginal = effectiveMain === image;
    deriveFramingSources(effectiveMain)
      .then((src) => {
        if (!alive) return;
        derivedRef.current = src;
        setDerived(src);
        if (isOriginal) setMainFraming(src.framing);
      })
      .finally(() => {
        if (alive) setDeriving(false);
      });
    return () => {
      alive = false;
    };
  }, [effectiveMain, image]);
  // 参照づくりの選択（候補ジョブと index）。File はリロードで消えるので、パネル側が候補から取り直す。
  const PICKS_KEY = "dataset-builder-picks";
  type Picks = { full?: CandidatePick | null; back?: CandidatePick | null; side?: CandidatePick | null; diag?: CandidatePick | null };
  const [picks, setPicks] = useState<Picks>(() => loadFormState<Picks>(PICKS_KEY) ?? {});
  useEffect(() => {
    saveFormState(PICKS_KEY, picks);
  }, [picks]);
  const [refBack, setRefBack] = useState<File | null>(null);
  const [refSide, setRefSide] = useState<File | null>(null);
  // 斜めの顔の参照（2026-09-30）。参照欄（最大 3 枠）とは別に持つ（真横・後ろ姿・手持ちの参照と枠を取り合わないため）。
  const [refDiag, setRefDiag] = useState<File | null>(null);
  // submitBatch（useCallback）から今の参照を読むための ref。
  const refBackRef = useRef<File | null>(null);
  const refSideRef = useRef<File | null>(null);
  const refDiagRef = useRef<File | null>(null);
  // 寄りの行に添える顔アップ（下の faceRefFile）。submitBatch から読む。
  const faceRefFileRef = useRef<File | null>(null);
  useEffect(() => {
    refBackRef.current = refBack;
    refSideRef.current = refSide;
    refDiagRef.current = refDiag;
  }, [refBack, refSide, refDiag]);
  // 選んだ参照は参照欄に入れる（真横・後ろの行で使われる）。差し替えは前の分を外す。
  const putRef = useCallback(
    (prev: File | null, next: File) => {
      setSubImages((cur) => {
        const without = cur.filter((f) => f !== prev);
        return [...without, next].slice(-MAX_SUB_REFERENCE_IMAGES);
      });
    },
    [setSubImages],
  );
  // 参照欄から消したら確定も解除する（2026-09-27、ホスト指摘「消しても確定のまま」）。確定＝参照欄にある、を保つ。
  useEffect(() => {
    if (refBack && !subImages.includes(refBack)) {
      queueMicrotask(() => {
        setRefBack(null);
        setPicks((p) => ({ ...p, back: null }));
      });
    }
    if (refSide && !subImages.includes(refSide)) {
      queueMicrotask(() => {
        setRefSide(null);
        setPicks((p) => ({ ...p, side: null }));
      });
    }
  }, [subImages, refBack, refSide]);
  // --- 画像の保存と復元（リロード対策）------------------------------------------------
  // 黙って復元せず「前回の続きを復元しますか？」で選ばせる（2026-09-28、ホスト指摘。LoRA Studio と同じ聞き方）。
  const restoredFilesRef = useRef(false);
  const restoringRef = useRef(false);
  const [restorePending, setRestorePending] = useState<{
    main: File;
    subs: File[];
    base: File | null;
    diag: File | null;
    meta: FilesMeta;
  } | null>(null);
  useEffect(() => {
    if (restoredFilesRef.current) return;
    restoredFilesRef.current = true;
    // LoRA 等から受け取った直後（image が既にある）は復元しない。
    if (imageRef.current) return;
    const meta = loadFormState<FilesMeta>(FILES_META_KEY);
    if (!meta) return;
    restoringRef.current = true;
    (async () => {
      const main = await fileStoreGet(`${FILES_PREFIX}main`);
      if (!main || imageRef.current) {
        restoringRef.current = false;
        return;
      }
      const subs: File[] = [];
      for (let i = 0; i < (meta.subCount ?? 0); i++) {
        const f = await fileStoreGet(`${FILES_PREFIX}sub${i}`);
        if (f) subs.push(f);
      }
      const base = meta.hasBaseFull ? await fileStoreGet(`${FILES_PREFIX}baseFull`) : null;
      const diag = meta.hasDiag ? await fileStoreGet(`${FILES_PREFIX}diag`) : null;
      // 読めたら聞く。restoringRef は決めるまで立てたまま（保存を止める）。
      setRestorePending({ main, subs, base, diag, meta: meta as FilesMeta });
    })();
  }, [setImage, setSubImages]);
  const discardRestore = useCallback(() => {
    setRestorePending(null);
    restoringRef.current = false;
    try {
      window.localStorage.removeItem(studioFormStorageKey(FILES_META_KEY));
    } catch {
      /* storage disabled */
    }
    void fileStoreClear(FILES_PREFIX);
  }, []);
  const applyRestore = useCallback(() => {
    const p = restorePending;
    if (!p) return;
    setRestorePending(null);
    if (!imageRef.current) {
      setImage(p.main);
      setSubImages(p.subs);
      if (p.base) setBaseFull(p.base);
      if (p.meta.backIndex != null && p.subs[p.meta.backIndex]) setRefBack(p.subs[p.meta.backIndex]);
      if (p.meta.sideIndex != null && p.subs[p.meta.sideIndex]) setRefSide(p.subs[p.meta.sideIndex]);
      if (p.diag) setRefDiag(p.diag);
    }
    restoringRef.current = false;
  }, [restorePending, setImage, setSubImages]);
  // 聞いている間に画像が入った（ドロップ・LoRA からの受け取り）＝新しく始めた。前回分は消す。
  useEffect(() => {
    if (restorePending && image) queueMicrotask(discardRestore);
  }, [restorePending, image, discardRestore]);
  useEffect(() => {
    // 復元中と、何も入っていない状態では保存しない（空の状態で保存すると復元前に消してしまう）。
    if (!restoredFilesRef.current || restoringRef.current) return;
    if (!image && subImages.length === 0 && !baseFull) return;
    const meta: FilesMeta = {
      subCount: subImages.length,
      backIndex: refBack ? subImages.indexOf(refBack) : null,
      sideIndex: refSide ? subImages.indexOf(refSide) : null,
      hasBaseFull: Boolean(baseFull),
      hasDiag: Boolean(refDiag),
    };
    saveFormState(FILES_META_KEY, meta);
    void (async () => {
      await fileStorePut(`${FILES_PREFIX}main`, image);
      for (let i = 0; i < MAX_SUB_REFERENCE_IMAGES; i++) await fileStorePut(`${FILES_PREFIX}sub${i}`, subImages[i] ?? null);
      await fileStorePut(`${FILES_PREFIX}baseFull`, baseFull);
      await fileStorePut(`${FILES_PREFIX}diag`, refDiag);
    })();
  }, [image, subImages, baseFull, refBack, refSide, refDiag]);

  const closeMain = useMemo<CloseMainMap>(
    () => ({
      upper: typeof closeChoice.upper === "number" ? closeChoice.upper : null,
      bust: typeof closeChoice.bust === "number" ? closeChoice.bust : null,
    }),
    [closeChoice],
  );
  const derivedFlags = useMemo(
    () => ({
      upper: closeChoice.upper === "auto" && Boolean(derived.upper),
      bust: closeChoice.bust === "auto" && Boolean(derived.bust),
    }),
    [closeChoice, derived],
  );
  const [sel, setSel] = useState<SceneSelection>(() => ({ ...DEFAULT_SCENE_SELECTION, ...(savedForm?.sel ?? {}) }));
  const [count, setCount] = useState<number>(() => savedForm?.count ?? SCENE_DEFAULT_COUNT);
  const [confirmFirst, setConfirmFirst] = useState<boolean>(() => savedForm?.confirmFirst ?? true);
  // 服装の自由指定・追加の指示は「詳細設定 ▸」に畳む（2026-10-01 説明の整理、ホスト判断）。入力があれば開いて出す。
  const [sceneAdvancedOpen, setSceneAdvancedOpen] = useState(false);
  const [bodyDesign, setBodyDesign] = useState<BodyDesign>(() => ({ ...EMPTY_BODY_DESIGN, ...(savedForm?.body ?? {}) }));
  const [routeOverride, setRouteOverride] = useState<MainRoute | "auto">(() => savedForm?.routeOverride ?? "auto");
  const [sendOriginal, setSendOriginal] = useState<boolean>(() => savedForm?.sendOriginal ?? true);
  const [hairNote, setHairNote] = useState<string>(() => savedForm?.hairNote ?? "");
  const [sideFaceChoice, setSideFaceChoice] = useState<SideFaceChoice>(() => savedForm?.sideFaceChoice ?? "auto");
  const [adjustBody, setAdjustBody] = useState<boolean>(() => savedForm?.adjustBody ?? false);
  const [sourceStyle, setSourceStyle] = useState<SourceStyle>(() => savedForm?.sourceStyle ?? "auto");

  useEffect(() => {
    saveFormState(FORM_ID, {
      sel,
      count,
      confirmFirst,
      body: bodyDesign,
      routeOverride,
      mainFraming,
      sendOriginal,
      hairNote,
      precision,
      sideFaceChoice,
      adjustBody,
      sourceStyle,
    } satisfies PersistedForm);
  }, [sel, count, confirmFirst, bodyDesign, routeOverride, mainFraming, sendOriginal, hairNote, precision, sideFaceChoice, adjustBody, sourceStyle]);

  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // --- 1 回の指定（run）とジョブ ---------------------------------------------
  const [run, setRun] = useState<PersistedRun | null>(() => {
    const r = loadFormState<PersistedRun>(RUN_KEY);
    return r && Array.isArray(r.plan) && Array.isArray(r.jobIds) && r.plan.length > 0
      ? {
          plan: r.plan,
          jobIds: r.jobIds,
          confirmFirst: Boolean(r.confirmFirst),
          confirmed: Boolean(r.confirmed),
          subCount: Number(r.subCount ?? 0),
          closeMain: r.closeMain && typeof r.closeMain === "object" ? r.closeMain : {},
          derived: r.derived && typeof r.derived === "object" ? r.derived : {},
          prefixLen: typeof r.prefixLen === "number" ? r.prefixLen : 8,
          hasBackRef: Boolean(r.hasBackRef),
          hasSideRef: Boolean(r.hasSideRef),
          hasDiagRef: Boolean(r.hasDiagRef),
          faceRefFor: r.faceRefFor && typeof r.faceRefFor === "object" ? r.faceRefFor : {},
          ...(typeof r.pendingSince === "number" ? { pendingSince: r.pendingSince, pendingTotal: Number(r.pendingTotal ?? 0) } : {}),
          restBatchSize: typeof r.restBatchSize === "number" ? r.restBatchSize : LEGACY_SCENE_REST_BATCH_SIZE,
        }
      : null;
  });
  const runRef = useRef<PersistedRun | null>(run);
  const commitRun = useCallback((next: PersistedRun | null) => {
    runRef.current = next;
    setRun(next);
    // 完了・失敗でも消さない（リロードで結果を出し直すため）。新しい指定で上書きされる。
    saveFormState(RUN_KEY, next ?? { plan: [], jobIds: [] });
  }, []);
  const [jobs, setJobs] = useState<Record<string, AngleJob>>({});
  const [phase, setPhase] = useState<Phase>(() => (run && run.jobIds.length > 0 ? "running" : "idle"));
  const elapsedMs = useElapsedTimer(phase === "running" || phase === "submitting");

  // 送信中に閉じた分を拾い直す（PersistedRun.pendingSince）。送信を始めた時刻以降にできた、同じ枚数で未登録のジョブを
  // 古い順に 1 件。見つからなければ数回取り直し、それでも無ければ送信前に閉じた（ジョブも課金も無い）として印を消す。
  useEffect(() => {
    const r0 = runRef.current;
    if (!user || !r0?.pendingSince) return;
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 6 && !cancelled; attempt++) {
        const r = runRef.current;
        if (!r?.pendingSince) return;
        const since = r.pendingSince - 10_000;
        const jobs = await listAngleJobs();
        const hit = jobs
          .filter((j) => !r.jobIds.includes(j.id) && j.totalAngles === r.pendingTotal && Date.parse(j.createdAt) >= since)
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
        if (cancelled) return;
        if (hit) {
          commitRun({ ...r, jobIds: [...r.jobIds, hit.id], pendingSince: undefined, pendingTotal: undefined });
          setPhase("running");
          return;
        }
        await new Promise((res) => setTimeout(res, 5_000));
      }
      const r = runRef.current;
      if (!cancelled && r?.pendingSince) commitRun({ ...r, pendingSince: undefined, pendingTotal: undefined });
    })();
    return () => {
      cancelled = true;
    };
  }, [user, commitRun]);
  // GPU は最後のジョブの完了から 30 秒で止まる（CLAUDE.md §1）。その間に「続きを作る」を押せば起動待ちが無い。
  const { isWarm: gpuWarm, remainingMs: gpuWarmMs, markWarm: markGpuWarm } = useLocalWarmCountdown(30);
  // 実行前の一覧（review）。ここで日本語の内容を直してから投げる。
  const [review, setReview] = useState<ScenePlanItem[]>([]);
  // 一覧で「先に作る」と印を付けた行（最初の 8 枚に回す、2026-09-27 ホスト要望）。
  const [firstKeys, setFirstKeys] = useState<Set<string>>(new Set());

  // LoRA Studio 等から画像を受け取る（先頭がメイン、以降が参照）。
  useEffect(() => {
    const h = takeStudioBatchHandoff("dataset");
    if (!h || h.files.length === 0) return;
    queueMicrotask(() => {
      setImage(h.files[0]);
      setSubImages(h.files.slice(1, 1 + MAX_SUB_REFERENCE_IMAGES));
      setNotice(`${h.source}を受け取りました。${h.hint ? ` ${h.hint}` : ""}`);
    });
  }, [setImage, setSubImages]);

  const handleImageSelected = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) {
        setImageError("画像ファイル（PNG / JPEG / WebP）を選んでください。");
        return;
      }
      setImageError(null);
      setImage(file);
      // 新しいメインなら基準の全身と選んだ参照はやり直し。写り方も判定し直す（手動の切り替えも戻す）。
      setBaseFull(null);
      setRefDiag(null);
      setPicks({});
      setMainFraming(undefined);
      setRouteOverride("auto");
    },
    [setImage],
  );
  const handleAddSub = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) {
        setSubError("画像ファイル（PNG / JPEG / WebP）を選んでください。");
        return;
      }
      setSubError(null);
      setSubImages((prev) => (prev.length >= MAX_SUB_REFERENCE_IMAGES ? prev : [...prev, file]));
    },
    [setSubImages],
  );

  const toggle = (axis: SceneAxis, id: string) =>
    setSel((prev) => {
      const cur = prev[axis];
      return { ...prev, [axis]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
    });

  const subCount = subImages.length;
  const perImage = sceneCreditsPerImage(knobs, 0);
  const perImageWithRef = sceneCreditsPerImage(knobs, 1);
  const safeCount = Math.max(1, Math.min(SCENE_MAX_COUNT, Math.trunc(count || 0)));
  // 寄りの行（後ろ以外）に添える元の顔アップ（2026-09-30 ホスト判断「アップのときは後ろ以外常に参照」、こだわりのみ）。
  // 顔アップ・上半身から始めた（基準の全身像がある）ときは元の画像、全身から始めたときは切り出したバストアップ。
  // 寄りの元画像そのものが顔アップのとき（全身始まりのバスト行など）は重複なので付けない。
  const faceRefFile: File | null = (() => {
    if (precision !== "careful" || !image) return null;
    const route = mainRouteOf(mainFraming, routeOverride);
    return route !== "full" && activeBaseFull ? image : (derived.bust ?? null);
  })();
  useEffect(() => {
    faceRefFileRef.current = faceRefFile;
  }, [faceRefFile]);
  const faceRefFor = useMemo<Partial<Record<CloseFraming, boolean>>>(() => {
    if (!faceRefFile) return {};
    const sourceOf = (f: CloseFraming): File | null => {
      const idx = closeMain[f];
      if (typeof idx === "number" && subImages[idx]) return subImages[idx];
      return derived[f] ?? effectiveMain;
    };
    return { upper: sourceOf("upper") !== faceRefFile, bust: sourceOf("bust") !== faceRefFile };
  }, [faceRefFile, closeMain, subImages, derived, effectiveMain]);
  const batchOpt = useMemo(
    () => ({
      subCount,
      closeMain,
      derived: derivedFlags,
      hasBackRef: Boolean(refBack),
      hasSideRef: Boolean(refSide),
      hasDiagRef: Boolean(refDiag),
      faceRefFor,
    }),
    [subCount, closeMain, derivedFlags, refBack, refSide, refDiag, faceRefFor],
  );
  // 料金は行ごと（参照が要る向きだけ係数付き）。指定を変えるたびに計画を組み直して見積もる。
  const previewOrdered = useMemo(() => orderPlanForBatches(buildScenePlan(sel, safeCount), batchOpt), [sel, safeCount, batchOpt]);
  const previewPlan = previewOrdered.plan;
  const totalCost = scenePlanCredits(previewPlan, knobs, batchOpt);
  const firstBatch = Math.min(previewOrdered.prefixLen, previewPlan.length);
  const firstCost = scenePlanCredits(previewPlan.slice(0, firstBatch), knobs, batchOpt);
  const refRows = previewPlan.filter((it) => sceneItemGroup(it, batchOpt) === "refs").length;
  const framingsInPlan = new Set(previewPlan.map((it) => it.framingId));
  const viewsInPlan = new Set(previewPlan.map((it) => it.viewId));
  // 経路（2026-09-29）: 顔アップ→体の設計が必須／上半身→下の服は任意／全身→そのまま。手動で切り替えられる。
  const mainRoute = image ? mainRouteOf(mainFraming, routeOverride) : null;
  // 全身から始めても「体つきを調整する」なら、調整した基準の全身像を候補から選ぶ（2026-09-29）。
  const fullAdjust = mainRoute === "full" && adjustBody;
  const needsBaseFull =
    precision === "careful" &&
    Boolean(image) &&
    !baseFull &&
    !deriving &&
    mainRoute !== null &&
    (mainRoute !== "full" || adjustBody);
  // かんたんで顔アップ（上半身・体つきの調整）のときは、体の設計を本生成の全部の画像に添える。
  const quickBody = precision === "quick" && (mainRoute === "face" || mainRoute === "upper" || fullAdjust);
  const quickBlocked = quickBody && mainRoute ? bodyDesignBlockedReason(bodyDesign, mainRoute) : null;
  // 真横 → 後ろ姿の順（2026-09-29）。一覧に真横があれば、後ろ姿は確定した真横を添えて作る（髪を真横に揃える）。
  const sideInPlan = viewsInPlan.has("side");
  const backUsesSide = Boolean(refSide) || sideInPlan;
  const backBlocked = backUsesSide && !refSide ? "先に上の「真横の参照」を確定してください（後ろ髪を真横に揃えるため）。" : null;
  const sideSpecs = useMemo(() => sideViewSpecs(hairNote), [hairNote]);
  // 真横の候補に顔の大きく写った画像を添える（横顔が似る、2026-09-29 ホスト実走・全ルートで添える方針）。
  // 顔アップ・上半身から始めた（基準の全身像がある）ときは元の画像、全身から始めたときは自動で切り出したバストアップ。
  // 真横の候補に添える顔の画像は、サムネを並べて使う人が選ぶ（2026-09-29 ホスト「どれを参照にするか分からない」）。
  // 既定（auto）は下の sideFaceAvailable（元の画像、全身から始めたときは切り出したバストアップ）。
  // 全身から始めた（体つきの調整を含む）ときは顔が小さいので、切り出したバストアップを添える。
  const sideFaceAvailable = mainRoute !== "full" && activeBaseFull && image ? image : (derived.bust ?? null);
  // 選べる画像: 元の画像（基準の全身像と違うときだけ意味がある）、切り出したバストアップ、参照欄の手持ち（確定した真横・後ろ姿は除く）。
  const sideFaceOrig = activeBaseFull && image ? image : null;
  const sideFaceBust = derived.bust ?? null;
  const sideFaceRef: File | null =
    sideFaceChoice === "none"
      ? null
      : sideFaceChoice === "orig"
        ? sideFaceOrig
        : sideFaceChoice === "bust"
          ? sideFaceBust
          : typeof sideFaceChoice === "number"
            ? (subImages[sideFaceChoice] ?? null)
            : sideFaceAvailable;
  const backSpecs = useMemo(() => backViewSpecs(hairNote, backUsesSide), [hairNote, backUsesSide]);
  const baseFullSpecs = useMemo(
    () =>
      mainRoute === "face" || mainRoute === "upper" || (mainRoute === "full" && adjustBody)
        ? bodyDesignSpecs(bodyDesign, mainRoute)
        : FULL_BODY_SPECS,
    [mainRoute, bodyDesign, adjustBody],
  );
  const baseFullBlocked = mainRoute ? bodyDesignBlockedReason(bodyDesign, mainRoute) : null;
  const busy = phase === "submitting" || phase === "running";
  // 生成中や、まだ LoRA へ送っていない結果があるときは、離脱前にブラウザの確認を出す（2026-09-28）。
  // 画像・参照は保存して復元するので対象外。
  const hasUnsentResults = Boolean(run && run.jobIds.length > 0 && phase !== "idle");
  useEffect(() => {
    if (!busy && !hasUnsentResults) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [busy, hasUnsentResults]);
  const insufficientForFirst = Boolean(user) && !creditsLoading && (credits ?? 0) < firstCost;

  // --- ジョブ投入 ----------------------------------------------------------
  const submitBatch = useCallback(
    async (r: PersistedRun, batchIndex: number, mainFile: File, subs: File[]) => {
      if (!user) return;
      const opt = runBatchOpt(r);
      const batch = planBatches(r.plan, opt, r.prefixLen)[batchIndex];
      const items = batch?.items;
      if (!items) return;
      // 行ごとに画像セットを組む（2026-09-28）: 元＝全身ならメイン／上半身・バストアップなら参照の指定 → 切り出し → メイン、
      // 参照＝後ろの行は後ろ姿 1 枚・真横の行は真横 1 枚（専用の参照が無ければ参照欄の全部）。同じ File は 1 セットにまとめる。
      const main = effectiveMainRef.current ?? mainFile;
      const sourceOf = (it: ScenePlanItem): File => {
        if (it.framingId === "upper" || it.framingId === "bust") {
          const idx = closeMainIndexFor(it, opt);
          if (idx !== null && subs[idx]) return subs[idx];
          const d = derivedRef.current[it.framingId as CloseFraming];
          if (d) return d;
        }
        return main;
      };
      const diag = r.hasDiagRef ? refDiagRef.current : null;
      const face = faceRefFileRef.current;
      const refsOf = (it: ScenePlanItem): File[] => {
        if (it.viewId === "back") return refBackRef.current ? [refBackRef.current] : subs;
        let refs: File[] = [];
        if (it.viewId === "side") refs = refSideRef.current ? [refSideRef.current] : subs;
        // 斜めの行: 確定した斜めの顔（run を作った時点で確定していたときだけ。料金の見積もりと揃える）。
        else if (it.viewId === "three_quarter" && diag) refs = [diag];
        // 寄りの行（後ろ以外）: 元の顔アップも添える（2026-09-30）。
        if (sceneItemUsesFaceRef(it, opt) && face && !refs.includes(face) && face !== sourceOf(it)) refs = [...refs, face];
        return refs;
      };
      // 添えた顔の参照を指示で名指しする（image 1 は元の画像、参照は image 2 から）。
      const faceTail = (refs: File[]) => {
        let t = "";
        const di = diag ? refs.indexOf(diag) : -1;
        if (di >= 0) t += ` The face must be the same person as in image ${di + 2}, which shows the same face at this angle.`;
        const fi = face ? refs.indexOf(face) : -1;
        if (fi >= 0) t += ` The face must closely match the close-up face in image ${fi + 2} (the same person).`;
        return t;
      };
      const sets: File[][] = [];
      const setIndex = (files: File[]) => {
        const found = sets.findIndex((st) => st.length === files.length && st.every((f, k) => f === files[k]));
        if (found >= 0) return found;
        sets.push(files);
        return sets.length - 1;
      };
      const bodyTail = quickBody ? bodyDesignSentence(bodyDesign) : "";
      const scenes = items.map((it) => {
        const refs = refsOf(it);
        return {
          instruction: (bodyTail ? `${scenePlanInstruction(it)} ${bodyTail}` : scenePlanInstruction(it)) + faceTail(refs),
          label: scenePlanLabel(it),
          set: setIndex([sourceOf(it), ...refs]),
        };
      });
      setPhase("submitting");
      setErrorMessage(null);
      // 候補づくりが動いていれば、終わるまで待ってから投げる（追加料金なし・温かいまま始まる）。
      gpuReleaseRef.current = await gpuLock.acquire();
      commitRun({ ...r, pendingSince: Date.now(), pendingTotal: scenes.length });
      try {
        const res = await startAngleJob({
          userId: user.id,
          image: main,
          subImages: [],
          selection: { azimuths: [], elevations: [], distances: [] },
          mode: "standard",
          scenes,
          imageSets: sets,
          negativePrompt: sceneNegativePrompt(sourceStyle),
        });
        broadcastCreditsUpdate(user.id, res.remainingCredits);
        const next: PersistedRun = { ...r, jobIds: [...r.jobIds, res.jobId], pendingSince: undefined, pendingTotal: undefined };
        commitRun(next);
        setPhase("running");
      } catch (err) {
        gpuReleaseRef.current?.();
        gpuReleaseRef.current = null;
        commitRun({ ...r, pendingSince: undefined, pendingTotal: undefined });
        console.error("[DatasetBuilderTab] start failed:", err);
        setErrorMessage(err instanceof Error ? err.message : "ジョブの作成に失敗しました。");
        setPhase(r.jobIds.length > 0 ? "paused" : "error");
        const remaining = (err as AngleApiError)?.remainingCredits;
        if (typeof remaining === "number") {
          broadcastCreditsUpdate(user.id, remaining);
          if (remaining < perImage) setChargeOpen(true);
        }
      }
    },
    [user, commitRun, perImage, gpuLock, quickBody, bodyDesign, sourceStyle],
  );
  const runOpt = useMemo(
    () =>
      run
        ? runBatchOpt(run)
        : { subCount: 0, closeMain: {}, derived: {} },
    [run],
  );
  const runBatches = useMemo(() => (run ? planBatches(run.plan, runOpt, run.prefixLen) : []), [run, runOpt]);

  // 一覧や進捗の位置へスクロールする（2026-09-28、ホスト指摘「押した場所に取り残される」）。
  // 画面の組み替え（一覧が消えて結果欄が出る等）を待ってから飛ぶ。見つからなければ少し待って取り直す（最大 ~2 秒）。
  const scrollToId = (id: string) => {
    let tries = 0;
    const go = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (++tries < 12) window.setTimeout(go, 160);
    };
    window.setTimeout(go, 120);
  };
  // 「作る」→ まず一覧（日本語）を出して直せるようにする（2026-09-27、ホスト指摘「どんなプロンプトで作られるか分からない」）。
  const handleStart = () => {
    if (!user) return setLoginOpen(true);
    // 不足なら入力前でもチャージへ（全タブ共通、2026-09-28）。
    if (!busy && insufficientForFirst) return setChargeOpen(true);
    if (!image) return;
    if (needsBaseFull) {
      setErrorMessage("メイン画像に全身が写っていません。先に「基準の全身像を作る」で 1 枚選んでください（手早く済ませるなら作り方を「かんたん」に）。");
      return;
    }
    if (quickBlocked) {
      setErrorMessage(quickBlocked);
      return;
    }
    if (insufficientForFirst) return setChargeOpen(true);
    const plan = buildScenePlan(sel, safeCount);
    if (plan.length === 0) return;
    setReview(plan);
    setFirstKeys(new Set());
    setErrorMessage(null);
    setPhase("review");
    scrollToId("dataset-review");
  };
  const handleConfirmReview = () => {
    if (!image || review.length === 0) return;
    const ordered = orderPlanForBatches(review, batchOpt, firstKeys);
    const r: PersistedRun = {
      plan: ordered.plan,
      jobIds: [],
      confirmFirst,
      confirmed: !confirmFirst,
      subCount,
      closeMain,
      derived: derivedFlags,
      // 確認しないときは先頭で区切らず、全部を大きいジョブで送る（タブを閉じても最後まで流れる、2026-10-03）。
      prefixLen: confirmFirst ? ordered.prefixLen : 0,
      restBatchSize: SCENE_REST_BATCH_SIZE,
      hasBackRef: Boolean(refBack),
      hasSideRef: Boolean(refSide),
      hasDiagRef: Boolean(refDiag),
      faceRefFor,
    };
    setJobs({});
    commitRun(r);
    void submitBatch(r, 0, image, subImages);
    // 画像が並ぶ「できた素材」の欄へ（2026-09-29 ホスト指摘: 進捗へ飛ぶと画像は別の場所に出て見失う）。
    scrollToId("dataset-results");
  };

  const handleContinue = () => {
    const r = runRef.current;
    if (!r || !image) return;
    const next = { ...r, confirmed: true };
    commitRun(next);
    void submitBatch(next, next.jobIds.length, image, subImages);
    scrollToId("dataset-results");
  };
  // 止めている間に残りの行を直す（2026-09-30、ホスト指摘「リセットして作り直すと先に LoRA へ送らないと消える」）。
  // バッチは plan を先頭から順に切るので、投げ済みのジョブが受け持つ先頭 done 行は触らず、その後ろだけ差し替える。
  const updateRemaining = (fn: (rest: ScenePlanItem[]) => ScenePlanItem[]) => {
    const r = runRef.current;
    if (!r) return;
    const rOpt = runBatchOpt(r);
    const done = planBatches(r.plan, rOpt, r.prefixLen)
      .slice(0, r.jobIds.length)
      .reduce((t, b) => t + b.items.length, 0);
    const rest = fn(r.plan.slice(done));
    if (rest.length === 0) return;
    commitRun({ ...r, plan: [...r.plan.slice(0, done), ...rest] });
  };
  // 初期状態に戻す（2026-09-27、ホスト指摘「リロードしても前回の続きから抜け出せない」）。
  // 保存した実行を消して、画像・指定はそのまま残す。生成済みの画像はサーバーに 14 日残るが、この画面からは消える。
  const handleReset = () => {
    commitRun(null);
    setJobs({});
    setRejected(new Set());
    setReview([]);
    setErrorMessage(null);
    setNotice(null);
    setPhase("idle");
  };

  // --- ポーリング（今動いているジョブ 1 本だけ） ---------------------------------
  const activeJobId = run && run.jobIds.length > 0 ? run.jobIds[run.jobIds.length - 1] : null;
  useEffect(() => {
    if (!activeJobId || (phase !== "running" && phase !== "paused" && phase !== "done")) return;
    const j = jobs[activeJobId];
    if (j && (j.status === "completed" || j.status === "failed")) return;
    let cancelled = false;
    let errorStreak = 0;
    // 復元した「とっくに終わったジョブ」で warm 表示を始めないよう、このポーリング中に進行を見たときだけ warm にする。
    let sawInProgress = false;
    (async () => {
      while (!cancelled) {
        try {
          const next = await pollAngleJob(activeJobId);
          if (cancelled) return;
          errorStreak = 0;
          setJobs((prev) => ({ ...prev, [activeJobId]: next }));
          if (next.status === "pending" || next.status === "processing") sawInProgress = true;
          if (next.status === "completed" || next.status === "failed") {
            gpuReleaseRef.current?.();
            gpuReleaseRef.current = null;
            if (sawInProgress && next.status === "completed") markGpuWarm();
            const r = runRef.current;
            if (!r) return;
            const rOpt = runBatchOpt(r);
            const batches = planBatches(r.plan, rOpt, r.prefixLen);
            const doneBatches = r.jobIds.length;
            if (next.status === "failed") {
              setErrorMessage(next.errorMessage || "生成に失敗しました。");
              setPhase("paused");
              return;
            }
            if (doneBatches >= batches.length) {
              setPhase("done");
              return;
            }
            // 「最初に確認する行」のジョブが全部終わるまでは止めずに続ける（種類ごとに分かれた小さなジョブを連続で流す）。
            if (r.confirmFirst && !r.confirmed && doneBatches >= checkBatchCount(r.plan, rOpt, r.prefixLen)) {
              setPhase("paused");
              return;
            }
            // 次のジョブへ（画像はメモリにあるときだけ。リロード後は続きを作れないので止める）。
            const mainFile = imageRef.current;
            if (!mainFile) {
              setPhase("paused");
              setNotice("続きを作るには、同じ画像をもう一度入れてから「続きを作る」を押してください。");
              return;
            }
            void submitBatch(r, doneBatches, mainFile, subImagesRef.current);
            return;
          }
        } catch (err) {
          if (cancelled) return;
          if (err instanceof AngleJobNotFoundError) {
            setErrorMessage("このジョブは見つかりませんでした。新しく生成してください。");
            setPhase("error");
            return;
          }
          errorStreak += 1;
          if (errorStreak >= 8) {
            setErrorMessage("進捗の取得に繰り返し失敗しました。時間をおいて再読み込みしてください。");
            setPhase("error");
            return;
          }
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    })();
    return () => {
      cancelled = true;
    };
    // jobs は中で読むだけ（依存に入れると完了ごとに再起動する）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId, phase, submitBatch, markGpuWarm]);

  // リロード直後: 過去のジョブの結果を読み直す（完了済みは 1 回で済む）。
  useEffect(() => {
    if (!run) return;
    const missing = run.jobIds.filter((id) => !jobs[id] && id !== activeJobId);
    if (missing.length === 0) return;
    let alive = true;
    Promise.all(missing.map((id) => pollAngleJob(id).catch(() => null))).then((rows) => {
      if (!alive) return;
      setJobs((prev) => {
        const next = { ...prev };
        rows.forEach((j, i) => {
          if (j) next[missing[i]] = j;
        });
        return next;
      });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.jobIds.join(",")]);

  // --- 結果 -----------------------------------------------------------------
  type ResultItem = { key: string; jobId: string; index: number; url: string; label: string };
  const results: ResultItem[] = useMemo(() => {
    if (!run) return [];
    const out: ResultItem[] = [];
    for (const id of run.jobIds) {
      const j = jobs[id];
      if (!j) continue;
      j.images.forEach((url, i) => out.push({ key: `${id}:${i}`, jobId: id, index: i, url, label: j.labels[i] ?? "" }));
    }
    return out;
  }, [run, jobs]);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // 元画像（切り出し）の拡大表示。
  const [localPreview, setLocalPreview] = useState<{ url: string; label: string } | null>(null);
  const kept = results.filter((r) => !rejected.has(r.key));
  const lightItems: LightItem[] = results.map((r) => ({ url: r.url, label: r.label }));
  const toggleRejected = (key: string) =>
    setRejected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // R2 への移動・署名切れで 404 になったら取り直す（2 回まで）。
  const refreshResultUrl = (r: ResultItem) => {
    const n = reloads[r.key] ?? 0;
    if (n >= 2) return;
    void freshAngleImageUrl(r.jobId, r.index, r.url).then((u) => {
      setJobs((prev) => {
        const j = prev[r.jobId];
        if (!j) return prev;
        const images = [...j.images];
        images[r.index] = u;
        return { ...prev, [r.jobId]: { ...j, images } };
      });
      setReloads((prev) => ({ ...prev, [r.key]: n + 1 }));
    });
  };
  // 保存・LoRA・ZIP は押した時点で URL を取り直す（CLAUDE.md §6-11）。
  const fetchFresh = (r: ResultItem): Promise<Blob> => fetchAngleImageBlob(r.jobId, r.index, r.url);
  const fileName = (r: ResultItem, n: number) => `dataset_${r.jobId.slice(0, 6)}_${String(n + 1).padStart(2, "0")}.png`;
  const triggerDownload = (blob: Blob, name: string) => {
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  };
  const saveOne = async (r: ResultItem) => {
    try {
      triggerDownload(await fetchFresh(r), fileName(r, results.indexOf(r)));
    } catch (err) {
      setErrorMessage(`保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const upscaleOne = async (r: ResultItem) => {
    const url = await freshAngleImageUrl(r.jobId, r.index, r.url);
    requestStudioHandoff({ kind: "image", url, filename: fileName(r, results.indexOf(r)), source: "素材づくりの結果" }, "upscale");
  };
  const downloadZip = async () => {
    if (kept.length === 0) return;
    setZipping(true);
    setErrorMessage(null);
    try {
      const zip = new JSZip();
      const blobs = await Promise.all(kept.map((r) => fetchFresh(r)));
      const date = zipLocalDate();
      blobs.forEach((b, n) => zip.file(fileName(kept[n], n), b, { date }));
      triggerDownload(await zip.generateAsync({ type: "blob" }), `dataset_${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (err) {
      setErrorMessage(`ZIP の作成に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setZipping(false);
    }
  };

  const sendToLora = async () => {
    if (kept.length === 0) return;
    setSending(true);
    setErrorMessage(null);
    try {
      const files = await Promise.all(
        kept.map(async (c, n) => {
          const blob = await fetchFresh(c);
          return new File([blob], fileName(c, n), { type: blob.type || "image/png" });
        }),
      );
      // 顔アップから作ったときは元の顔アップも送る（顔の細部は元画像から学ばせる、2026-09-29）。
      if (mainRoute === "face" && sendOriginal && image) files.push(image);
      sendLoraAdditions(files, `素材づくりで作った ${files.length} 枚`);
    } catch (err) {
      setErrorMessage(`LoRA Studio への送信に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  };

  const activeJob = activeJobId ? jobs[activeJobId] : null;
  const plannedTotal = run?.plan.length ?? 0;
  const producedTotal = results.length;
  const remainingItems = run ? runBatches.slice(run.jobIds.length).flatMap((b) => b.items) : [];
  const remainingCount = remainingItems.length;
  const remainingCost = run ? scenePlanCredits(remainingItems, knobs, runOpt) : 0;
  const nextBatchCost = run && runBatches[run.jobIds.length] ? scenePlanCredits(runBatches[run.jobIds.length].items, knobs, runOpt) : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* 左: 入力 */}
        <div className="space-y-4">
          {restorePending && !image && (
            <RestorePrompt
              summary={
                "メイン画像 1 枚" +
                (restorePending.subs.length > 0 ? `・参照 ${restorePending.subs.length} 枚` : "") +
                (restorePending.base ? "・基準の全身像 1 枚" : "")
              }
              onRestore={applyRestore}
              onDiscard={discardRestore}
            />
          )}
          <ImageDropzone
            file={image}
            previewUrl={imagePreview}
            onZoom={() => imagePreview && setLocalPreview({ url: imagePreview, label: image?.name ?? "メイン画像" })}
            onFileSelected={handleImageSelected}
            onClear={() => {
              setImage(null);
              setBaseFull(null);
              setRefDiag(null);
              setPicks({});
              setMainFraming(undefined);
              setRouteOverride("auto");
              void fileStoreClear(FILES_PREFIX);
            }}
          />
          {image && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
              <span>
                写り方:{" "}
                <span className="text-foreground">
                  {mainRoute === "face" ? "顔アップ" : mainRoute === "upper" ? "上半身" : mainRoute === "full" ? "全身" : "判定中…"}
                </span>
                {routeOverride === "auto" ? "（自動判定）" : "（手動）"}
              </span>
              <select
                value={routeOverride}
                onChange={(e) => {
                  setRouteOverride(e.target.value as MainRoute | "auto");
                  setBaseFull(null);
                  setPicks((p) => ({ ...p, full: undefined }));
                }}
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground"
                aria-label="写り方の判定を変える"
              >
                <option value="auto">自動判定</option>
                <option value="full">全身</option>
                <option value="upper">上半身</option>
                <option value="face">顔アップ</option>
              </select>
              <span className="text-[10px] text-muted/80">判定がちがうときは変えてください。</span>
            </div>
          )}
          {image && (
            // 作り方（2026-09-29 ホスト判断）: 品質重視なので「こだわり」が既定。手早く済ませたい人は「かんたん」。
            <div className="space-y-1.5 rounded-lg border border-border bg-background/40 px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-muted">作り方:</span>
                {(
                  [
                    ["careful", "こだわり（おすすめ）"],
                    ["quick", "かんたん"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setPrecision(id)}
                    className={`rounded-full border px-2.5 py-1 ${
                      precision === id
                        ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                        : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-muted">元画像の画風:</span>
                {(
                  [
                    ["auto", "おまかせ"],
                    ["photo", "実写"],
                    ["illust", "イラスト・アニメ"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSourceStyle(id)}
                    className={`rounded-full border px-2.5 py-1 ${
                      sourceStyle === id
                        ? "border-neon-violet/60 bg-neon-violet/15 text-foreground"
                        : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <span className="text-[10px] text-muted/80">実写を選ぶと、アニメ調に転ぶのを抑えます。</span>
              </div>
              <HelpNote
                id="dataset.precision"
                title={precision === "careful" ? "「こだわり」で作ると" : "「かんたん」で作ると"}
                summary={
                  precision === "careful"
                    ? "基準の全身像・真横・後ろ姿を先に候補から選んで確定し、それを元に作ります。顔や体つきが揃いやすく、仕上がりの精度が上がります（候補づくりの料金がかかります）。"
                    : "基準の全身像・真横・後ろ姿を作らず、メイン画像のまますぐ作ります。手早く安く済みますが、顔や体つきは画像ごとに多少ぶれます。"
                }
              />
              {mainRoute === "full" && (
                <label className="flex items-center gap-1.5 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={adjustBody}
                    onChange={(e) => {
                      setAdjustBody(e.target.checked);
                      setBaseFull(null);
                      setPicks((p) => ({ ...p, full: undefined }));
                    }}
                  />
                  体つきを調整する（胸の大きさ・体型・背丈など。顔・髪・服は元のまま）
                </label>
              )}
              {quickBody && mainRoute && (
                <BodyDesignForm design={bodyDesign} onChange={setBodyDesign} route={mainRoute} />
              )}
            </div>
          )}
          {imageError && <p className="text-[11px] text-red-400">{imageError}</p>}
          <SubReferenceSlots
            files={subImages}
            onAdd={handleAddSub}
            onRemove={(i) => setSubImages((p) => p.filter((_, k) => k !== i))}
            error={subError}
            onZoom={(i, url) => setLocalPreview({ url, label: `参照 ${i + 1}` })}
          />
          <HelpNote id="dataset.reference" title="参照の使われ方" summary="メインの画像からは分からない後ろ姿・真横があれば、参照に足してください。">
            参照は真横・後ろ向きの画像にだけ使い、正面・斜めの画像はメイン 1 枚で作ります（そのぶん速く・安く）。
          </HelpNote>
          {image && (
            <div className="space-y-2 rounded-lg border border-neon-violet/30 bg-neon-violet/5 px-3 py-2">
              <p className="text-[11px] font-medium text-foreground">素材づくりの基準にする画像</p>
              <HelpNote
                id="dataset.base" title="基準にする画像について"
                summary={`全身の画像は${activeBaseFull ? "確定した基準の全身像" : "メイン画像"}を、上半身・バストアップの画像は下の画像を基準に作ります。`}
              >
                上半身・バストアップの基準は、{activeBaseFull ? "基準の全身像" : "メイン画像"}から自動で切り出します（無料・切り出しの解像度は仕上がりに影響しません）。
                寄りで写った手持ちの画像（上半身・バストアップの写真など）を参照欄に入れていれば、それを基準に生成することもできます。
              </HelpNote>
              {deriving && (
                <p className="flex items-center gap-1.5 text-[10px] text-muted">
                  <Loader2 size={10} className="animate-spin" /> {activeBaseFull ? "基準の全身像" : "メイン画像"}から切り出しています…
                </p>
              )}
              {(["upper", "bust"] as CloseFraming[]).map((f) => {
                  const auto = f === "upper" ? derived.upper : derived.bust;
                  const autoUrl = f === "upper" ? derivedUpperUrl : derivedBustUrl;
                  const choice = closeChoice[f];
                  const chip = (active: boolean) =>
                    `rounded-full border px-2.5 py-1 text-[11px] ${active ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink" : "border-border text-muted"}`;
                  return (
                    <div key={f} className="flex flex-wrap items-center gap-1.5">
                      {choice === "auto" && autoUrl ? (
                        <button
                          type="button"
                          onClick={() => setLocalPreview({ url: autoUrl, label: f === "upper" ? "上半身の元（切り出し）" : "バストアップの元（切り出し）" })}
                          className="relative h-12 w-10 shrink-0 cursor-zoom-in overflow-hidden rounded bg-black/40"
                          title="拡大"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={autoUrl} alt="" className="h-full w-full object-contain" />
                        </button>
                      ) : (
                        <span className="h-12 w-10 shrink-0 rounded bg-black/20" />
                      )}
                      <span className="w-24 shrink-0 text-[11px] text-muted">
                        {f === "upper" ? "上半身の元" : "バストアップの元"}
                        {!framingsInPlan.has(f) && <span className="block text-[9px] opacity-70">（構図で未選択）</span>}
                      </span>
                      <button
                        type="button"
                        onClick={() => setCloseChoice((p) => ({ ...p, [f]: "auto" }))}
                        disabled={!auto}
                        title={auto ? "" : `${activeBaseFull ? "基準の全身像" : "メイン画像"}から切り出せませんでした（人物が検出できないか、既に寄っています）`}
                        className={`${chip(choice === "auto")} disabled:opacity-40`}
                      >
                        自動で切り出し（おすすめ）
                      </button>
                      <button
                        type="button"
                        onClick={() => setCloseChoice((p) => ({ ...p, [f]: "main" }))}
                        className={chip(choice === "main")}
                        title="切り出さずにそのまま元にして、文章で寄りを指示します（全身のまま出やすい）"
                      >
                        {activeBaseFull ? "基準の全身像のまま" : "メイン画像のまま"}
                      </button>
                      {/* 手持ちの寄りの画像だけを選択肢に出す。確定した真横・後ろ姿も参照欄に入るが、寄りの基準には向かないので出さない。 */}
                      {subImages.map((file, i) => file === refSide || file === refBack ? null : (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setCloseChoice((p) => ({ ...p, [f]: i }))}
                          className={chip(choice === i)}
                          title={file.name}
                        >
                          手持ちの画像（参照 {i + 1}）
                        </button>
                      ))}
                      {!auto && !deriving && choice === "auto" && (
                        <span className="w-full text-[10px] text-amber-400">
                          切り出せなかったので{activeBaseFull ? "基準の全身像" : "メイン画像"}のまま作ります{derived.reason ? `（${derived.reason}）` : ""}。寄りで写った手持ちの画像を参照欄に入れて選ぶこともできます。
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
          {/* 参照づくり（段階 1・3）: 全身が無ければ基準の全身を、真横・後ろの行があれば参照を、候補から選んで確定する。 */}
          {precision === "careful" && image && (needsBaseFull || baseFull) && (
            <CandidatePanel
              compareImage={image}
              title={baseFull ? "基準の全身像（確定済み）" : "基準の全身像を作る"}
              description={
                baseFull
                  ? "これから作る素材の全身の画像はこの全身像を元に、上半身・バストアップの画像はこの全身像から自動で切り出した寄りの画像を元に作ります。別の候補に替えることもできます。"
                  : fullAdjust
                    ? "体つきを変えたい項目を指定して全身の候補を作り、いちばんイメージに合う 1 枚を選んでください。顔・髪・服は元の画像のまま保ちます。選んだ全身像が以後に作る全部の画像の元になります。"
                  : mainRoute === "face"
                    ? "顔だけの画像なので、まず体と服を決めて全身の候補を作り、気に入った 1 枚を選んでください。候補ごとに顔の雰囲気が少しずつ違うので、いちばんイメージに合う顔を選ぶのがコツです。選んだ全身像が、以後に作る全部の画像の元になります。"
                    : "メイン画像に足元まで写っていないので、まず全身の候補を作って 1 枚選んでください。体つき・服装はここで確定し、選んだ全身像が以後に作る全部の画像の元になります。"
              }
              user={user}
              image={image}
              specs={baseFullSpecs}
              aspect="portrait"
              blockedReason={baseFull ? null : baseFullBlocked}
              costPerImage={perImage}
              credits={credits}
              storageKey="dataset-builder-cand-full"
              picked={picks.full ?? null}
              hasPickedFile={Boolean(baseFull)}
              onPick={(pick, file) => {
                setPicks((p) => ({ ...p, full: pick }));
                setBaseFull(file);
              }}
              onLogin={() => setLoginOpen(true)}
              onCharge={() => setChargeOpen(true)}
              fileName="base_full.png"
              confirmed={baseFull}
              gpuLock={gpuLock}
            >
              {!baseFull && (mainRoute === "face" || mainRoute === "upper" || fullAdjust) && mainRoute && (
                <BodyDesignForm design={bodyDesign} onChange={setBodyDesign} route={mainRoute} />
              )}
            </CandidatePanel>
          )}
          {precision === "careful" && effectiveMain && (viewsInPlan.has("side") || viewsInPlan.has("back") || refSide || refBack) && (
            // 後ろ髪の指定は真横・後ろ姿の両方の候補に使う（真横を先に作り、後ろ姿は選んだ真横に揃えるので、真横の前に決める）。
            <label className="flex flex-col gap-1 rounded-lg border border-border bg-background/40 px-3 py-2 text-[10px] text-muted">
              <span>
                <span className="font-medium text-foreground">後ろ髪の指定</span>（任意・日本語可。真横と後ろ姿の候補に使います）
              </span>
              <input
                type="text"
                value={hairNote}
                onChange={(e) => setHairNote(e.target.value)}
                placeholder="例: 腰までのストレート／襟足は刈り上げ／低い位置で一つ結び"
                maxLength={120}
                className="min-w-0 rounded border border-border bg-background px-2 py-1 text-[11px] text-foreground placeholder:text-muted/60"
              />
              <span className="text-muted/80">
                後ろ姿は選んだ真横の髪に揃えるので、後ろ髪を変えたいときはここを直して、真横の候補を追加で作ってください。
              </span>
            </label>
          )}
          {precision === "careful" && effectiveMain && (viewsInPlan.has("side") || refSide) && (
            <CandidatePanel
              compareImage={image}
              title={refSide ? "真横の参照（確定済み）" : "真横の参照を作る"}
              description="真横向きの画像は、ここで選んだ真横を参照にして作ります。候補はカメラを横へ回して作ります（右 2 枚・左 2 枚）。下で、顔の大きく写った画像を選んで添えると横顔が似やすくなります。顔がいちばんイメージに近い 1 枚を選んでください（後ろ姿はこの真横の髪に揃えます）。後ろ髪の長さや結び方を決めたいときは上の「後ろ髪の指定」に書いてください。手持ちの真横があれば、下の「持っているなら」の行にドロップするか「ファイルを選ぶ」で指定してください（参照欄に入れてある場合は「参照 N を使う」で選べます。指定しないと真横として扱われません）。選ぶと参照欄に入ります。"
              user={user}
              image={effectiveMain}
              specs={sideSpecs}
              subImages={sideFaceRef ? [sideFaceRef] : undefined}
              aspect="portrait"
              costPerImage={sideFaceRef ? perImageWithRef : perImage}
              credits={credits}
              storageKey="dataset-builder-cand-side"
              picked={picks.side ?? null}
              hasPickedFile={Boolean(refSide)}
              onPick={(pick, file) => {
                setPicks((p) => ({ ...p, side: pick }));
                putRef(refSide, file);
                setRefSide(file);
              }}
              onLogin={() => setLoginOpen(true)}
              onCharge={() => setChargeOpen(true)}
              fileName="ref_side.png"
              gpuLock={gpuLock}
              confirmed={refSide}
              existingRefs={subImages}
              onPickLocal={(file) => {
                setPicks((p) => ({ ...p, side: null }));
                if (!subImages.includes(file)) putRef(refSide, file);
                setRefSide(file);
              }}
            >
              {!refSide && (
                <SideFacePicker
                  options={[
                    { key: "none", label: "添えない", file: null },
                    ...(sideFaceOrig ? [{ key: "orig" as const, label: "元の画像", file: sideFaceOrig }] : []),
                    ...(sideFaceBust ? [{ key: "bust" as const, label: "自動で切り出したバストアップ", file: sideFaceBust }] : []),
                    ...subImages
                      .map((f, i) => ({ key: i, label: `手持ちの画像（参照 ${i + 1}）`, file: f }))
                      .filter((o) => o.file !== refSide && o.file !== refBack),
                  ]}
                  selected={sideFaceRef}
                  onSelect={(k) => setSideFaceChoice(k)}
                  costWith={4 * perImageWithRef}
                  costWithout={4 * perImage}
                />
              )}
            </CandidatePanel>
          )}
          {precision === "careful" && (sideFaceAvailable || refDiag) && (viewsInPlan.has("three_quarter") || refDiag) && (
            // 斜めの顔（2026-09-30）: 顔の大きく写った画像で向きだけ変えて確定し、斜めの行に添える。
            // 真顔でも向きが変わると別人になりやすい対策（顔が大きい段階で向きを変えると崩れにくい）。
            <CandidatePanel
              compareImage={image}
              title={refDiag ? "斜めの顔の参照（確定済み）" : "斜めの顔の参照を作る"}
              description="斜め向きの画像は、ここで選んだ「斜めを向いた顔」を参照にして作ります（顔が小さい全身・上半身で向きを変えると別人になりやすいため、顔が大きく写った画像で先に向きだけ変えておきます）。元にするのは顔アップ（全身から始めたときは自動で切り出したバストアップ）です。候補 4 枚から、元の人にいちばん近い 1 枚を選んでください。左右どちら向きでも構いません。手持ちの斜めの顔があれば、下の「持っているなら」の行で指定できます。"
              user={user}
              image={sideFaceAvailable}
              specs={DIAG_FACE_SPECS}
              costPerImage={perImage}
              credits={credits}
              storageKey="dataset-builder-cand-diag"
              picked={picks.diag ?? null}
              hasPickedFile={Boolean(refDiag)}
              onPick={(pick, file) => {
                setPicks((p) => ({ ...p, diag: pick }));
                setRefDiag(file);
              }}
              onLogin={() => setLoginOpen(true)}
              onCharge={() => setChargeOpen(true)}
              fileName="ref_diag_face.png"
              gpuLock={gpuLock}
              confirmed={refDiag}
              existingRefs={subImages}
              onPickLocal={(file) => {
                setPicks((p) => ({ ...p, diag: null }));
                setRefDiag(file);
              }}
            >
              {refDiag && (
                <button
                  type="button"
                  onClick={() => {
                    setRefDiag(null);
                    setPicks((p) => ({ ...p, diag: null }));
                  }}
                  className="self-start text-[10px] text-muted underline hover:text-foreground"
                >
                  斜めの顔の参照を外す（斜めの行を参照なしで作る）
                </button>
              )}
            </CandidatePanel>
          )}
          {precision === "careful" && effectiveMain && (viewsInPlan.has("back") || refBack) && (
            <CandidatePanel
              compareImage={image}
              title={refBack ? "後ろ姿の参照（確定済み）" : "後ろ姿の参照を作る"}
              description={
                backUsesSide
                  ? "後ろ向きの画像は、ここで選んだ後ろ姿を参照にして作ります。候補は確定した真横を一緒に見せて、後ろ髪の長さ・形を真横に揃えます。手持ちの後ろ姿があれば、下の「持っているなら」の行にドロップするか「ファイルを選ぶ」で指定してください（参照欄に入れてある場合は「参照 N を使う」で選べます。指定しないと後ろ姿として扱われません）。選ぶと参照欄に入ります。"
                  : "後ろ向きの画像は、ここで選んだ後ろ姿を参照にして作ります（選ばないと毎回ちがう背中になります）。手持ちの後ろ姿があれば、下の「持っているなら」の行にドロップするか「ファイルを選ぶ」で指定してください（参照欄に入れてある場合は「参照 N を使う」で選べます。指定しないと後ろ姿として扱われません）。無ければ候補を作って選びます。選ぶと参照欄に入ります。"
              }
              user={user}
              image={effectiveMain}
              specs={backSpecs}
              subImages={backUsesSide && refSide ? [refSide] : undefined}
              blockedReason={refBack ? null : backBlocked}
              costPerImage={backUsesSide ? perImageWithRef : perImage}
              credits={credits}
              storageKey="dataset-builder-cand-back"
              picked={picks.back ?? null}
              hasPickedFile={Boolean(refBack)}
              onPick={(pick, file) => {
                setPicks((p) => ({ ...p, back: pick }));
                putRef(refBack, file);
                setRefBack(file);
              }}
              onLogin={() => setLoginOpen(true)}
              onCharge={() => setChargeOpen(true)}
              fileName="ref_back.png"
              gpuLock={gpuLock}
              confirmed={refBack}
              existingRefs={subImages}
              onPickLocal={(file) => {
                setPicks((p) => ({ ...p, back: null }));
                if (!subImages.includes(file)) putRef(refBack, file);
                setRefBack(file);
              }}
            />
          )}
          {notice && <p className="text-[11px] text-neon-violet">{notice}</p>}
        </div>

        {/* 右: 指定 */}
        <div className="space-y-4">
          <div id="dataset-scene" className="grid scroll-mt-24 gap-4 rounded-xl border border-border bg-background p-4">
            {/* 止めている間の「これから作る分」から「シーン設定」の名前で参照する（2026-09-30 ホスト指摘）。 */}
            <p className="text-sm font-medium text-foreground">シーン設定</p>
            {/* 表情は既定で真顔に固定（2026-09-30）。変えたい人向けに下の「詳細設定（上級者向け）」の中にだけ出す（2026-10-03）。 */}
            {(["poses", "places", "framings", "views", "outfits"] as SceneAxis[]).map((axis) => (
              <ChipGroup
                key={axis}
                axis={axis}
                selected={sel[axis]}
                onToggle={(id) => toggle(axis, id)}
                onAll={() => setSel((p) => ({ ...p, [axis]: CHIPS_BY_AXIS[axis].map((c) => c.id) }))}
                onClear={() => setSel((p) => ({ ...p, [axis]: [] }))}
                {...(axis === "framings" || axis === "views"
                  ? {
                      ratios: (sel.ratios ?? DEFAULT_SCENE_RATIOS)[axis],
                      onRatio: (id: string, pct: number) =>
                        setSel((p) => {
                          const cur = p.ratios ?? DEFAULT_SCENE_RATIOS;
                          return { ...p, ratios: { ...cur, [axis]: { ...(cur[axis] ?? {}), [id]: pct } } };
                        }),
                      onResetRatios: () =>
                        setSel((p) => ({ ...p, ratios: { ...(p.ratios ?? DEFAULT_SCENE_RATIOS), [axis]: DEFAULT_SCENE_RATIOS[axis] } })),
                    }
                  : {})}
                {...(axis === "poses" || axis === "places"
                  ? (() => {
                      const key = axis === "poses" ? "customPoses" : "customPlaces";
                      return {
                        custom: sel[key] ?? [],
                        onAddCustom: (t: string) =>
                          setSel((p) => ((p[key] ?? []).includes(t) ? p : { ...p, [key]: [...(p[key] ?? []), t] })),
                        onRemoveCustom: (t: string) => setSel((p) => ({ ...p, [key]: (p[key] ?? []).filter((x) => x !== t) })),
                      };
                    })()
                  : {})}
              />
            ))}
            {(() => {
              const filled = Boolean(sel.outfit?.trim() || sel.extra?.trim() || sel.expressionsOn);
              const open = sceneAdvancedOpen || filled;
              return (
                <>
                  <button
                    type="button"
                    onClick={() => setSceneAdvancedOpen(!open)}
                    disabled={filled}
                    aria-expanded={open}
                    className="inline-flex w-fit items-center gap-0.5 text-[11px] text-neon-violet/80 hover:text-neon-violet disabled:cursor-default disabled:hover:text-neon-violet/80"
                  >
                    詳細設定（上級者向け）: 表情・服装の自由指定・追加の指示
                    {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  </button>
                  {open && (
            <>
            {/* 表情（2026-10-03 ホスト判断）: 変えると別人になりやすいので既定オフ・ここにだけ出す。 */}
            <div className="space-y-1.5">
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
                <input
                  type="checkbox"
                  checked={Boolean(sel.expressionsOn)}
                  onChange={(e) => setSel((p) => ({ ...p, expressionsOn: e.target.checked }))}
                />
                表情も変える（既定は真顔）
              </label>
              {sel.expressionsOn && (
                <>
                  <p className="text-[10px] leading-relaxed text-amber-400">
                    表情を変えると顔立ちが変わり、別人に見えやすくなります。LoRA の素材にするなら真顔のままがおすすめです。
                    本人の表情違いの写真があれば、作るよりそれを素材に入れるほうが確実です。
                  </p>
                  <ChipGroup
                    axis="expressions"
                    selected={sel.expressions ?? []}
                    onToggle={(id) => toggle("expressions", id)}
                    onAll={() => setSel((p) => ({ ...p, expressions: CHIPS_BY_AXIS.expressions.map((c) => c.id) }))}
                    onClear={() => setSel((p) => ({ ...p, expressions: [] }))}
                  />
                </>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-[11px] text-muted">
                服装を自由に指定（任意・日本語OK。書くと上のチップより優先）
                <input
                  value={sel.outfit}
                  onChange={(e) => setSel((p) => ({ ...p, outfit: e.target.value }))}
                  placeholder="例: 赤いパーカーとジーンズ"
                  className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
                />
              </label>
              <label className="text-[11px] text-muted">
                追加の指示（任意・日本語OK）
                <input
                  value={sel.extra}
                  onChange={(e) => setSel((p) => ({ ...p, extra: e.target.value }))}
                  placeholder="例: 笑顔でコーヒーを持っている"
                  className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
                />
              </label>
            </div>
            </>
                  )}
                </>
              );
            })()}
            <HelpNote id="dataset.combos" title="組み合わせの作られ方" summary="選んだ組み合わせを順に回して枚数ぶん作ります。">
              未選択の軸は既定（立つ・無地・全身・正面・元の服装）になります。
              服装は 1 枚ごとに順に変わります。表情は既定ですべて真顔で作ります（表情を変えると顔立ちが変わりやすく、LoRA の素材では同じ人に見えることを優先するため。変えたいときは「詳細設定（上級者向け）」で）。
              日本語の入力は送るときに英訳します。
            </HelpNote>
            {/* 止めている間: 設定を変えたらここから一覧へ戻れるように（2026-09-30 ホスト指摘「行き来の距離が長い」）。 */}
            {phase === "paused" && run && remainingItems.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  updateRemaining((rest) => rebodyScenePlan(rest, sel, run.plan.length));
                  scrollToId("dataset-remaining");
                }}
                className="rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-4 py-2 text-xs font-semibold text-background hover:opacity-90"
              >
                この設定で「これから作る分」の文章を作り直して一覧へ戻る
              </button>
            )}
          </div>

          <div id="dataset-progress" className="scroll-mt-24 rounded-xl border border-border bg-background p-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-muted">
                枚数
                <input
                  type="number"
                  min={1}
                  max={SCENE_MAX_COUNT}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  className="w-20 rounded-lg border border-border bg-surface px-2 py-1 text-right text-sm text-foreground"
                />
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-muted">
                <input type="checkbox" checked={confirmFirst} onChange={(e) => setConfirmFirst(e.target.checked)} />
                最初の {firstBatch} 枚で一度確認してから残りを作る
              </label>
              <span className="ml-auto font-mono text-sm text-foreground">
                合計 <span className="text-neon-pink">{totalCost.toLocaleString()} C</span>
                <span className="ml-1 text-[10px] text-muted">
                  （1 枚 {perImage}C
                  {refRows > 0
                    ? `・真横／後ろの ${refRows} 枚は参照付きで ${Math.max(...previewPlan.map((it) => sceneItemCredits(it, knobs, batchOpt)))}C`
                    : ""}
                  ）
                </span>
              </span>
            </div>
            {confirmFirst && safeCount > SCENE_BATCH_SIZE && (
              <HelpNote
                id="dataset.first-batch"
                className="mt-1.5"
                summary={`まず ${firstBatch} 枚（${firstCost.toLocaleString()} C）を作って止まるので、仕上がりを確認してから「続きを作る」で残りを作れます（クレジットは作る分ずつ消費します）。`}
              >
                最初の {firstBatch} 枚に入れたい画像は、次に出る一覧で「先に作る」にチェックを入れて選べます。真横・後ろ向きの画像は参照付きで作るので、1 枚あたり 10 秒ほど長くかかります。
              </HelpNote>
            )}

            {busy && activeJob && activeJob.status === "pending" && (
              <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[11px] text-muted">
                <Loader2 size={12} className="animate-spin" />
                生成準備中…GPUを起動しています（初回は1〜2分ほどかかります・{formatElapsedSeconds(elapsedMs)}s）
              </p>
            )}
            {busy && activeJob && activeJob.status === "processing" && (
              <div className="mt-3">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-violet transition-[width] duration-500"
                    style={{ width: `${Math.max(4, (activeJob.completedAngles / Math.max(1, activeJob.totalAngles)) * 100)}%` }}
                  />
                </div>
                <p className="mt-1.5 text-center text-[11px] text-muted">
                  ジョブ {run ? run.jobIds.length : 0} / {runBatches.length}
                  <br />
                  このジョブ {activeJob.completedAngles} / {activeJob.totalAngles} 枚・全体 {producedTotal} / {plannedTotal} 枚（{formatElapsedSeconds(elapsedMs)}s）
                </p>
                <p className="mt-1 text-center text-[10px] text-muted/70">
                  全身・上半身・バストアップ・真横・後ろの行は 1 つのジョブにまとめて流れます（最初の確認分のあとは {run?.restBatchSize ?? LEGACY_SCENE_REST_BATCH_SIZE} 枚ずつ）。
                </p>
                {activeJob.vramUsedGb != null && (
                  <div className="mt-2 flex justify-center">
                    <VramBadge gb={activeJob.vramUsedGb} />
                  </div>
                )}
              </div>
            )}
            {phase === "submitting" && !activeJob && (
              <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted">
                <Loader2 size={12} className="animate-spin" /> 画像を送っています…（送り終わるまでこのタブは閉じないでください）
              </p>
            )}

            {!busy && gpuWarm && phase === "paused" && <WarmCountdownBanner remainingMs={gpuWarmMs} />}
            {phase === "paused" && run && remainingCount > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleContinue}
                  disabled={!image || (!creditsLoading && (credits ?? 0) < nextBatchCost)}
                  className="flex-1 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-5 py-3 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-50"
                >
                  続きを作る（残り {remainingCount} 枚・{remainingCost.toLocaleString()} C）
                </button>
                <button
                  type="button"
                  onClick={() => setPhase("done")}
                  className="rounded-xl border border-border px-4 py-3 text-xs text-muted hover:text-foreground"
                >
                  ここで止める
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="rounded-xl border border-border px-4 py-3 text-xs text-muted hover:text-foreground"
                >
                  新しく作る（この結果を消す）
                </button>
                {!image && <p className="w-full text-[10px] text-amber-400">続きを作るには、同じ画像をもう一度入れてください。</p>}
                <p className="w-full text-[10px] leading-relaxed text-muted">
                  残りの内容は、下の「これから作る分」で直せます（できた画像はそのまま残ります）。
                </p>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                disabled={busy || (!insufficientForFirst && (!image || phase === "review"))}
                className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                  insufficientForFirst ? "bg-amber-600/80 text-white hover:opacity-90" : "bg-gradient-to-r from-neon-pink to-neon-violet text-background hover:opacity-90 glow-pink"
                }`}
              >
                {user && insufficientForFirst && !busy ? <Zap size={16} /> : <Sparkles size={16} />}
                {!user
                  ? "ログインして作る"
                  : insufficientForFirst && !busy
                    ? "クレジットをチャージ"
                    : busy
                      ? "生成中…"
                      : phase === "review"
                        ? "下の一覧を確認してください"
                        : confirmFirst && safeCount > SCENE_BATCH_SIZE
                          ? `内容を確認する（無料）→ まず ${firstBatch} 枚 ${firstCost.toLocaleString()} C／全 ${safeCount} 枚 ${totalCost.toLocaleString()} C`
                          : `内容を確認する（無料）→ ${safeCount} 枚 ${totalCost.toLocaleString()} C`}
              </button>
            )}
            <GenerationCaveat />
            {errorMessage && <p className="mt-2 text-[11px] text-red-400">{errorMessage}</p>}
          </div>
        </div>
      </div>

      {/* 実行前の一覧（日本語で直せる） */}
      {phase === "review" && review.length > 0 && (
        <div id="dataset-review" className="scroll-mt-24 space-y-3 rounded-xl border border-neon-pink/40 bg-neon-pink/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-foreground">
              この {review.length} 枚を作ります（{SCENE_BATCH_SIZE} 枚ずつ・合計 {scenePlanCredits(review, knobs, batchOpt).toLocaleString()} C）
              <span
                className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${
                  firstKeys.size >= SCENE_BATCH_SIZE ? "border-neon-pink/60 bg-neon-pink/15 text-neon-pink" : "border-border text-muted"
                }`}
              >
                先に作る {firstKeys.size} / {SCENE_BATCH_SIZE}
              </span>
            </p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setPhase("idle")} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground">
                戻る
              </button>
              <button
                type="button"
                onClick={handleConfirmReview}
                className="rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-4 py-1.5 text-xs font-semibold text-background hover:opacity-90"
              >
                {(() => {
                  const ordered = orderPlanForBatches(review, batchOpt, firstKeys);
                  const first = ordered.plan.slice(0, ordered.prefixLen);
                  const jobs = checkBatchCount(ordered.plan, batchOpt, ordered.prefixLen);
                  return confirmFirst && review.length > first.length
                    ? `この内容でまず ${first.length} 枚を作る（${scenePlanCredits(first, knobs, batchOpt).toLocaleString()} C${jobs > 1 ? `・${jobs} 本に分けて連続` : ""}）`
                    : `この内容で ${review.length} 枚を作る（${scenePlanCredits(review, knobs, batchOpt).toLocaleString()} C）`;
                })()}
              </button>
            </div>
          </div>
          {(() => {
            const ordered = orderPlanForBatches(review, batchOpt, firstKeys);
            const jobs = checkBatchCount(ordered.plan, batchOpt, ordered.prefixLen);
            return (
              <HelpNote
                id="dataset.review" title="この一覧の直し方"
                summary={`各行の文は日本語のまま書き換えられます。「先に作る」にチェックを入れた画像は、最初の確認分（最大 ${SCENE_BATCH_SIZE} 枚）に入ります。`}
                notice={
                  jobs > 1 && (
                    <span className="text-amber-400">選んだ行が {SCENE_BATCH_SIZE} 枚を超えるため {jobs} 本のジョブに分かれます。</span>
                  )
                }
              >
                送るときに英訳します。構図・向きは各行の表示のとおり固定です。行を消すと枚数が減ります。
                {jobs > 1 ? "" : ` 全身・上半身・バストアップ・真横・後ろが混ざっていても 1 つのジョブで作ります。選ばなければ先頭の ${SCENE_BATCH_SIZE} 枚です。`}
                {derivedFlags.upper || derivedFlags.bust ? `「切り出し」の行は${activeBaseFull ? "基準の全身像" : "メイン画像"}から自動で切り出した寄りの画像を元に作ります。` : ""}
                {closeMain.upper != null || closeMain.bust != null ? "「寄り元 N」の行は手持ちの画像（参照 N）を元に作ります。" : ""}{subCount > 0 ? "「参照」の印の行だけ参照画像を付けて作ります（料金も参照付き）。実行はメインだけの行 → 寄り元の行 → 参照付きの行の順です。" : ""}
              </HelpNote>
            );
          })()}
          <ol className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
            {review.map((it, i) => (
              <li key={it.key} className={`flex items-center gap-2 rounded-md text-[11px] ${firstKeys.has(it.key) ? "bg-neon-pink/10" : ""}`}>
                <input
                  type="checkbox"
                  checked={firstKeys.has(it.key)}
                  disabled={!firstKeys.has(it.key) && firstKeys.size >= SCENE_BATCH_SIZE}
                  onChange={() =>
                    setFirstKeys((prev) => {
                      const next = new Set(prev);
                      if (next.has(it.key)) next.delete(it.key);
                      else next.add(it.key);
                      return next;
                    })
                  }
                  title="先に作る"
                  className="shrink-0"
                />
                <span className="w-6 shrink-0 text-right font-mono text-muted">{i + 1}</span>
                <span className="flex w-40 shrink-0 items-center gap-1 text-muted" title={scenePlanPreviewJa(it)}>
                  <span className="truncate">{scenePlanLabel({ ...it, custom: "", bodyJa: "" }).replace(/^（|）$/g, "")}</span>
                  {sceneItemGroup(it, batchOpt) === "refs" && <span className="shrink-0 rounded bg-neon-violet/20 px-1 text-[9px] text-neon-violet">参照</span>}
                  {closeMainIndexFor(it, batchOpt) !== null ? (
                    <span className="shrink-0 rounded bg-neon-pink/20 px-1 text-[9px] text-neon-pink">寄り元 {(closeMainIndexFor(it, batchOpt) ?? 0) + 1}</span>
                  ) : sceneItemUsesCloseSource(it, batchOpt) ? (
                    <span className="shrink-0 rounded bg-neon-pink/20 px-1 text-[9px] text-neon-pink">切り出し</span>
                  ) : null}
                </span>
                <span className="w-10 shrink-0 text-right font-mono text-[10px] text-muted">{sceneItemCredits(it, knobs, batchOpt)}C</span>
                <input
                  value={it.custom ?? it.bodyJa}
                  onChange={(e) => {
                    const v = e.target.value;
                    setReview((prev) => prev.map((x, k) => (k === i ? { ...x, custom: v === x.bodyJa ? undefined : v } : x)));
                  }}
                  className={`flex-1 rounded-md border px-2 py-1 text-foreground ${it.custom ? "border-neon-pink/50 bg-neon-pink/5" : "border-border bg-surface"}`}
                />
                <button
                  type="button"
                  onClick={() => setReview((prev) => prev.filter((_, k) => k !== i))}
                  aria-label="この行を消す"
                  className="shrink-0 text-muted hover:text-red-400"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* 止めている間の「これから作る分」（直してから続きを作れる） */}
      {phase === "paused" && run && remainingItems.length > 0 && (
        <div id="dataset-remaining" className="scroll-mt-24 space-y-3 rounded-xl border border-border bg-background p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-foreground">
              これから作る分 {remainingItems.length} 枚（{remainingCost.toLocaleString()} C）
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => scrollToId("dataset-scene")}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface"
              >
                シーン設定へ移動
              </button>
              <button
                type="button"
                onClick={() => updateRemaining((rest) => rebodyScenePlan(rest, sel, run.plan.length))}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface"
              >
                文章を作り直す（先にシーン設定を変えてください）
              </button>
            </div>
          </div>
          <HelpNote id="dataset.remaining" title="残りの直し方" summary="各行の文を書き換えるか、× で消して直せます。できた画像はそのまま残ります。">
            まとめて変えるときは、シーン設定（ポーズ・場面・服装など）を変えてから「文章を作り直す」を押すと、この一覧に反映されます。構図・向きは変わりません。
          </HelpNote>
          <ol className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
            {remainingItems.map((it, i) => (
              <li key={it.key} className="flex items-center gap-2 text-[11px]">
                <span className="w-6 shrink-0 text-right font-mono text-muted">{i + 1}</span>
                <span className="w-40 shrink-0 truncate text-muted" title={scenePlanPreviewJa(it)}>
                  {scenePlanLabel({ ...it, custom: "", bodyJa: "" }).replace(/^（|）$/g, "")}
                </span>
                <span className="w-10 shrink-0 text-right font-mono text-[10px] text-muted">{sceneItemCredits(it, knobs, runOpt)}C</span>
                <input
                  value={it.custom ?? it.bodyJa}
                  onChange={(e) => {
                    const v = e.target.value;
                    updateRemaining((rest) => rest.map((x, k) => (k === i ? { ...x, custom: v === x.bodyJa ? undefined : v } : x)));
                  }}
                  className={`flex-1 rounded-md border px-2 py-1 text-foreground ${it.custom ? "border-neon-pink/50 bg-neon-pink/5" : "border-border bg-surface"}`}
                />
                <button
                  type="button"
                  onClick={() => updateRemaining((rest) => rest.filter((_, k) => k !== i))}
                  disabled={remainingItems.length <= 1}
                  aria-label="この行を消す"
                  className="shrink-0 text-muted hover:text-red-400 disabled:opacity-30"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ol>
          {/* 直したらその場で続けられるように（上の進捗欄の「続きを作る」と同じ動作）。 */}
          <button
            type="button"
            onClick={handleContinue}
            disabled={!image || (!creditsLoading && (credits ?? 0) < nextBatchCost)}
            className="w-full rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-5 py-3 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-50"
          >
            この内容で続きを作る（残り {remainingCount} 枚・{remainingCost.toLocaleString()} C）
          </button>
          {!image && <p className="text-[10px] text-amber-400">続きを作るには、同じ画像をもう一度入れてください。</p>}
        </div>
      )}

      {/* 結果（生成が始まったら、1 枚目ができる前から枠を出してスクロール先にする） */}
      {results.length === 0 && run && busy && (
        <div id="dataset-results" className="scroll-mt-24 rounded-xl border border-neon-pink/40 bg-neon-pink/5 p-4">
          <p className="flex items-center gap-2 text-xs font-medium text-foreground">
            <Loader2 size={14} className="animate-spin text-neon-pink" />
            {run && run.confirmFirst && !run.confirmed
              ? `生成中です。まず ${Math.min(run.prefixLen, plannedTotal)} 枚を作って止まります（全体の予定は ${plannedTotal} 枚）。できた画像から順にここへ並びます。`
              : `生成中です。できた画像から順にここへ並びます（全 ${plannedTotal} 枚）。`}
          </p>
        </div>
      )}
      {results.length > 0 && (
        <div id="dataset-results" className="scroll-mt-24 space-y-3 rounded-xl border border-border bg-background p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-foreground">
              できた素材 {results.length} 枚{plannedTotal > results.length ? `（予定 ${plannedTotal} 枚）` : ""}
              {rejected.size > 0 && <span className="ml-1 text-muted">・外した {rejected.size} 枚</span>}
              {!busy && (
                <button type="button" onClick={handleReset} className="ml-3 text-[11px] text-muted underline hover:text-foreground">
                  新しく作る（この結果を消す）
                </button>
              )}
            </p>
            {/* 進み具合はここにも出す（2026-10-03 ホスト指摘: 一覧の下の「続きを作る」を押すとここへ移るが、進捗は上の欄にしか無く何が起きているか分からなかった）。 */}
            {phase === "submitting" && (
              <p className="flex items-center gap-1.5 text-[11px] text-muted">
                <Loader2 size={12} className="animate-spin" /> 画像を送っています…（送り終わるまでこのタブは閉じないでください）
              </p>
            )}
            {phase === "running" && (
              <p className="flex items-center gap-1.5 text-[11px] text-muted">
                <Loader2 size={12} className="animate-spin text-neon-pink" />
                {activeJob?.status === "processing"
                  ? `生成中: 全体 ${producedTotal} / ${plannedTotal} 枚（ジョブ ${run ? run.jobIds.length : 0} / ${runBatches.length}・${formatElapsedSeconds(elapsedMs)}s）`
                  : "生成準備中…GPUを起動しています（初回は1〜2分ほどかかります）"}
              </p>
            )}
            {/* 全部できてから（または「ここで止める」の後で）まとめて保存・LoRA へ（2026-09-27、ホスト指摘）。 */}
            {(phase === "done" || phase === "paused") && (
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => setRejected(new Set())} className="text-[11px] text-muted hover:text-foreground">
                  全部使う
                </button>
                {/* ZIP は途中（8 枚で止まっている間）でも押せる。LoRA へ送るのは全部できてから。 */}
                <button
                  type="button"
                  onClick={() => void downloadZip()}
                  disabled={zipping || kept.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface disabled:opacity-50"
                >
                  {zipping ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                  {kept.length} 枚を ZIP で保存
                </button>
                {phase === "done" && (
                <button
                  type="button"
                  onClick={sendToLora}
                  disabled={sending || kept.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-1.5 text-xs font-semibold text-background hover:opacity-90 disabled:opacity-50"
                >
                  {sending ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                  {kept.length + (mainRoute === "face" && sendOriginal && image ? 1 : 0)} 枚を LoRA Studio に追加
                </button>
                )}
                {phase === "done" && mainRoute === "face" && image && (
                  <label className="inline-flex items-center gap-1 text-[11px] text-muted">
                    <input type="checkbox" checked={sendOriginal} onChange={(e) => setSendOriginal(e.target.checked)} />
                    元の顔アップも一緒に送る（顔の細部を学ばせるため推奨）
                  </label>
                )}
              </div>
            )}
          </div>
          <HelpNote id="dataset.results" title="画像の外し方" summary="使わない画像は、サムネの右上の × で外せます（もう一度押すと戻ります）。">
            クリックで拡大（拡大中は「この画像を外す」か x キー）。外した画像は保存・LoRA の対象になりません（料金は生成した分にかかります）。
          </HelpNote>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {results.map((r, i) => {
              const off = rejected.has(r.key);
              return (
                <div
                  key={r.key}
                  className={`relative aspect-[4/5] overflow-hidden rounded-lg border-2 ${off ? "border-transparent opacity-40 grayscale" : "border-neon-pink/60"}`}
                >
                  <button type="button" onClick={() => setLightboxIndex(i)} title={`拡大: ${r.label}`} className="group block h-full w-full cursor-zoom-in">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`${r.url}${reloads[r.key] ? `#r${reloads[r.key]}` : ""}`}
                      alt={r.label}
                      className="h-full w-full bg-black/40 object-contain"
                      onError={() => refreshResultUrl(r)}
                    />
                    <span className="pointer-events-none absolute left-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-80 transition-opacity group-hover:opacity-100">
                      <ZoomIn size={11} />
                    </span>
                  </button>
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-[9px] text-white">{r.label}</span>
                  <button
                    type="button"
                    onClick={() => toggleRejected(r.key)}
                    title={off ? "戻す" : "外す"}
                    className={`absolute right-1 top-1 rounded-full p-1 text-background ${off ? "bg-black/70" : "bg-neon-pink"}`}
                  >
                    {off ? <Check size={11} /> : <X size={11} />}
                  </button>
                </div>
              );
            })}
          </div>
          {phase === "done" && (
            <p className="text-[10px] text-muted">
              <ImagePlus size={10} className="mr-1 inline" />
              足りなければ、枚数を入れてもう一度作れます（前の結果は新しい指定で入れ替わります。必要な分は先に保存するか LoRA Studio へ送ってください）。
            </p>
          )}
        </div>
      )}

      {localPreview && (
        <AngleLightbox
          items={[localPreview]}
          index={0}
          onIndexChange={() => undefined}
          onClose={() => setLocalPreview(null)}
          onSave={() => {
            const a = document.createElement("a");
            a.href = localPreview.url;
            a.download = `${localPreview.label}.png`;
            document.body.appendChild(a);
            a.click();
            a.remove();
          }}
          onImageError={() => undefined}
        />
      )}
      {lightboxIndex != null && results[lightboxIndex] && (
        <AngleLightbox
          items={lightItems}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onSave={(i) => void saveOne(results[i])}
          onUpscale={(i) => void upscaleOne(results[i])}
          compare={imagePreview ? { url: imagePreview, label: "元の画像" } : null}
          onImageError={() => {
            const r = results[lightboxIndex];
            if (r) refreshResultUrl(r);
          }}
          onToggleExclude={(i) => {
            const r = results[i];
            if (r) toggleRejected(r.key);
          }}
          isExcluded={(i) => {
            const r = results[i];
            return Boolean(r && rejected.has(r.key));
          }}
        />
      )}

      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} message="素材づくりを使うにはログインしてください。" />
      <InsufficientCreditsModal open={chargeOpen} onClose={() => setChargeOpen(false)} credits={credits} cost={firstCost} />
    </div>
  );
}
