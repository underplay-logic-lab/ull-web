"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import JSZip from "jszip";
import {
  AlertTriangle,
  Download,
  ImagePlus,
  Loader2,
  LogIn,
  Sparkles,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import {
  DEFAULT_UPSCALE_MODE,
  DEFAULT_UPSCALE_MODEL,
  MAX_INPUT_BYTES,
  UPSCALE_BATCH_MAX_ITEMS,
  UPSCALE_MODELS,
  UPSCALE_MODES,
  effectiveUpscaleMode,
  estimateOutputSize,
  getUpscaleMode,
  getUpscaleModel,
  upscaleCostBreakdown,
  upscalePriorityParallelSurcharge,
  type UpscaleModeId,
} from "@/lib/upscaleStudio";
import {
  downloadUpscaleImage,
  fetchUpscaleOriginalDownloadUrl,
  pollUpscaleJob,
  pollUpscaleJobs,
  resolveUpscaleImageUrl,
  startUpscaleBatchJob,
  startUpscaleJob,
  UpscaleJobNotFoundError,
  type UpscaleApiError,
  type UpscaleJob,
} from "@/lib/upscaleApi";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import {
  sendLoraReplacements,
  studioHandoffToFile,
  takeStudioBatchHandoff,
  takeStudioHandoff,
  type LoraReplacement,
} from "@/lib/studioHandoff";
import {
  loadStudioSession,
  saveStudioSession,
  SessionResetConfirmModal,
  StudioSessionList,
  type StudioSessionEntry,
} from "@/components/studio/StudioSessionList";
import { VramBadge } from "@/components/studio/VramBadge";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useElapsedTimer, formatElapsedSeconds } from "@/hooks/useElapsedTimer";
import { useLocalWarmCountdown } from "@/hooks/useLocalWarmCountdown";
import {
  QueueChoiceModal,
  QueuedNextBanner,
  WarmCountdownBanner,
} from "@/components/studio/QueueChoiceModal";

type Phase = "idle" | "submitting" | "running" | "done" | "error";

const FORM_ID = "upscale-studio";
const JOB_KEY = "upscale-active-job";
const SESSION_KEY = "upscale-session-jobs";
const BATCH_JOB_KEY = "upscale-active-batch";
const POLL_INTERVAL_MS = 2500;
const POLL_MAX_CONSECUTIVE_ERRORS = 8;

type PersistedForm = { modeId: UpscaleModeId; modelKey: string };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function useObjectUrl(file: File | null): string | null {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

async function readImageSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bmp = await createImageBitmap(file);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return size;
  } catch {
    return null;
  }
}

function buildOutFilename(url: string) {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const ext = /\.webp(\?|$)/i.test(url) ? "webp" : /\.jpe?g(\?|$)/i.test(url) ? "jpg" : "png";
  return `ullstudio_upscale_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(
    now.getHours(),
  )}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`;
}

