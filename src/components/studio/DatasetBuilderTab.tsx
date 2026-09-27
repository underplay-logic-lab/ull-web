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
import { Check, Download, ImagePlus, Loader2, Sparkles, Wand2, X, ZoomIn } from "lucide-react";
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
  sceneCreditsPerImage,
  scenePlanInstruction,
  scenePlanLabel,
  scenePlanPreviewJa,
  type SceneAxis,
  type ScenePlanItem,
  type SceneSelection,
} from "@/lib/datasetBuilder";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
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
  BACK_VIEW_SPECS,
  CandidatePanel,
  createGpuLock,
  FULL_BODY_SPECS,
  SIDE_VIEW_SPECS,
  type CandidatePick,
} from "@/components/studio/DatasetRefBuilder";
import { WarmCountdownBanner } from "@/components/studio/QueueChoiceModal";

const FORM_ID = "dataset-builder";
const RUN_KEY = "dataset-builder-run";
// 画像（メイン・参照・基準の全身）は IndexedDB に保存してリロード後に戻す（2026-09-28）。
const FILES_PREFIX = "dataset-builder:";
const FILES_META_KEY = "dataset-builder-files";
type FilesMeta = { subCount: number; backIndex: number | null; sideIndex: number | null; hasBaseFull: boolean };
const POLL_MS = 2_000;

type PersistedForm = { sel: SceneSelection; count: number; confirmFirst: boolean };
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
};

type Phase = "idle" | "review" | "submitting" | "running" | "paused" | "done" | "error";

