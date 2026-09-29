"use client";

// 素材づくり（2026-09-27、ホスト構想）: 1 枚の画像（＋参照最大 3 枚）から、ポーズ・場面・構図・向きを
// 変えた画像を指定枚数つくり、選んで LoRA Studio へ送る。マルチアングルと同じワーカー・同じ課金。
// 8 枚ずつのジョブに分けて順に投げ、最初の 1 ジョブで方向を確認してから残りを作る（既定）。
// 生成した画像は次の参照に使わない（ユーザーが選んだ参照だけを毎回使う）ので、ずれが連鎖しない。
//
// CLAUDE.md §6 のチェックリスト: ジョブはリロードで消えない（RUN_KEY）／「見つからない」は専用エラー／
// VramBadge／起動待ち表示／結果 URL は使い回さない（fresh URL で取り直し）／サムネは切り抜かない。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { Check, Download, ImagePlus, Loader2, Sparkles, Wand2, X, Zap, ZoomIn } from "lucide-react";
import { MAX_SUB_REFERENCE_IMAGES } from "@/lib/angleStudio";
import {
  AngleJobNotFoundError,
  fetchAngleImageBlob,
  freshAngleImageUrl,
  pollAngleJob,
  startAngleJob,
  type AngleApiError,
  type AngleJob,
} from "@/lib/angleApi";
import {
  buildScenePlan,
  CHIPS_BY_AXIS,
  checkBatchCount,
  closeMainIndexFor,
  sceneItemUsesCloseSource,
  orderPlanForBatches,
  planBatches,
  sceneItemCredits,
  sceneItemGroup,
  scenePlanCredits,
  type CloseFraming,
  type CloseMainMap,
  DEFAULT_SCENE_SELECTION,
  SCENE_BATCH_SIZE,
  SCENE_DEFAULT_COUNT,
  SCENE_MAX_COUNT,
  SCENE_REST_BATCH_SIZE,
  sceneCreditsPerImage,
  scenePlanInstruction,
  scenePlanLabel,
  scenePlanPreviewJa,
  type SceneAxis,
  type ScenePlanItem,
  type SceneSelection,
  DEFAULT_SCENE_RATIOS,
  effectiveRatios,
  EMPTY_BODY_DESIGN,
  bodyDesignBlockedReason,
  bodyDesignSpecs,
  mainRouteOf,
  type BodyDesign,
  type MainRoute,
} from "@/lib/datasetBuilder";
import { BodyDesignForm } from "@/components/studio/BodyDesignForm";
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
type FilesMeta = { subCount: number; backIndex: number | null; sideIndex: number | null; hasBaseFull: boolean };
const POLL_MS = 2_000;

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
};

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
  const effectiveMain = baseFull ?? image;
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
  const [picks, setPicks] = useState<{ full?: CandidatePick | null; back?: CandidatePick | null; side?: CandidatePick | null }>(
    () => loadFormState<{ full?: CandidatePick | null; back?: CandidatePick | null; side?: CandidatePick | null }>(PICKS_KEY) ?? {},
  );
  useEffect(() => {
    saveFormState(PICKS_KEY, picks);
  }, [picks]);
  const [refBack, setRefBack] = useState<File | null>(null);
  const [refSide, setRefSide] = useState<File | null>(null);
  // submitBatch（useCallback）から今の参照を読むための ref。
  const refBackRef = useRef<File | null>(null);
  const refSideRef = useRef<File | null>(null);
  useEffect(() => {
    refBackRef.current = refBack;
    refSideRef.current = refSide;
  }, [refBack, refSide]);
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
  const [restorePending, setRestorePending] = useState<{ main: File; subs: File[]; base: File | null; meta: FilesMeta } | null>(null);
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
      // 読めたら聞く。restoringRef は決めるまで立てたまま（保存を止める）。
      setRestorePending({ main, subs, base, meta: meta as FilesMeta });
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
    };
    saveFormState(FILES_META_KEY, meta);
    void (async () => {
      await fileStorePut(`${FILES_PREFIX}main`, image);
      for (let i = 0; i < MAX_SUB_REFERENCE_IMAGES; i++) await fileStorePut(`${FILES_PREFIX}sub${i}`, subImages[i] ?? null);
      await fileStorePut(`${FILES_PREFIX}baseFull`, baseFull);
    })();
  }, [image, subImages, baseFull, refBack, refSide]);

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
  const [bodyDesign, setBodyDesign] = useState<BodyDesign>(() => ({ ...EMPTY_BODY_DESIGN, ...(savedForm?.body ?? {}) }));
  const [routeOverride, setRouteOverride] = useState<MainRoute | "auto">(() => savedForm?.routeOverride ?? "auto");
  const [sendOriginal, setSendOriginal] = useState<boolean>(() => savedForm?.sendOriginal ?? true);
  const [hairNote, setHairNote] = useState<string>(() => savedForm?.hairNote ?? "");
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
    } satisfies PersistedForm);
  }, [sel, count, confirmFirst, bodyDesign, routeOverride, mainFraming, sendOriginal, hairNote]);

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
  const batchOpt = useMemo(
    () => ({ subCount, closeMain, derived: derivedFlags, hasBackRef: Boolean(refBack), hasSideRef: Boolean(refSide) }),
    [subCount, closeMain, derivedFlags, refBack, refSide],
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
  const needsBaseFull = Boolean(image) && !baseFull && !deriving && mainRoute !== null && mainRoute !== "full";
  // 真横 → 後ろ姿の順（2026-09-29）。一覧に真横があれば、後ろ姿は確定した真横を添えて作る（髪を真横に揃える）。
  const sideInPlan = viewsInPlan.has("side");
  const backUsesSide = Boolean(refSide) || sideInPlan;
  const backBlocked = backUsesSide && !refSide ? "先に上の「真横の参照」を確定してください（後ろ髪を真横に揃えるため）。" : null;
  const sideSpecs = useMemo(() => sideViewSpecs(hairNote), [hairNote]);
  const backSpecs = useMemo(() => backViewSpecs(hairNote, backUsesSide), [hairNote, backUsesSide]);
  const baseFullSpecs = useMemo(
    () => (mainRoute === "face" || mainRoute === "upper" ? bodyDesignSpecs(bodyDesign, mainRoute) : FULL_BODY_SPECS),
    [mainRoute, bodyDesign],
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
      const opt = { subCount: r.subCount, closeMain: r.closeMain, derived: r.derived, hasBackRef: r.hasBackRef, hasSideRef: r.hasSideRef };
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
      const refsOf = (it: ScenePlanItem): File[] => {
        if (it.viewId === "back") return refBackRef.current ? [refBackRef.current] : subs;
        if (it.viewId === "side") return refSideRef.current ? [refSideRef.current] : subs;
        return [];
      };
      const sets: File[][] = [];
      const setIndex = (files: File[]) => {
        const found = sets.findIndex((st) => st.length === files.length && st.every((f, k) => f === files[k]));
        if (found >= 0) return found;
        sets.push(files);
        return sets.length - 1;
      };
      const scenes = items.map((it) => ({
        instruction: scenePlanInstruction(it),
        label: scenePlanLabel(it),
        set: setIndex([sourceOf(it), ...refsOf(it)]),
      }));
      setPhase("submitting");
      setErrorMessage(null);
      // 候補づくりが動いていれば、終わるまで待ってから投げる（追加料金なし・温かいまま始まる）。
      gpuReleaseRef.current = await gpuLock.acquire();
      try {
        const res = await startAngleJob({
          userId: user.id,
          image: main,
          subImages: [],
          selection: { azimuths: [], elevations: [], distances: [] },
          mode: "standard",
          scenes,
          imageSets: sets,
        });
        broadcastCreditsUpdate(user.id, res.remainingCredits);
        const next: PersistedRun = { ...r, jobIds: [...r.jobIds, res.jobId] };
        commitRun(next);
        setPhase("running");
      } catch (err) {
        gpuReleaseRef.current?.();
        gpuReleaseRef.current = null;
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
    [user, commitRun, perImage, gpuLock],
  );
  const runOpt = useMemo(
    () =>
      run
        ? { subCount: run.subCount, closeMain: run.closeMain, derived: run.derived, hasBackRef: run.hasBackRef, hasSideRef: run.hasSideRef }
        : { subCount: 0, closeMain: {}, derived: {} },
    [run],
  );
  const runBatches = useMemo(() => (run ? planBatches(run.plan, runOpt, run.prefixLen) : []), [run, runOpt]);

  // 一覧や進捗の位置へスクロールする（2026-09-28、ホスト指摘「押した場所に取り残される」）。
  const scrollToId = (id: string) =>
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  // 「作る」→ まず一覧（日本語）を出して直せるようにする（2026-09-27、ホスト指摘「どんなプロンプトで作られるか分からない」）。
  const handleStart = () => {
    if (!user) return setLoginOpen(true);
    // 不足なら入力前でもチャージへ（全タブ共通、2026-09-28）。
    if (!busy && insufficientForFirst) return setChargeOpen(true);
    if (!image) return;
    if (needsBaseFull) {
      setErrorMessage("メイン画像に全身が写っていません。先に「基準の全身を作る」で 1 枚選んでください。");
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
      prefixLen: ordered.prefixLen,
      hasBackRef: Boolean(refBack),
      hasSideRef: Boolean(refSide),
    };
    setJobs({});
    commitRun(r);
    void submitBatch(r, 0, image, subImages);
    scrollToId("dataset-progress");
  };

  const handleContinue = () => {
    const r = runRef.current;
    if (!r || !image) return;
    const next = { ...r, confirmed: true };
    commitRun(next);
    void submitBatch(next, next.jobIds.length, image, subImages);
    scrollToId("dataset-progress");
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
            const rOpt = { subCount: r.subCount, closeMain: r.closeMain, derived: r.derived, hasBackRef: r.hasBackRef, hasSideRef: r.hasSideRef };
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
      blobs.forEach((b, n) => zip.file(fileName(kept[n], n), b));
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
                (restorePending.base ? "・基準の全身 1 枚" : "")
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
          {imageError && <p className="text-[11px] text-red-400">{imageError}</p>}
          <SubReferenceSlots
            files={subImages}
            onAdd={handleAddSub}
            onRemove={(i) => setSubImages((p) => p.filter((_, k) => k !== i))}
            error={subError}
            onZoom={(i, url) => setLocalPreview({ url, label: `参照 ${i + 1}` })}
          />
          <p className="text-[11px] leading-relaxed text-muted/80">
            メインの画像からは分からない後ろ姿・真横があれば参照に足してください。参照は真横・後ろ向きの画像にだけ使い、正面・斜めの画像はメイン 1 枚で作ります（そのぶん速く・安く）。
          </p>
          {image && (
            <div className="space-y-2 rounded-lg border border-neon-violet/30 bg-neon-violet/5 px-3 py-2">
              <p className="text-[11px] font-medium text-foreground">素材づくりの基準にする画像</p>
              <p className="text-[10px] leading-relaxed text-muted">
                全身の画像は{baseFull ? "確定した基準の全身" : "メイン画像"}を、上半身・バストアップの画像は下の画像を基準に作ります。
                上半身・バストアップの基準は、{baseFull ? "基準の全身" : "メイン画像"}から自動で切り出します（無料・切り出しの解像度は仕上がりに影響しません）。
                参照画像のほうが基準に向いていれば、そちらを使うこともできます。
              </p>
              {deriving && (
                <p className="flex items-center gap-1.5 text-[10px] text-muted">
                  <Loader2 size={10} className="animate-spin" /> {baseFull ? "基準の全身" : "メイン画像"}から切り出しています…
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
                        title={auto ? "" : "メイン画像から切り出せませんでした（人物が検出できないか、既に寄っています）"}
                        className={`${chip(choice === "auto")} disabled:opacity-40`}
                      >
                        自動で切り出し
                      </button>
                      <button type="button" onClick={() => setCloseChoice((p) => ({ ...p, [f]: "main" }))} className={chip(choice === "main")}>
                        メインのまま
                      </button>
                      {subImages.map((file, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setCloseChoice((p) => ({ ...p, [f]: i }))}
                          className={chip(choice === i)}
                          title={file.name}
                        >
                          参照 {i + 1}
                        </button>
                      ))}
                      {!auto && !deriving && choice === "auto" && (
                        <span className="w-full text-[10px] text-amber-400">
                          切り出せなかったので「メインのまま」で作ります{derived.reason ? `（${derived.reason}）` : ""}。寄った画像を参照に入れて選ぶこともできます。
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
          {/* 参照づくり（段階 1・3）: 全身が無ければ基準の全身を、真横・後ろの行があれば参照を、候補から選んで確定する。 */}
          {image && (needsBaseFull || baseFull) && (
            <CandidatePanel
              title={baseFull ? "基準の全身（確定済み）" : "基準の全身を作る"}
              description={
                baseFull
                  ? "これから作る全身の画像はこの全身を元に、上半身・バストアップの画像はこの全身から自動で切り出した寄りの画像を元に作ります。別の候補に替えることもできます。"
                  : mainRoute === "face"
                    ? "顔だけの画像なので、まず体と服を決めて全身の候補を作り、気に入った 1 枚を選んでください。候補ごとに顔の雰囲気が少しずつ違うので、いちばんイメージに合う顔を選ぶのがコツです。選んだ全身が以後の全部の行の元になります。"
                    : "メイン画像に足元まで写っていないので、まず全身の候補を作って 1 枚選んでください。体つき・服装はここで確定し、以後の全部の行の元になります。"
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
              {!baseFull && (mainRoute === "face" || mainRoute === "upper") && (
                <BodyDesignForm design={bodyDesign} onChange={setBodyDesign} route={mainRoute} />
              )}
            </CandidatePanel>
          )}
          {effectiveMain && (viewsInPlan.has("side") || refSide) && (
            <CandidatePanel
              title={refSide ? "真横の参照（確定済み）" : "真横の参照を作る"}
              description="真横向きの画像は、ここで選んだ真横を参照にして作ります。顔がいちばんイメージに近い 1 枚を選んでください（後ろ姿はこの真横の髪に揃えます）。後ろ髪の長さや結び方を決めたいときは下の欄に書いてください。手持ちの真横があればそれでも構いません。選ぶと参照欄に入ります。"
              user={user}
              image={effectiveMain}
              specs={sideSpecs}
              costPerImage={perImage}
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
                <label className="flex flex-wrap items-center gap-1 text-[10px] text-muted">
                  後ろ髪の指定（任意・日本語可）
                  <input
                    type="text"
                    value={hairNote}
                    onChange={(e) => setHairNote(e.target.value)}
                    placeholder="例: 腰までのストレート／襟足は刈り上げ／低い位置で一つ結び"
                    maxLength={120}
                    className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[11px] text-foreground placeholder:text-muted/60"
                  />
                </label>
              )}
            </CandidatePanel>
          )}
          {effectiveMain && (viewsInPlan.has("back") || refBack) && (
            <CandidatePanel
              title={refBack ? "後ろ姿の参照（確定済み）" : "後ろ姿の参照を作る"}
              description={
                backUsesSide
                  ? "後ろ向きの画像は、ここで選んだ後ろ姿を参照にして作ります。候補は確定した真横を一緒に見せて、後ろ髪の長さ・形を真横に揃えます。手持ちの後ろ姿があればそれでも構いません。選ぶと参照欄に入ります。"
                  : "後ろ向きの画像は、ここで選んだ後ろ姿を参照にして作ります（選ばないと毎回ちがう背中になります）。手持ちの後ろ姿があればそれを、無ければ候補を作って選びます。選ぶと参照欄に入ります。"
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
          <div className="grid gap-4 rounded-xl border border-border bg-background p-4">
            {(["poses", "places", "framings", "views", "expressions", "outfits"] as SceneAxis[]).map((axis) => (
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
            <p className="text-[11px] leading-relaxed text-muted/70">
              選んだ組み合わせを順に回して枚数ぶん作ります。未選択の軸は既定（立つ・無地・全身・正面・真顔・元の服装）になります。
              表情・服装は 1 枚ごとに順に変わります（後ろ向きの画像に表情は付けません）。日本語の入力は送るときに英訳します。
            </p>
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
              <p className="mt-1.5 text-[10px] text-muted">
                まず {firstBatch} 枚（{firstCost.toLocaleString()} C）を作って止まります（一覧で「先に作る」を選べばその行になります）。良ければ「続きを作る」で残りを作ります。クレジットは作る分ずつ消費します。
                真横・後ろの行は参照 1 枚付き（後ろ姿・真横を確定していれば）で、1 枚あたり 10 秒ほど長くかかります。
              </p>
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
                  全身・上半身・バストアップ・真横・後ろの行は 1 つのジョブにまとめて流れます（最初の確認分のあとは {SCENE_REST_BATCH_SIZE} 枚ずつ）。
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
                <Loader2 size={12} className="animate-spin" /> 画像を送っています…
              </p>
            )}

            {!busy && gpuWarm && phase === "paused" && <WarmCountdownBanner remainingMs={gpuWarmMs} />}
            {phase === "paused" && run && remainingCount > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleContinue}
                  disabled={!image || (!creditsLoading && (credits ?? 0) < nextBatchCost)}
                  className="flex-1 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-5 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
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
              </div>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                disabled={busy || (!insufficientForFirst && (!image || phase === "review"))}
                className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-sm font-semibold text-white transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                  insufficientForFirst ? "bg-amber-600/80 hover:opacity-90" : "bg-gradient-to-r from-neon-pink to-neon-violet hover:opacity-90 glow-pink"
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
                className="rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90"
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
          <p className="text-[10px] leading-relaxed text-muted">
            各行の文を書き換えられます（日本語のまま。送るときに英訳します）。構図・向きは左の表示のとおり固定です。
            行を消すと枚数が減ります。左のチェックで「先に作る」行を選ぶと、選んだ行だけを先に作って止まります（最大 {SCENE_BATCH_SIZE} 枚）。
            {(() => {
              const ordered = orderPlanForBatches(review, batchOpt, firstKeys);
              const jobs = checkBatchCount(ordered.plan, batchOpt, ordered.prefixLen);
              return jobs > 1 ? (
                <span className="text-amber-400"> 選んだ行が {SCENE_BATCH_SIZE} 枚を超えるため {jobs} 本のジョブに分かれます。</span>
              ) : (
                <span> 全身・上半身・バストアップ・真横・後ろが混ざっていても 1 つのジョブで作ります。選ばなければ先頭の {SCENE_BATCH_SIZE} 枚です。</span>
              );
            })()}
            {derivedFlags.upper || derivedFlags.bust ? "「切り出し」の行はメイン画像から自動で切り出した寄りの画像を元に作ります。" : ""}
            {closeMain.upper != null || closeMain.bust != null ? "「寄り元 N」の行は参照 N を元に作ります。" : ""}{subCount > 0 ? "「参照」の印の行だけ参照画像を付けて作ります（料金も参照付き）。実行はメインだけの行 → 寄り元の行 → 参照付きの行の順です。" : ""}
          </p>
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

      {/* 結果 */}
      {results.length > 0 && (
        <div className="space-y-3 rounded-xl border border-border bg-background p-4">
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
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
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
          <p className="text-[10px] text-muted">
            クリックで拡大（拡大中は「この画像を外す」か x キー）。サムネの右上の × でも外す／戻す。外した画像は保存・LoRA の対象になりません（料金は生成した分にかかります）。
          </p>
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
                    className={`absolute right-1 top-1 rounded-full p-1 text-white ${off ? "bg-black/70" : "bg-neon-pink"}`}
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