// --- 画像アップローダー -------------------------------------------------
function ImageDropzone({
  file,
  previewUrl,
  onFileSelected,
  onClear,
}: {
  file: File | null;
  previewUrl: string | null;
  onFileSelected: (file: File) => void;
  onClear: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 型チェックは親の handleImageSelected に委ねる（動画等を無言で無視する
  // 不具合の再発防止。2026-09-15、Cinematic Directorで発覚・水平展開）。
  const handleFiles = (files: FileList | null) => {
    const picked = files?.[0];
    if (picked) onFileSelected(picked);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {file && previewUrl ? (
        <div className="relative overflow-hidden rounded-xl border border-border bg-background">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt="入力" className="mx-auto max-h-72 w-auto object-contain" />
          <button
            type="button"
            onClick={onClear}
            className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white transition-colors hover:bg-black/80"
            aria-label="画像を外す"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
          className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center transition-colors ${
            isDragging
              ? "border-neon-pink/60 bg-neon-pink/5"
              : "border-border bg-background hover:border-neon-violet/40"
          }`}
        >
          <ImagePlus size={28} className="text-muted" />
          <span className="text-sm font-medium text-foreground">
            アップスケールしたい画像をドロップ / 選択
          </span>
          <span className="text-[11px] text-muted">
            小さめの画像ほど効果が分かりやすい（生成物・スクショ・低解像度素材など）
          </span>
        </button>
      )}
    </div>
  );
}

function InsufficientCreditsModal({
  open,
  onClose,
  credits,
  cost,
}: {
  open: boolean;
  onClose: () => void;
  credits: number | null;
  cost: number;
}) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="w-full max-w-sm rounded-2xl border-gradient bg-surface p-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">クレジットが不足しています</h3>
          <button type="button" onClick={onClose} aria-label="閉じる" className="text-muted transition-colors hover:text-foreground">
            <X size={20} />
          </button>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          この処理には {cost} クレジット必要です。現在の保有クレジット: {credits ?? 0}
        </p>
        <a
          href="#pricing"
          onClick={onClose}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90"
        >
          <Zap size={16} />
          クレジットをチャージする
        </a>
      </div>
    </div>,
    document.body,
  );
}

// --- Before / After 比較スライダー ------------------------------------
function CompareSlider({ before, after }: { before: string; after: string }) {
  const [pos, setPos] = useState(50);
  return (
    <div className="relative select-none overflow-hidden rounded-xl border border-border bg-background">
      {/* after が箱のサイズを決める */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={after} alt="アップスケール後" className="block w-full" draggable={false} />
      {/* before を箱いっぱいに絶対配置し、左から pos% だけ見せる（同一アスペクト比） */}
      <div
        className="absolute inset-0 overflow-hidden"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={before}
          alt="元画像"
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />
      </div>
      <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
        元画像
      </span>
      <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
        アップスケール後
      </span>
      <div
        className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80"
        style={{ left: `${pos}%` }}
      />
      <input
        type="range"
        min={0}
        max={100}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        aria-label="比較スライダー"
        className="absolute inset-x-0 bottom-3 mx-auto w-[92%] cursor-ew-resize accent-neon-pink"
      />
    </div>
  );
}

// --- バッチ用サムネ / 結果カード -----------------------------------------
function BatchThumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useObjectUrl(file);
  return (
    <div className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-background">
      {url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={file.name} className="h-full w-full object-cover" />
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
        aria-label="削除"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function BatchResultCard({ job }: { job: UpscaleJob | undefined }) {
  // job.resultUrl は超解像画像の結果（2026-09-18〜）だとURLではなくVolume
  // 相対パスなので、<img src>・ダウンロードで使える実URLへ都度解決する
  // （resolveUpscaleImageUrl、CLAUDE.md §1）。旧方式の行はそのまま素通し。
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  useEffect(() => {
    if (job?.status !== "completed" || !job.resultUrl) return;
    let cancelled = false;
    resolveUpscaleImageUrl(job.id, job.resultUrl)
      .then((url) => {
        if (!cancelled) setDisplayUrl(url);
      })
      .catch((err) => console.warn("[BatchResultCard] resolveUpscaleImageUrl failed:", err));
    return () => {
      cancelled = true;
    };
  }, [job?.id, job?.status, job?.resultUrl]);

  if (job?.status === "completed" && job.resultUrl) {
    const rawUrl = job.resultUrl;
    if (!displayUrl) {
      return (
        <div className="flex aspect-square items-center justify-center rounded-lg border border-border bg-background text-muted">
          <Loader2 size={14} className="animate-spin" />
        </div>
      );
    }
    return (
      <button
        type="button"
        onClick={() => downloadUpscaleImage(displayUrl, buildOutFilename(rawUrl))}
        className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-background"
        title="ダウンロード"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={displayUrl} alt="結果" className="h-full w-full object-cover" />
        <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-black/60 py-1 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
          <Download size={11} /> 保存
        </span>
      </button>
    );
  }
  if (job?.status === "failed") {
    return (
      <div className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-center text-[10px] leading-tight text-red-300">
        <AlertTriangle size={14} />
        {job.errorMessage || "失敗"}
      </div>
    );
  }
  return (
    <div className="flex aspect-square items-center justify-center rounded-lg border border-border bg-background text-muted">
      <Loader2 size={14} className="animate-spin" />
    </div>
  );
}

export function UpscaleStudioTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs } = usePricingKnobs();

  const savedForm = useMemo(() => loadFormState<PersistedForm>(FORM_ID), []);

  const [image, setImage] = useState<File | null>(null);
  const imagePreview = useObjectUrl(image);
  const [imageError, setImageError] = useState<string | null>(null);
  const [inputSize, setInputSize] = useState<{ width: number; height: number } | null>(null);

  const [modelKey, setModelKey] = useState<string>(
    savedForm?.modelKey && UPSCALE_MODELS.some((m) => m.key === savedForm.modelKey)
      ? savedForm.modelKey
      : DEFAULT_UPSCALE_MODEL,
  );
  const [modeId, setModeId] = useState<UpscaleModeId>(
    savedForm?.modeId && UPSCALE_MODES.some((m) => m.id === savedForm.modeId)
      ? savedForm.modeId
      : DEFAULT_UPSCALE_MODE,
  );

  const [uiMode, setUiMode] = useState<"single" | "batch">("single");

  const resumedJobId = useMemo(
    () => loadFormState<{ jobId: string }>(JOB_KEY)?.jobId || null,
    [],
  );
  const [phase, setPhase] = useState<Phase>(resumedJobId ? "running" : "idle");
  const [jobId, setJobId] = useState<string | null>(resumedJobId);
  const [job, setJob] = useState<UpscaleJob | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultBeforeUrl, setResultBeforeUrl] = useState<string | null>(null);
  // 「今回の生成」（2026-09-23 ホスト方針）: 順番待ち・並列で続けて出したジョブだけを
  // 並べ、改めて生成するときは確認のうえ空にする。自動 DL は廃止（一覧から戻れる）。
  const [sessionJobs, setSessionJobs] = useState<StudioSessionEntry[]>(() => loadStudioSession(SESSION_KEY));
  const sessionJobsRef = useRef<StudioSessionEntry[]>(sessionJobs);
  const commitSession = useCallback((next: StudioSessionEntry[]) => {
    sessionJobsRef.current = next;
    setSessionJobs(next);
    saveStudioSession(SESSION_KEY, next);
  }, []);
  const [sessionResetOpen, setSessionResetOpen] = useState(false);
  const pendingFreshRef = useRef<QueuedSnapshot | null>(null);
  // 改めて生成したジョブの id。完了時に前の並びを消すための印。
  const freshJobIdRef = useRef<string | null>(null);

  // job.resultUrl は超解像画像の結果（2026-09-18〜）だとURLではなくVolume
  // 相対パスなので、表示・ダウンロードで使える実URLへ都度解決する
  // （resolveUpscaleImageUrl、CLAUDE.md §1）。旧方式の行はそのまま素通し。
  const [playableImageUrl, setPlayableImageUrl] = useState<string | null>(null);

  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);

  const elapsedMs = useElapsedTimer(phase === "running");
  const { isWarm: gpuWarm, remainingMs: gpuWarmMs, markWarm: markGpuWarm } = useLocalWarmCountdown(30);

  const [queueChoiceOpen, setQueueChoiceOpen] = useState(false);
  type QueuedSnapshot = { image: File; modelKey: string; modeId: UpscaleModeId };
  // 2026-09-23: 予約は 1 件 → 先入れ先出しのリスト（Multi-Angle と同じ。1 件だと
  // 後の予約が前の予約を黙って上書きする）。順番待ちは無料なので件数上限は無し。
  const [queuedNext, setQueuedNext] = useState<QueuedSnapshot[]>([]);
  // ポーリングの長寿命な useEffect から「今すぐ最新の予約」を読めるようにする
  // ref。イベントハンドラ（予約する/取り消す）でだけ state と一緒に書き込み、
  // effect 内では書き込まない（CLAUDE.md §6 参照。完了時の先頭取り出しは例外）。
  const queuedNextRef = useRef<QueuedSnapshot[]>([]);

  useEffect(() => {
    saveFormState(FORM_ID, { modeId, modelKey } satisfies PersistedForm);
  }, [modeId, modelKey]);

  const handleImageSelected = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      setImageError(
        file.type.startsWith("video/")
          ? "動画ファイルはこちらでは使えません。「動画超解像」タブをお使いください。"
          : "画像ファイルのみ対応しています。",
      );
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      setImageError("画像ファイルが大きすぎます。25MB 以下の画像を選んでください。");
      return;
    }
    setImageError(null);
    setImage(file);
    setInputSize(null);
    setPhase("idle");
    setJob(null);
    setResultBeforeUrl(null);
    readImageSize(file).then(setInputSize);
  }, []);

  const handleClearImage = useCallback(() => {
    setImage(null);
    setInputSize(null);
    setImageError(null);
  }, []);

  // 他タブ（Multi-Angle の構図等）からの「超解像へ」導線: マウント時に 1 回だけ
  // 取り出し、署名付き URL を fetch して File にし、ローカル選択と同じ経路へ流す。
  useEffect(() => {
    const handoff = takeStudioHandoff("image");
    if (!handoff) return;
    let cancelled = false;
    studioHandoffToFile(handoff)
      .then((file) => {
        if (!cancelled) handleImageSelected(file);
      })
      .catch((err) => {
        console.warn("[UpscaleStudioTab] handoff failed:", err);
        if (!cancelled) setImageError("前のタブの結果を取り込めませんでした。画像を選び直してください。");
      });
    return () => {
      cancelled = true;
    };
    // マウント時のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- バッチ（複数画像） ----------------------------------------------
  type BatchItem = { file: File; dims: { width: number; height: number } | null };
  const batchInputRef = useRef<HTMLInputElement>(null);
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchError, setBatchError] = useState<string | null>(null);

  const resumedBatchJobIds = useMemo(
    () => loadFormState<{ jobIds: string[] }>(BATCH_JOB_KEY)?.jobIds || null,
    [],
  );
  const [batchPhase, setBatchPhase] = useState<Phase>(
    resumedBatchJobIds?.length ? "running" : "idle",
  );
  const [batchJobIds, setBatchJobIds] = useState<string[]>(resumedBatchJobIds || []);
  const [batchJobs, setBatchJobs] = useState<Record<string, UpscaleJob>>({});

  const addBatchFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const all = Array.from(files);
    const incoming = all.filter((f) => f.type.startsWith("image/") && f.size <= MAX_INPUT_BYTES);
    // 画像以外・25MB超過は黙って無視せず、まとめて件数を報告する
    // （2026-09-15、Cinematic Directorでの単一画像ドロップの不具合を
    // 水平展開・バッチ版）。
    const rejected = all.length - incoming.length;
    if (incoming.length === 0) {
      if (rejected > 0) {
        setBatchError(
          `${rejected} 件は画像ファイルとして認識できないか、25MB を超えていたため除外しました。`,
        );
      }
      return;
    }
    setBatchItems((prev) => {
      const room = Math.max(0, UPSCALE_BATCH_MAX_ITEMS - prev.length);
      if (incoming.length > room) {
        setBatchError(`一度に処理できるのは最大 ${UPSCALE_BATCH_MAX_ITEMS} 枚です。`);
      } else if (rejected > 0) {
        setBatchError(
          `${rejected} 件は画像ファイルとして認識できないか、25MB を超えていたため除外しました。`,
        );
      } else {
        setBatchError(null);
      }
      const toAdd = incoming.slice(0, room);
      return [...prev, ...toAdd.map((file) => ({ file, dims: null }))];
    });
    incoming.forEach((file) => {
      readImageSize(file).then((dims) => {
        setBatchItems((prev) => prev.map((it) => (it.file === file ? { ...it, dims } : it)));
      });
    });
  }, []);

  // 他タブからの「この画像たちを超解像へ」（LoRA の小さすぎる素材等）: マウント時に 1 回だけ
  // 取り出して「まとめて処理」に並べ、目標短辺に届く最小の倍率を初期値にする。
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  // LoRA Studio から来た画像 → 元画像の id。完了後に差し戻すために使う（File の同一性で引く）。
  const loraReturnRef = useRef<Map<File, string>>(new Map());
  // 送信したジョブ id → LoRA 側の元画像 id（完了後の差し戻しに使う）。
  const [batchLoraMap, setBatchLoraMap] = useState<Record<string, string>>({});
  useEffect(() => {
    const handoff = takeStudioBatchHandoff();
    if (!handoff || handoff.files.length === 0) return;
    const ids = handoff.loraReturnIds;
    if (ids && ids.length === handoff.files.length) {
      handoff.files.forEach((f, i) => loraReturnRef.current.set(f, ids[i]));
    }
    // 取り出しは破壊的なので cleanup で打ち消さない（StrictMode の二重実行で 2 回目は
    // 空振りする。1 回目の反映を捨てると取り込みごと消える）。effect 本体では同期
    // setState しない（react-hooks/set-state-in-effect）。
    const suggested = UPSCALE_MODELS.find((m) => m.key === handoff.suggestedModelKey);
    queueMicrotask(() => {
      setUiMode("batch");
      addBatchFiles(handoff.files);
      if (suggested) setModelKey(suggested.key);
      setBatchNotice(`${handoff.source}を取り込みました。${handoff.hint ? ` ${handoff.hint}` : ""}`);
    });
    const target = handoff.targetShortEdge;
    // 倍率固定のモデル（Real-ESRGAN 系は ×4 固定）では倍率の選択は効かないので選ばない。
    if (!target || suggested?.fixedScale) return;
    Promise.all(handoff.files.map((f) => readImageSize(f))).then((sizes) => {
      const shorts = sizes.flatMap((d) => (d ? [Math.min(d.width, d.height)] : []));
      if (shorts.length === 0) return;
      const need = target / Math.min(...shorts);
      const pick = UPSCALE_MODES.find((m) => m.mult >= need) ?? UPSCALE_MODES[UPSCALE_MODES.length - 1];
      setModeId(pick.id);
    });
    // マウント時のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeBatchItem = useCallback((file: File) => {
    setBatchItems((prev) => prev.filter((it) => it.file !== file));
  }, []);

  const batchBreakdowns = useMemo(
    () =>
      batchItems.map((it) =>
        upscaleCostBreakdown({
          inW: it.dims?.width ?? 0,
          inH: it.dims?.height ?? 0,
          modeId,
          modelKey,
          knobs,
        }),
      ),
    [batchItems, modeId, modelKey, knobs],
  );
  const batchTotalCredits = batchBreakdowns.reduce((sum, b) => sum + b.credits, 0);
  const batchInsufficientCredits =
    Boolean(user) && !creditsLoading && batchTotalCredits > 0 && (credits ?? 0) < batchTotalCredits;
  const batchBusy = batchPhase === "submitting" || batchPhase === "running";
  const batchDoneCount = Object.values(batchJobs).filter(
    (j) => j.status === "completed" || j.status === "failed",
  ).length;
  const batchProcessingVramGb = useMemo(() => {
    const processing = Object.values(batchJobs).find(
      (j) => j.status === "processing" && j.vramUsedGb != null,
    );
    return processing?.vramUsedGb ?? null;
  }, [batchJobs]);
  // コールドスタート判定: まだ1件も processing/completed/failed に進んでいない
  // （＝コンテナがまだ起動待ち）間だけ「GPU起動中」を出す。1件でも動き出せば
  // 以降のバッチ項目は同じ温まったコンテナで処理されるため「処理中」に切替。
  const batchAllPending =
    batchJobIds.length > 0 && batchJobIds.every((id) => (batchJobs[id]?.status ?? "pending") === "pending");

  const handleBatchRun = useCallback(async () => {
    if (!user) return setLoginOpen(true);
    if (batchItems.length === 0) return;
    if (batchInsufficientCredits) return setChargeOpen(true);

    setBatchPhase("submitting");
    setBatchError(null);
    setBatchJobs({});
    try {
      const res = await startUpscaleBatchJob({
        userId: user.id,
        images: batchItems.map((it) => it.file),
        modelKey,
        modeId,
      });
      broadcastCreditsUpdate(user.id, res.remainingCredits);
      const loraMap: Record<string, string> = {};
      batchItems.forEach((it, i) => {
        const loraId = loraReturnRef.current.get(it.file);
        if (loraId && res.jobIds[i]) loraMap[res.jobIds[i]] = loraId;
      });
      setBatchLoraMap(loraMap);
      setBatchItems([]);
      setBatchJobIds(res.jobIds);
      setBatchPhase("running");
    } catch (err) {
      const e = err as UpscaleApiError;
      console.error("[UpscaleStudioTab] batch start failed:", e);
      const remaining = e.remainingCredits;
      if (typeof remaining === "number") broadcastCreditsUpdate(user.id, remaining);
      setBatchPhase("error");
      setBatchError(e.message || "バッチの作成に失敗しました。");
      if (e.message?.includes("クレジット")) setChargeOpen(true);
    }
  }, [user, batchItems, batchInsufficientCredits, modelKey, modeId]);

  // job.resultUrl は署名前の生の値（Volume相対パスの場合あり）。実フェッチ
  // 直前に resolveUpscaleImageUrl で実URLへ解決する（CLAUDE.md §1）。
  const batchCompletedResults = useMemo(
    () =>
      batchJobIds
        .map((id) => batchJobs[id])
        .filter((j): j is UpscaleJob => Boolean(j?.resultUrl && j.status === "completed"))
        .map((j) => ({ id: j.id, resultUrl: j.resultUrl as string })),
    [batchJobIds, batchJobs],
  );
  const batchCompletedUrls = useMemo(
    () => batchCompletedResults.map((r) => r.resultUrl),
    [batchCompletedResults],
  );
  const [downloadingAll, setDownloadingAll] = useState(false);

  // ブラウザは <a download> の連続クリックを「複数ファイルの自動ダウンロード」
  // として2つ目以降を黙ってブロックすることがある（Chrome等）。MultiAngleStudioTab
  // と同じく ZIP に固めて1回のダウンロードにする。
  const handleDownloadAll = useCallback(async () => {
    if (batchCompletedResults.length === 0 || downloadingAll) return;
    setDownloadingAll(true);
    try {
      const zip = new JSZip();
      await Promise.all(
        batchCompletedResults.map(async ({ id, resultUrl }, i) => {
          const url = await resolveUpscaleImageUrl(id, resultUrl);
          const res = await fetch(url);
          if (!res.ok) return;
          const buf = await res.arrayBuffer();
          const ext = /\.webp(\?|$)/i.test(resultUrl) ? "webp" : /\.jpe?g(\?|$)/i.test(resultUrl) ? "jpg" : "png";
          zip.file(`${String(i + 1).padStart(2, "0")}_upscale.${ext}`, buf);
        }),
      );
      const blob = await zip.generateAsync({ type: "blob" });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      const now = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      a.download = `ullstudio_upscale_batch_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (err) {
      console.error("[UpscaleStudioTab] batch zip download failed:", err);
      setBatchError("ZIP の作成に失敗しました。");
    } finally {
      setDownloadingAll(false);
    }
  }, [batchCompletedResults, downloadingAll]);

  // 完了した分を LoRA Studio へ戻し、元画像と差し替える（2026-09-24、ホスト要望）。
  // 学習素材なので、元画質（劣化の無い PNG）があればそちらを使う。無ければ配信用の結果。
  // 対応表はこのページ内だけに持つ（再読み込みすると LoRA 側の画像も消えているので不要）。
  const [returningToLora, setReturningToLora] = useState(false);
  const loraReturnable = useMemo(
    () => batchJobIds.filter((id) => batchLoraMap[id] && batchJobs[id]?.status === "completed"),
    [batchJobIds, batchJobs, batchLoraMap],
  );
  const handleReturnToLora = useCallback(async () => {
    if (loraReturnable.length === 0 || returningToLora) return;
    setReturningToLora(true);
    setBatchError(null);
    try {
      const settled = await Promise.allSettled(
        loraReturnable.map(async (jobId): Promise<LoraReplacement> => {
          const job = batchJobs[jobId];
          const url =
            job.originalAvailable && job.originalFilename
              ? await fetchUpscaleOriginalDownloadUrl(job.id, job.originalFilename)
              : await resolveUpscaleImageUrl(job.id, job.resultUrl as string);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const type = blob.type && blob.type !== "application/octet-stream" ? blob.type : "image/png";
          const ext = type.includes("webp") ? "webp" : type.includes("jpeg") ? "jpg" : "png";
          return { id: batchLoraMap[jobId], file: new File([blob], `upscaled_${jobId.slice(0, 8)}.${ext}`, { type }) };
        }),
      );
      const ok = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failed = settled.length - ok.length;
      if (ok.length === 0) {
        setBatchError("拡大した画像を取得できませんでした。時間をおいてもう一度お試しください。");
        return;
      }
      if (failed > 0) console.warn(`[UpscaleStudioTab] return to LoRA: ${failed} fetch(es) failed`);
      sendLoraReplacements(ok);
      // 差し戻した分は二度押しで重複しないよう対応表から外す。
      setBatchLoraMap((prev) => {
        const next = { ...prev };
        loraReturnable.forEach((id) => {
          if (ok.some((r) => r.id === prev[id])) delete next[id];
        });
        return next;
      });
    } finally {
      setReturningToLora(false);
    }
  }, [loraReturnable, returningToLora, batchJobs, batchLoraMap]);

  // タブを閉じても続行 — batchJobIds をローカルに永続化してポーリングで復元。
  useEffect(() => {
    if (batchJobIds.length === 0) return;
    let cancelled = false;
    let errorStreak = 0;
    saveFormState(BATCH_JOB_KEY, { jobIds: batchJobIds });

    (async () => {
      while (!cancelled) {
        try {
          const results = await pollUpscaleJobs(batchJobIds);
          if (cancelled) return;
          errorStreak = 0;
          setBatchJobs(Object.fromEntries(results.map((j) => [j.id, j])));

          const allDone = results.every((j) => j.status === "completed" || j.status === "failed");
          if (allDone) {
            setBatchPhase("done");
            // JOB_KEY と同じく完了後もクリアしない — リロード時に最後のバッチの
            // 結果をそのまま再表示する（Multi-Angle/LoRAタブと同じ挙動）。
            return;
          }
          setBatchPhase("running");
        } catch (err) {
          if (cancelled) return;
          if (err instanceof UpscaleJobNotFoundError) {
            setBatchPhase("error");
            setBatchError(
              "このバッチの記録が見つかりませんでした。お手数ですが新しく生成してください。",
            );
            saveFormState(BATCH_JOB_KEY, { jobIds: [] });
            return;
          }
          errorStreak += 1;
          console.warn("[UpscaleStudioTab] batch poll error:", err);
          if (errorStreak >= POLL_MAX_CONSECUTIVE_ERRORS) {
            setBatchPhase("error");
            setBatchError("状況の取得に繰り返し失敗しました。時間をおいて再読み込みしてください。");
            return;
          }
        }
        await sleep(POLL_INTERVAL_MS);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [batchJobIds]);

  // snapshot を明示的に渡す設計: キュー待ちの「次の1件」は予約した時点の
  // image/modelKey/modeId を使う必要があり、発火時点の（変わっているかも
  // しれない）現在の state を読んではいけない。ポーリングの長寿命な
  // useEffect からも呼ぶため、参照が安定するよう useCallback にする。
  const runGenerate = useCallback(
    async (snapshot: QueuedSnapshot, opts: { priority?: boolean; continuation?: boolean } = {}) => {
      if (!user) return;
      setPhase("submitting");
      setErrorMessage(null);
      setJob(null);
      setResultBeforeUrl(URL.createObjectURL(snapshot.image));

      try {
        const res = await startUpscaleJob({
          userId: user.id,
          image: snapshot.image,
          modelKey: snapshot.modelKey,
          modeId: snapshot.modeId,
          priority: opts.priority,
        });
        broadcastCreditsUpdate(user.id, res.remainingCredits);
        {
          const entry: StudioSessionEntry = { id: res.jobId, createdAt: new Date().toISOString(), label: snapshot.image.name };
          commitSession([...sessionJobsRef.current.filter((e) => e.id !== res.jobId), entry]);
          freshJobIdRef.current = opts.continuation ? null : res.jobId;
        }
        setJobId(res.jobId);
        setPhase("running");
      } catch (err) {
        const e = err as UpscaleApiError;
        console.error("[UpscaleStudioTab] start failed:", e);
        const remaining = e.remainingCredits;
        if (typeof remaining === "number") broadcastCreditsUpdate(user.id, remaining);
        setPhase("error");
        setErrorMessage(e.message || "ジョブの作成に失敗しました。");
        if (e.message?.includes("クレジット")) setChargeOpen(true);
      }
    },
    [user, commitSession],
  );

  // --- ポーリングループ ----------------------------------------------
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let errorStreak = 0;
    // タブ再読み込み直後に「とっくに完了済みのジョブ」を最初の1回だけ
    // ポーリングして検知するケースがある。そのとき markGpuWarm() を呼ぶと、
    // 実際には何十分も前に終わっていても誤って warm 扱いになってしまうため、
    // 「このポーリングセッション中に実行中状態を実際に経由してから完了した」
    // 場合だけ warm 扱いにする（CLAUDE.md §6）。
    let sawInProgress = false;
    saveFormState(JOB_KEY, { jobId });

    (async () => {
      while (!cancelled) {
        try {
          const next = await pollUpscaleJob(jobId);
          if (cancelled) return;
          errorStreak = 0;
          setJob(next);

          if (next.status === "completed") {
            setPhase("done");
            // 完了後もクリアしない — リロード時に最後のジョブの結果をそのまま
            // 再表示する（Multi-Angle/LoRAタブと同じ挙動）。
            if (sawInProgress) markGpuWarm();
            // 「順番待ち」で予約されていた次の1件を、コンテナがまだ温かい
            // うちに自動発火する。ref はイベントハンドラでのみ書かれるので
            // ここでは読むだけ（clear は同じ非同期コールバック内で行う）。
            // 改めて生成したジョブが完了したら、前の「今回の生成」を消して
            // このジョブ 1 件から始める（確認時点では消さない）。
            if (freshJobIdRef.current === jobId) {
              freshJobIdRef.current = null;
              commitSession(sessionJobsRef.current.filter((e) => e.id === jobId));
            }
            const [queued, ...restQueued] = queuedNextRef.current;
            if (queued) {
              // 2026-09-23: 以前はここで結果を自動 DL していたが廃止（「今回の生成」
              // 一覧から戻れる。DL はユーザー操作に任せる）。
              queuedNextRef.current = restQueued;
              setQueuedNext(restQueued);
              void runGenerate(queued, { continuation: true });
            }
            return;
          }
          if (next.status === "failed") {
            setPhase("error");
            setErrorMessage(next.errorMessage || "アップスケールに失敗しました。");
            return;
          }
          sawInProgress = true;
          setPhase("running");
        } catch (err) {
          if (cancelled) return;
          if (err instanceof UpscaleJobNotFoundError) {
            // 一時的な通信エラーと違いリトライしても直らない（14日保持を
            // 過ぎて自動 purge 済み等）。すぐ諦めて案内し、無くなった
            // データを指す古い参照は消しておく。
            setPhase("error");
            setErrorMessage(
              "このジョブの記録が見つかりませんでした。お手数ですが新しく生成してください。",
            );
            saveFormState(JOB_KEY, { jobId: "" });
            return;
          }
          errorStreak += 1;
          console.warn("[UpscaleStudioTab] poll error:", err);
          if (errorStreak >= POLL_MAX_CONSECUTIVE_ERRORS) {
            setPhase("error");
            setErrorMessage("状況の取得に繰り返し失敗しました。時間をおいて再読み込みしてください。");
            return;
          }
        }
        await sleep(POLL_INTERVAL_MS);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobId, markGpuWarm, runGenerate, commitSession]);

  // job完了後、resultUrlを実際に表示・ダウンロードできるURLへ解決する
  // （Volume相対パスなら署名付きModal URLを発行、旧方式のURLはそのまま）。
  useEffect(() => {
    if (job?.status !== "completed" || !job.resultUrl) return;
    let cancelled = false;
    resolveUpscaleImageUrl(job.id, job.resultUrl)
      .then((url) => {
        if (!cancelled) setPlayableImageUrl(url);
      })
      .catch((err) => {
        console.warn("[UpscaleStudioTab] resolveUpscaleImageUrl failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [job?.id, job?.status, job?.resultUrl]);

  const model = getUpscaleModel(modelKey);
  const mode = effectiveUpscaleMode(getUpscaleMode(modeId), model);

  const breakdown = useMemo(
    () =>
      upscaleCostBreakdown({
        inW: inputSize?.width ?? 0,
        inH: inputSize?.height ?? 0,
        modeId,
        modelKey,
        knobs,
      }),
    [inputSize, modeId, modelKey, knobs],
  );
  const cost = breakdown.credits;

  const outSize =
    inputSize && inputSize.width > 0
      ? estimateOutputSize(inputSize.width, inputSize.height, mode, model)
      : null;

  const insufficientCredits =
    Boolean(user) && !creditsLoading && cost > 0 && (credits ?? 0) < cost;
  const busy = phase === "submitting" || phase === "running";
  const canRun = Boolean(image) && cost > 0;

  const handleShowSession = (id: string) => {
    if (busy || id === jobId) return;
    setErrorMessage(null);
    setJob(null);
    setResultBeforeUrl(null);
    setJobId(id);
    setPhase("running"); // ポーリングが 1 回で completed を検知して done に落とす
  };

  const handleRun = () => {
    if (!user) return setLoginOpen(true);
    if (!image) return;
    // 実行中に押した場合は「順番待ち」か「並列実行」かを選ばせる（CLAUDE.md
    // §6: scaledown_window=30 系のキュー標準パターン）。insufficientCredits
    // より先に置くこと — 1件目の課金直後で残高が減っている状態だと、無料の
    // はずの順番待ちにすら辿り着けなくなる。
    if (busy) {
      setQueueChoiceOpen(true);
      return;
    }
    if (insufficientCredits) return setChargeOpen(true);
    const snapshot: QueuedSnapshot = { image, modelKey, modeId };
    if (sessionJobsRef.current.length > 0) {
      pendingFreshRef.current = snapshot;
      setSessionResetOpen(true);
      return;
    }
    void runGenerate(snapshot);
  };

  const handleQueueWait = () => {
    if (!image) return;
    const snapshot: QueuedSnapshot = { image, modelKey, modeId };
    const next = [...queuedNextRef.current, snapshot];
    queuedNextRef.current = next;
    setQueuedNext(next);
    setQueueChoiceOpen(false);
  };

  const handleCancelQueue = () => {
    queuedNextRef.current = [];
    setQueuedNext([]);
  };

  const handleQueueParallel = () => {
    if (!image) return;
    setQueueChoiceOpen(false);
    const surcharge = upscalePriorityParallelSurcharge(knobs, cost);
    if (!creditsLoading && (credits ?? 0) < cost + surcharge) {
      setChargeOpen(true);
      return;
    }
    void runGenerate({ image, modelKey, modeId }, { priority: true, continuation: true });
  };

  const [originalDownloading, setOriginalDownloading] = useState(false);
  const handleDownloadOriginal = async () => {
    if (!job?.id || !job.originalFilename || originalDownloading) return;
    setOriginalDownloading(true);
    try {
      const url = await fetchUpscaleOriginalDownloadUrl(job.id, job.originalFilename);
      await downloadUpscaleImage(url, job.originalFilename);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "元画質のダウンロードに失敗しました。");
    } finally {
      setOriginalDownloading(false);
    }
  };

  const progressPct = phase === "running" ? (job?.status === "processing" ? 70 : 25) : 0;

  return (
    <div data-source-file="src/components/studio/UpscaleStudioTab.tsx" className="flex flex-col gap-4">
      {/* ── モード切替 ───────────────────────────────────────── */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setUiMode("single")}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            uiMode === "single"
              ? "border-neon-pink/40 bg-neon-pink/5 text-neon-pink"
              : "border-border bg-background text-muted hover:border-neon-violet/40"
          }`}
        >
          1枚ずつ
        </button>
        <button
          type="button"
          onClick={() => setUiMode("batch")}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            uiMode === "batch"
              ? "border-neon-pink/40 bg-neon-pink/5 text-neon-pink"
              : "border-border bg-background text-muted hover:border-neon-violet/40"
          }`}
        >
          まとめて処理（最大{UPSCALE_BATCH_MAX_ITEMS}枚）
        </button>
      </div>

      {uiMode === "single" && (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* ── 左: 入力 ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-5 rounded-2xl border-gradient bg-surface/40 p-5">
        <ImageDropzone
          file={image}
          previewUrl={imagePreview}
          onFileSelected={handleImageSelected}
          onClear={handleClearImage}
        />
        {imageError && <p className="-mt-2 text-[11px] text-red-400">{imageError}</p>}
        {inputSize && (
          <p className="-mt-3 text-[11px] text-muted">
            入力 {inputSize.width}×{inputSize.height}px
            {outSize && outSize.width > 0 && (
              <>
                {" → "}出力 約 {outSize.width}×{outSize.height}px（
                {breakdown.outputMP.toFixed(1)} MP・×{breakdown.effectiveMult.toFixed(1)}）
              </>
            )}
          </p>
        )}
        {inputSize && breakdown.clampedByMp && (
          <p className="-mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            この入力サイズだと {mode.label} フル倍率は出力上限（約 75MP）を超えるため、
            出力は ×{breakdown.effectiveMult.toFixed(1)} 相当に自動調整されます。
          </p>
        )}

        {/* モデル選択 */}
        <div>
          <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">エンジン</p>
          <div className="flex flex-col gap-2">
            {UPSCALE_MODELS.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setModelKey(m.key)}
                className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                  modelKey === m.key
                    ? "border-neon-pink/40 bg-neon-pink/5"
                    : "border-border bg-background hover:border-neon-violet/40"
                }`}
              >
                <span className="text-sm font-medium text-foreground">{m.label}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
                  {m.descJa}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* 倍率 */}
        <div>
          <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">拡大倍率</p>
          {model.fixedScale ? (
            <p className="flex items-start gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5 text-[11px] leading-relaxed text-muted">
              <Sparkles size={12} className="mt-0.5 shrink-0 text-neon-violet" />
              {model.label} は ×{model.fixedScale} 固定です（倍率選択は一部のモデルのみ対応）。
            </p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                {UPSCALE_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setModeId(m.id)}
                    className={`rounded-xl border px-3 py-2.5 text-center transition-colors ${
                      modeId === m.id
                        ? "border-neon-pink/40 bg-neon-pink/5 text-neon-pink"
                        : "border-border bg-background text-muted hover:border-neon-violet/40"
                    }`}
                  >
                    <span className="block text-sm font-semibold">{m.label}</span>
                    <span className="block text-[10px]">{m.subLabel}</span>
                  </button>
                ))}
              </div>

              {mode.cascadeStages > 1 && (
                <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
                  <Sparkles size={12} className="mt-0.5 shrink-0 text-neon-violet" />
                  {mode.label} は内部で {mode.cascadeStages} 段階に分けて処理し、単発より高画質に仕上げます（その分クレジットが上がります）。
                </p>
              )}
            </>
          )}
          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
            <Sparkles size={12} className="mt-0.5 shrink-0 text-neon-violet" />
            アスペクト比は維持されます。出力の上限は約 75MP（8K〜10K 級）。
          </p>
        </div>
      </div>

      {/* ── 右: アクション / 結果 ───────────────────────────── */}
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-border bg-background p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted">
              <Wand2 size={14} />
              {model.label}
            </span>
            <span className="font-mono font-medium text-foreground">
              {cost > 0 ? (
                <span className="text-neon-pink">{cost} Credits</span>
              ) : (
                <span className="text-muted">画像を選択</span>
              )}
            </span>
          </div>

          {phase === "running" && (
            <div className="mt-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
                <div
                  className={`h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-violet duration-500 ${
                    job?.status === "pending" ? "animate-pulse" : "transition-[width]"
                  }`}
                  style={{ width: `${Math.max(4, progressPct)}%` }}
                />
              </div>
              <p className="mt-1.5 text-center text-[11px] text-muted">
                {job?.status === "pending"
                  ? `生成準備中…GPUを起動しています（初回は1〜2分ほどかかります・${formatElapsedSeconds(elapsedMs)}s）`
                  : `アップスケール中（${formatElapsedSeconds(elapsedMs)}s）`}
              </p>
              {job?.vramUsedGb != null && (
                <div className="mt-2 flex justify-center">
                  <VramBadge gb={job.vramUsedGb} />
                </div>
              )}
            </div>
          )}

          {!busy && gpuWarm && <WarmCountdownBanner remainingMs={gpuWarmMs} />}

          {busy && queuedNext.length === 0 && (
            <p className="mt-2 flex items-start gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/10 px-3 py-2 text-xs leading-relaxed text-neon-violet">
              <Sparkles size={14} className="mt-0.5 shrink-0" />
              バックグラウンドで処理中です。もう一度ボタンを押すと、次の生成を予約できます。
            </p>
          )}

          {queuedNext.length > 0 && (
            <div className="mt-2">
              <QueuedNextBanner count={queuedNext.length} onCancel={handleCancelQueue} />
            </div>
          )}

          <button
            type="button"
            onClick={handleRun}
            disabled={!canRun && Boolean(user)}
            className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-sm font-semibold text-white transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
              insufficientCredits
                ? "bg-amber-600/80 hover:opacity-90"
                : "bg-gradient-to-r from-neon-pink to-neon-violet hover:opacity-90 glow-pink"
            }`}
          >
            {phase === "submitting" ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                送信中…
              </>
            ) : phase === "running" ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                {job?.status === "pending" ? "GPU起動中…" : "処理中…"}
              </>
            ) : !user ? (
              <>
                <LogIn size={16} />
                ログインしてアップスケール
              </>
            ) : insufficientCredits ? (
              <>
                <Zap size={16} />
                クレジットをチャージ
              </>
            ) : (
              <>
                <Wand2 size={16} />
                アップスケール
              </>
            )}
          </button>
        </div>

        {busy && (
          <p className="flex items-start gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/10 px-3 py-2 text-xs leading-relaxed text-neon-violet">
            <Sparkles size={14} className="mt-0.5 shrink-0" />
            バックグラウンドで処理中です。タブを閉じたり再読み込みしても継続し、次に開いたときに結果が表示されます。
          </p>
        )}

        {phase === "error" && errorMessage && (
          <p className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            {errorMessage}
          </p>
        )}

        {phase === "done" && job?.resultUrl && (
          <div className="flex flex-col gap-3">
            {!playableImageUrl ? (
              <div className="flex h-40 w-full items-center justify-center rounded-xl border border-border bg-background text-xs text-muted">
                読み込み中…
              </div>
            ) : resultBeforeUrl ? (
              <CompareSlider before={resultBeforeUrl} after={playableImageUrl} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={playableImageUrl}
                alt="アップスケール結果"
                className="w-full rounded-xl border border-border bg-background"
              />
            )}
            <div className="flex items-center justify-between text-[11px] text-muted">
              <span>
                {job.outWidth && job.outHeight
                  ? `${job.outWidth}×${job.outHeight}px`
                  : ""}
                {job.elapsedTime ? ` ・ ${job.elapsedTime}s` : ""}
              </span>
              {job.vramPeakGb != null && <VramBadge gb={job.vramPeakGb} />}
            </div>
            <button
              type="button"
              disabled={!playableImageUrl}
              onClick={() =>
                playableImageUrl && downloadUpscaleImage(playableImageUrl, buildOutFilename(job.resultUrl as string))
              }
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:border-neon-violet/40 disabled:opacity-50"
            >
              <Download size={16} />
              ダウンロード
            </button>
            {job.originalAvailable && job.originalFilename && (
              <button
                type="button"
                onClick={() => void handleDownloadOriginal()}
                disabled={originalDownloading}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-neon-violet/40 bg-neon-violet/5 px-6 py-3 text-sm font-semibold text-neon-violet transition-colors hover:bg-neon-violet/10 disabled:opacity-60"
              >
                <Download size={16} />
                {originalDownloading ? "準備中…" : "元画質(PNG)でダウンロード"}
              </button>
            )}
          </div>
        )}

        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <ImagePlus size={14} className="mt-0.5 shrink-0 text-neon-violet" />
          {user
            ? "料金は出力の画素数で決まります。処理は数十秒。連続でかけるとウォームアップぶん速くなります。"
            : "超解像スタジオの利用にはログインが必要です。初回登録で10クレジットが付与されます。"}
        </p>
      </div>
      </div>
      )}

      {uiMode === "batch" && (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ── 左: 入力（複数） ─────────────────────────────────── */}
        <div className="flex flex-col gap-5 rounded-2xl border-gradient bg-surface/40 p-5">
          <div>
            <input
              ref={batchInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                addBatchFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <div
              onClick={() => batchInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                addBatchFiles(e.dataTransfer.files);
              }}
              className="cursor-pointer rounded-xl border-2 border-dashed border-border bg-background px-4 py-8 text-center text-sm text-muted transition-colors hover:border-neon-violet/40"
            >
              <ImagePlus size={22} className="mx-auto mb-2 text-neon-violet" />
              クリックまたはドラッグで複数画像を追加
              <span className="mt-1 block text-[11px]">
                {batchItems.length}/{UPSCALE_BATCH_MAX_ITEMS} 枚
              </span>
            </div>
          </div>

          {batchItems.length > 0 && (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
              {batchItems.map((it, i) => (
                <BatchThumb key={i} file={it.file} onRemove={() => removeBatchItem(it.file)} />
              ))}
            </div>
          )}
          {batchNotice && <p className="-mt-2 text-[11px] text-neon-violet">{batchNotice}</p>}
          {batchError && <p className="-mt-2 text-[11px] text-red-400">{batchError}</p>}

          {/* モデル選択 */}
          <div>
            <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">エンジン</p>
            <div className="flex flex-col gap-2">
              {UPSCALE_MODELS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setModelKey(m.key)}
                  className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                    modelKey === m.key
                      ? "border-neon-pink/40 bg-neon-pink/5"
                      : "border-border bg-background hover:border-neon-violet/40"
                  }`}
                >
                  <span className="text-sm font-medium text-foreground">{m.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
                    {m.descJa}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* 倍率 */}
          <div>
            <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">拡大倍率</p>
            {model.fixedScale ? (
              <p className="flex items-start gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5 text-[11px] leading-relaxed text-muted">
                <Sparkles size={12} className="mt-0.5 shrink-0 text-neon-violet" />
                {model.label} は ×{model.fixedScale} 固定です（倍率選択は一部のモデルのみ対応）。
              </p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {UPSCALE_MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setModeId(m.id)}
                      className={`rounded-xl border px-3 py-2.5 text-center transition-colors ${
                        modeId === m.id
                          ? "border-neon-pink/40 bg-neon-pink/5 text-neon-pink"
                          : "border-border bg-background text-muted hover:border-neon-violet/40"
                      }`}
                    >
                      <span className="block text-sm font-semibold">{m.label}</span>
                      <span className="block text-[10px]">{m.subLabel}</span>
                    </button>
                  ))}
                </div>
                {mode.cascadeStages > 1 && (
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
                    <Sparkles size={12} className="mt-0.5 shrink-0 text-neon-violet" />
                    {mode.label} は内部で {mode.cascadeStages} 段階に分けて処理し、単発より高画質に仕上げます（その分クレジットが上がります）。
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── 右: 実行 / 結果一覧 ─────────────────────────────── */}
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-border bg-background p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-muted">
                <Wand2 size={14} />
                {model.label} ・ {batchItems.length}枚
              </span>
              <span className="font-mono font-medium text-foreground">
                {batchTotalCredits > 0 ? (
                  <span className="text-neon-pink">{batchTotalCredits} Credits</span>
                ) : (
                  <span className="text-muted">画像を選択</span>
                )}
              </span>
            </div>

            {batchPhase === "running" && batchJobIds.length > 0 && (
              <div className="mt-3">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
                  <div
                    className={`h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-violet duration-500 ${
                      batchAllPending ? "animate-pulse" : "transition-[width]"
                    }`}
                    style={{
                      width: `${Math.max(4, (batchDoneCount / batchJobIds.length) * 100)}%`,
                    }}
                  />
                </div>
                <p className="mt-1.5 text-center text-[11px] text-muted">
                  {batchAllPending
                    ? "生成準備中…GPUを起動しています（初回は1〜2分ほどかかります）"
                    : `${batchDoneCount}/${batchJobIds.length} 完了`}
                </p>
                {batchProcessingVramGb != null && (
                  <div className="mt-2 flex justify-center">
                    <VramBadge gb={batchProcessingVramGb} />
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={handleBatchRun}
              disabled={(batchItems.length === 0 || batchBusy) && Boolean(user)}
              className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-sm font-semibold text-white transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                batchInsufficientCredits
                  ? "bg-amber-600/80 hover:opacity-90"
                  : "bg-gradient-to-r from-neon-pink to-neon-violet hover:opacity-90 glow-pink"
              }`}
            >
              {batchBusy ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {batchPhase === "submitting" ? "送信中…" : batchAllPending ? "GPU起動中…" : "処理中…"}
                </>
              ) : !user ? (
                <>
                  <LogIn size={16} />
                  ログインしてアップスケール
                </>
              ) : batchInsufficientCredits ? (
                <>
                  <Zap size={16} />
                  クレジットをチャージ
                </>
              ) : (
                <>
                  <Wand2 size={16} />
                  {batchItems.length > 0 ? `${batchItems.length}枚をまとめて処理` : "アップスケール"}
                </>
              )}
            </button>
          </div>

          {batchBusy && (
            <p className="flex items-start gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/10 px-3 py-2 text-xs leading-relaxed text-neon-violet">
              <Sparkles size={14} className="mt-0.5 shrink-0" />
              バックグラウンドで処理中です。タブを閉じたり再読み込みしても継続し、次に開いたときに結果が表示されます。
            </p>
          )}

          {batchPhase === "error" && batchError && (
            <p className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {batchError}
            </p>
          )}

          {loraReturnable.length > 0 && (
            <button
              type="button"
              onClick={() => void handleReturnToLora()}
              disabled={returningToLora}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 flow-next"
            >
              {returningToLora ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  LoRA Studio へ戻しています…
                </>
              ) : (
                <>
                  <Wand2 size={16} />
                  拡大した {loraReturnable.length} 枚を LoRA Studio に戻して差し替える
                </>
              )}
            </button>
          )}

          {batchCompletedUrls.length > 0 && (
            <button
              type="button"
              onClick={handleDownloadAll}
              disabled={downloadingAll}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:border-neon-violet/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {downloadingAll ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  ダウンロード中…
                </>
              ) : (
                <>
                  <Download size={16} />
                  完了した {batchCompletedUrls.length} 枚をまとめてダウンロード
                </>
              )}
            </button>
          )}

          {batchJobIds.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {batchJobIds.map((id) => (
                <BatchResultCard key={id} job={batchJobs[id]} />
              ))}
            </div>
          )}

          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
            <ImagePlus size={14} className="mt-0.5 shrink-0 text-neon-violet" />
            {user
              ? "同じ倍率でまとめて処理します。コールドスタートはバッチ全体で1回分だけなので、1枚ずつより割安です。"
              : "超解像スタジオの利用にはログインが必要です。初回登録で10クレジットが付与されます。"}
          </p>
        </div>
      </div>
      )}

      {user && sessionJobs.length > 1 && (
        <StudioSessionList entries={sessionJobs} currentId={jobId} busy={busy} onShow={handleShowSession} />
      )}
      <SessionResetConfirmModal
        open={sessionResetOpen}
        onCancel={() => {
          pendingFreshRef.current = null;
          setSessionResetOpen(false);
        }}
        onConfirm={() => {
          setSessionResetOpen(false);
          const snap = pendingFreshRef.current;
          pendingFreshRef.current = null;
          if (snap) void runGenerate(snap);
        }}
      />
      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        message="超解像スタジオを利用するにはログインしてください。"
      />
      <InsufficientCreditsModal
        open={chargeOpen}
        onClose={() => setChargeOpen(false)}
        credits={credits}
        cost={(uiMode === "batch" ? batchTotalCredits : cost) || 8}
      />
      <QueueChoiceModal
        open={queueChoiceOpen}
        surcharge={upscalePriorityParallelSurcharge(knobs, cost)}
        total={cost + upscalePriorityParallelSurcharge(knobs, cost)}
        onCancel={() => setQueueChoiceOpen(false)}
        onQueue={handleQueueWait}
        onParallel={handleQueueParallel}
      />
    </div>
  );
}