const AXIS_TITLE: Record<SceneAxis, string> = {
  poses: "ポーズ",
  places: "場面",
  framings: "構図",
  views: "向き",
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
}) {
  const set = new Set(selected);
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
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CHIPS_BY_AXIS[axis].map((c) => (
          <button
            key={c.id}
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
    deriveFramingSources(effectiveMain)
      .then((src) => {
        if (!alive) return;
        derivedRef.current = src;
        setDerived(src);
      })
      .finally(() => {
        if (alive) setDeriving(false);
      });
    return () => {
      alive = false;
    };
  }, [effectiveMain]);
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
  const restoredFilesRef = useRef(false);
  const restoringRef = useRef(false);
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
      setImage(main);
      setSubImages(subs);
      if (base) setBaseFull(base);
      if (meta.backIndex != null && subs[meta.backIndex]) setRefBack(subs[meta.backIndex]);
      if (meta.sideIndex != null && subs[meta.sideIndex]) setRefSide(subs[meta.sideIndex]);
      restoringRef.current = false;
    })();
  }, [setImage, setSubImages]);
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
  useEffect(() => {
    saveFormState(FORM_ID, { sel, count, confirmFirst } satisfies PersistedForm);
  }, [sel, count, confirmFirst]);

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
      // 新しいメインなら基準の全身と選んだ参照はやり直し。
      setBaseFull(null);
      setPicks({});
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
  const perImageRefs = sceneCreditsPerImage(knobs, subCount);
  const safeCount = Math.max(1, Math.min(SCENE_MAX_COUNT, Math.trunc(count || 0)));
  const batchOpt = useMemo(() => ({ subCount, closeMain, derived: derivedFlags }), [subCount, closeMain, derivedFlags]);
  // 料金は行ごと（参照が要る向きだけ係数付き）。指定を変えるたびに計画を組み直して見積もる。
  const previewOrdered = useMemo(() => orderPlanForBatches(buildScenePlan(sel, safeCount), batchOpt), [sel, safeCount, batchOpt]);
  const previewPlan = previewOrdered.plan;
  const totalCost = scenePlanCredits(previewPlan, knobs, batchOpt);
  const firstBatch = Math.min(previewOrdered.prefixLen, previewPlan.length);
  const firstCost = scenePlanCredits(previewPlan.slice(0, firstBatch), knobs, batchOpt);
  const refRows = previewPlan.filter((it) => sceneItemGroup(it, batchOpt) === "refs").length;
  const framingsInPlan = new Set(previewPlan.map((it) => it.framingId));
  const viewsInPlan = new Set(previewPlan.map((it) => it.viewId));
  const needsBaseFull = Boolean(image) && !baseFull && !deriving && derived.framing !== undefined && derived.framing !== "full";
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
      const opt = { subCount: r.subCount, closeMain: r.closeMain, derived: r.derived };
      const batch = planBatches(r.plan, opt, r.prefixLen)[batchIndex];
      const items = batch?.items;
      if (!items) return;
      // 寄りの行は「寄りの元画像」（参照の指定 → 自動切り出し の順）をメインにして参照なし。
      // 参照付きの行はメイン＋参照。それ以外はメインだけ。
      let closeFile: File | null = null;
      if (batch.group.startsWith("close")) {
        const f = items[0].framingId as CloseFraming;
        const closeIdx = closeMainIndexFor(items[0], opt);
        closeFile = closeIdx !== null ? subs[closeIdx] : (derivedRef.current[f] ?? null);
        if (!closeFile) {
          setErrorMessage(`${f === "upper" ? "上半身" : "バストアップ"}の元画像がありません。画像を入れ直すか、参照から選んでください。`);
          setPhase("paused");
          return;
        }
      }
      setPhase("submitting");
      setErrorMessage(null);
      // 候補づくりが動いていれば、終わるまで待ってから投げる（追加料金なし・温かいまま始まる）。
      gpuReleaseRef.current = await gpuLock.acquire();
      try {
        const res = await startAngleJob({
          userId: user.id,
          image: closeFile ?? effectiveMainRef.current ?? mainFile,
          subImages: batch.useRefs ? subs : [],
          selection: { azimuths: [], elevations: [], distances: [] },
          mode: "standard",
          scenes: items.map((it) => ({ instruction: scenePlanInstruction(it), label: scenePlanLabel(it) })),
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
    () => (run ? { subCount: run.subCount, closeMain: run.closeMain, derived: run.derived } : { subCount: 0, closeMain: {}, derived: {} }),
    [run],
  );
  const runBatches = useMemo(() => (run ? planBatches(run.plan, runOpt, run.prefixLen) : []), [run, runOpt]);

  // 「作る」→ まず一覧（日本語）を出して直せるようにする（2026-09-27、ホスト指摘「どんなプロンプトで作られるか分からない」）。
  const handleStart = () => {
    if (!user) return setLoginOpen(true);
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
    };
    setJobs({});
    commitRun(r);
    void submitBatch(r, 0, image, subImages);
  };

  const handleContinue = () => {
    const r = runRef.current;
    if (!r || !image) return;
    const next = { ...r, confirmed: true };
    commitRun(next);
    void submitBatch(next, next.jobIds.length, image, subImages);
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
            const rOpt = { subCount: r.subCount, closeMain: r.closeMain, derived: r.derived };
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
          <ImageDropzone
            file={image}
            previewUrl={imagePreview}
            onFileSelected={handleImageSelected}
            onClear={() => {
              setImage(null);
              setBaseFull(null);
              setPicks({});
              void fileStoreClear(FILES_PREFIX);
            }}
          />
          {imageError && <p className="text-[11px] text-red-400">{imageError}</p>}
          <SubReferenceSlots files={subImages} onAdd={handleAddSub} onRemove={(i) => setSubImages((p) => p.filter((_, k) => k !== i))} error={subError} />
          <p className="text-[11px] leading-relaxed text-muted/80">
            メインの画像からは分からない後ろ姿・真横があれば参照に足してください。参照は「真横・後ろ」の行にだけ使い、正面・斜めの行はメイン 1 枚で作ります（そのぶん速く・安く）。
          </p>
          {image && (
            <div className="space-y-2 rounded-lg border border-neon-violet/30 bg-neon-violet/5 px-3 py-2">
              <p className="text-[11px] font-medium text-foreground">構図の元画像（全身はメイン画像から。上半身・バストアップは下の元から作ります）</p>
              <p className="text-[10px] leading-relaxed text-muted">
                出来上がりは元画像の構図を保ちます。上半身・バストアップの行は、メイン画像から自動で切り出した寄りの画像を元に作ります
                （無料・切り出しの解像度は仕上がりに影響しません）。参照に寄った画像があれば、そちらを選ぶこともできます。
              </p>
              {deriving && (
                <p className="flex items-center gap-1.5 text-[10px] text-muted">
                  <Loader2 size={10} className="animate-spin" /> メイン画像から切り出しています…
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
                  ? "この全身を元に、全身の行と切り出し（上半身・バストアップ）を作ります。別の候補に替えることもできます。"
                  : "メイン画像に足元まで写っていないので、まず全身の候補を作って 1 枚選んでください。体つき・服装はここで確定し、以後の全部の行の元になります。"
              }
              user={user}
              image={image}
              specs={FULL_BODY_SPECS}
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
            />
          )}
          {effectiveMain && (viewsInPlan.has("back") || refBack) && (
            <CandidatePanel
              title={refBack ? "後ろ姿の参照（確定済み）" : "後ろ姿の参照を作る"}
              description="後ろ向きの行は、ここで選んだ後ろ姿を参照にして作ります（選ばないと毎回ちがう背中になります）。手持ちの後ろ姿があればそれを、無ければ候補を作って選びます。選ぶと参照欄に入ります。"
              user={user}
              image={effectiveMain}
              specs={BACK_VIEW_SPECS}
              costPerImage={perImage}
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
          {effectiveMain && (viewsInPlan.has("side") || refSide) && (
            <CandidatePanel
              title={refSide ? "真横の参照（確定済み）" : "真横の参照を作る"}
              description="真横の行は、ここで選んだ真横を参照にして作ります。手持ちの真横があればそれを、無ければ候補を作って選びます。選ぶと参照欄に入ります。"
              user={user}
              image={effectiveMain}
              specs={SIDE_VIEW_SPECS}
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
            />
          )}
          {notice && <p className="text-[11px] text-neon-violet">{notice}</p>}
        </div>

        {/* 右: 指定 */}
        <div className="space-y-4">
          <div className="grid gap-4 rounded-xl border border-border bg-background p-4">
            {(["poses", "places", "framings", "views"] as SceneAxis[]).map((axis) => (
              <ChipGroup
                key={axis}
                axis={axis}
                selected={sel[axis]}
                onToggle={(id) => toggle(axis, id)}
                onAll={() => setSel((p) => ({ ...p, [axis]: CHIPS_BY_AXIS[axis].map((c) => c.id) }))}
                onClear={() => setSel((p) => ({ ...p, [axis]: [] }))}
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
                服装（任意・日本語OK）
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
              選んだ組み合わせを順に回して枚数ぶん作ります。未選択の軸は既定（立つ・無地・全身・正面）になります。日本語の入力は送るときに英訳します。
            </p>
          </div>

          <div className="rounded-xl border border-border bg-background p-4">
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
                  （1 枚 {perImage}C{refRows > 0 ? `・真横／後ろの ${refRows} 枚は参照 ${subCount} 枚付きで ${perImageRefs}C` : ""}）
                </span>
              </span>
            </div>
            {confirmFirst && safeCount > SCENE_BATCH_SIZE && (
              <p className="mt-1.5 text-[10px] text-muted">
                まず {firstBatch} 枚（{firstCost.toLocaleString()} C）を作って止まります（一覧で「先に作る」を選べばその行になります）。良ければ「続きを作る」で残りを作ります。クレジットは作る分ずつ消費します。
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
                  このジョブ {activeJob.completedAngles} / {activeJob.totalAngles} 枚・全体 {producedTotal} / {plannedTotal} 枚（{formatElapsedSeconds(elapsedMs)}s）
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
                disabled={!image || busy || phase === "review"}
                className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-sm font-semibold text-white transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                  insufficientForFirst ? "bg-amber-600/80 hover:opacity-90" : "bg-gradient-to-r from-neon-pink to-neon-violet hover:opacity-90 glow-pink"
                }`}
              >
                <Sparkles size={16} />
                {!user
                  ? "ログインして作る"
                  : insufficientForFirst
                    ? "クレジットが足りません（チャージ）"
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
        <div className="space-y-3 rounded-xl border border-neon-pink/40 bg-neon-pink/5 p-4">
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
            行を消すと枚数が減ります。左のチェックで「先に作る」行を選ぶと、選んだ行だけを先に作って止まります（最大 {SCENE_BATCH_SIZE} 枚。
            全身・上半身・バストアップが混ざっていても全部入ります。元画像が違う行は別のジョブとして続けて流れます）。
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
                  {kept.length} 枚を LoRA Studio に追加
                </button>
                )}
              </div>
            )}
          </div>
          <p className="text-[10px] text-muted">
            クリックで拡大。右上の × で外す／戻す。外した画像は保存・LoRA の対象になりません（料金は生成した分にかかります）。
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
          onUpscale={() => undefined}
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
        />
      )}

      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} message="素材づくりを使うにはログインしてください。" />
      <InsufficientCreditsModal open={chargeOpen} onClose={() => setChargeOpen(false)} credits={credits} cost={firstCost} />
    </div>
  );
}
