"use client";

// 動画の部分修正（2026-10-07〜）: 動画の気になる区間だけを作り直して、元の動画に貼り戻す。
// 元の動画は Cinematic Director の結果（「一部を作り直す」から渡る・ジョブ id だけ）か、持ち込みの動画。
// 境目は「なじませる」（前後の映像を手がかりに潜在の中でつなぐ）か「カット」（新しいショットとして作る）。
// 窓の計算・料金・GPU の振り分けは src/lib/videoFixPlan.ts（API と同じ関数）。ジョブは Director と同じ行・同じ順番待ち。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Download, Film, LogIn, Scissors, Sparkles, Wand2, X, Zap } from "lucide-react";
import { HelpNote } from "./HelpNote";
import { TopupActions } from "./TopupActions";
import { RefPhotoPicker, type RefPhoto } from "./RefPhotoPicker";
import { directorPriorityParallelSurcharge } from "@/lib/directorPricing";
import {
  DirectorJobNotFoundError,
  downloadDirectorVideo,
  pollDirectorJob,
  startVideoFixJob,
  type DirectorApiError,
  type DirectorJobStatus,
} from "@/lib/directorApi";
import {
  VIDEO_FIX_MAX_SOURCE_S,
  VIDEO_FIX_POSTROLL_S,
  VIDEO_FIX_PREROLL_S,
  VIDEO_FIX_PROMPT_MAX_LENGTH,
  videoFixQuote,
  type VideoFixQuote,
  type VideoFixSeam,
} from "@/lib/videoFixPlan";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { VramBadge } from "@/components/studio/VramBadge";
import AutoDownloadToggle from "@/components/studio/AutoDownloadToggle";
import GenerationCaveat from "@/components/studio/GenerationCaveat";
import { armAutoDownload, runAutoDownload, takeAutoDownload } from "@/lib/autoDownload";
import { advanceStudioQueue, cancelStudioQueue } from "@/lib/studioQueue";
import { takeVideoFixSource, VIDEO_FIX_EVENT, type VideoFixSourceHandoff } from "@/lib/studioHandoff";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useElapsedTimer, formatElapsedSeconds } from "@/hooks/useElapsedTimer";
import { useLocalWarmCountdown } from "@/hooks/useLocalWarmCountdown";
import {
  QueueChoiceModal,
  QueuedNextBanner,
  QueueNextButtonLabel,
  WarmCountdownBanner,
} from "@/components/studio/QueueChoiceModal";

type Phase = "idle" | "submitting" | "running" | "done" | "error";

const JOB_KEY = "video-fix-active-job";
const RESERVED_KEY = "video-fix-reserved-jobs";
// Director の結果を元にしているとき、そのジョブ id（再読み込みしても同じ動画を開き直す）。
const SOURCE_KEY = "video-fix-source-job";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_CONSECUTIVE_ERRORS = 8;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;

type Source =
  | { kind: "director"; jobId: string }
  | { kind: "upload"; file: File };

type SourceMeta = { durationS: number; width: number; height: number };

type Snapshot = {
  source: Source;
  meta: SourceMeta;
  startS: number;
  endS: number | null;
  seamStart: VideoFixSeam;
  seamEnd: VideoFixSeam;
  keepAudio: boolean;
  prompt: string;
  refs: RefPhoto[];
};

const PROMPT_EXAMPLE =
  "例: 同じ寝室で、カメラを見つめたまま笑顔で歌い続ける。手を軽く振りながら、カメラはゆっくり顔に寄っていく。";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fixFilename(jobId: string): string {
  return `ull_video_fix_${jobId.slice(0, 8)}.mp4`;
}

function fmtS(s: number): string {
  return `${Math.round(s * 10) / 10} 秒`;
}

/** 秒の入力欄の値 → 数値（空は null・不正は NaN）。「1:23」の分秒表記も受ける。 */
function parseSeconds(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const m = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function readVideoMeta(url: string): Promise<SourceMeta> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = () => {
      v.removeAttribute("src");
      v.load();
    };
    v.onloadedmetadata = () => {
      const meta = { durationS: v.duration, width: v.videoWidth, height: v.videoHeight };
      done();
      if (!Number.isFinite(meta.durationS) || !meta.width || !meta.height) reject(new Error("bad metadata"));
      else resolve(meta);
    };
    v.onerror = () => {
      done();
      reject(new Error("unreadable"));
    };
    v.src = url;
  });
}

function InsufficientCreditsModal({ open, onClose, credits, cost }: { open: boolean; onClose: () => void; credits: number | null; cost: number }) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm" onClick={onClose}>
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
        <TopupActions cost={cost} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}

function SeamPicker({
  label,
  value,
  onChange,
  disabled,
  disabledNote,
}: {
  label: string;
  value: VideoFixSeam;
  onChange: (v: VideoFixSeam) => void;
  disabled?: boolean;
  disabledNote?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted">{label}</label>
      {disabled ? (
        <p className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-muted">{disabledNote}</p>
      ) : (
        <div className="flex items-center gap-1 rounded-xl border border-border bg-background p-1">
          {(
            [
              ["blend", "なじませる"],
              ["cut", "カット"],
            ] as const
          ).map(([id, text]) => (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                value === id ? "bg-neon-violet/15 text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function VideoFixTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs } = usePricingKnobs();
  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [queueChoiceOpen, setQueueChoiceOpen] = useState(false);

  // --- 区間・境目・音声・指示 ---
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");
  const [seamStart, setSeamStart] = useState<VideoFixSeam>("blend");
  const [seamEnd, setSeamEnd] = useState<VideoFixSeam>("blend");
  const [keepAudio, setKeepAudio] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [refs, setRefs] = useState<RefPhoto[]>([]);

  // --- 元の動画 ---
  const [source, setSource] = useState<Source | null>(() => {
    const id = loadFormState<{ jobId: string }>(SOURCE_KEY)?.jobId;
    return id ? { kind: "director", jobId: id } : null;
  });
  const [sourceMeta, setSourceMeta] = useState<SourceMeta | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const sourceReloadsRef = useRef(0);

  // Director の結果の URL と長さ・寸法を取り直す（署名は 15 分で切れるので、表示に失敗したら取り直す）。
  const loadDirectorSource = useCallback(async (jobId: string) => {
    setSourceLoading(true);
    try {
      const j = await pollDirectorJob(jobId);
      if (j.status !== "completed" || !j.videoUrl || j.isPhoto) throw new Error("not a finished video");
      setSourceUrl(j.videoUrl);
      if (j.totalDurationS && j.outWidth && j.outHeight) {
        setSourceMeta({ durationS: j.totalDurationS, width: j.outWidth, height: j.outHeight });
      } else {
        setSourceMeta(await readVideoMeta(j.videoUrl));
      }
      setSourceError(null);
    } catch (err) {
      setSource(null);
      setSourceUrl(null);
      setSourceMeta(null);
      saveFormState(SOURCE_KEY, { jobId: "" });
      setSourceError(
        err instanceof DirectorJobNotFoundError
          ? "元の動画が見つかりませんでした。動画を持ち込んでお試しください。"
          : "元の動画を読み込めませんでした。動画を持ち込むか、もう一度お試しください。",
      );
    } finally {
      setSourceLoading(false);
    }
  }, []);

  const adoptDirectorSource = useCallback(
    (h: VideoFixSourceHandoff) => {
      sourceReloadsRef.current = 0;
      setSource({ kind: "director", jobId: h.jobId });
      saveFormState(SOURCE_KEY, { jobId: h.jobId });
      setStartText("");
      setEndText("");
      void loadDirectorSource(h.jobId);
    },
    [loadDirectorSource],
  );

  // Director から渡された動画（タブを開く前に渡された分と、開いたまま渡された分）。
  useEffect(() => {
    const h = takeVideoFixSource();
    if (h) queueMicrotask(() => adoptDirectorSource(h));
    else if (source?.kind === "director") queueMicrotask(() => void loadDirectorSource(source.jobId));
    const onSource = (e: Event) => {
      takeVideoFixSource();
      adoptDirectorSource((e as CustomEvent<VideoFixSourceHandoff>).detail);
    };
    window.addEventListener(VIDEO_FIX_EVENT, onSource);
    return () => window.removeEventListener(VIDEO_FIX_EVENT, onSource);
    // 初回だけ（source は復元した値を一度読むだけ）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickFile = async (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("video/") && !VIDEO_EXT.test(file.name)) {
      setSourceError("動画ファイル（MP4・MOV・WebM など）を選んでください。");
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const meta = await readVideoMeta(url);
      if (meta.durationS > VIDEO_FIX_MAX_SOURCE_S) {
        URL.revokeObjectURL(url);
        setSourceError(`動画は ${VIDEO_FIX_MAX_SOURCE_S / 60} 分までにしてください（この動画は ${Math.round(meta.durationS)} 秒）。`);
        return;
      }
      if (meta.durationS < 2) {
        URL.revokeObjectURL(url);
        setSourceError("動画が短すぎます（2 秒以上）。");
        return;
      }
      if (sourceUrl && source?.kind === "upload") URL.revokeObjectURL(sourceUrl);
      setSource({ kind: "upload", file });
      saveFormState(SOURCE_KEY, { jobId: "" });
      setSourceMeta(meta);
      setSourceUrl(url);
      setSourceError(null);
      setStartText("");
      setEndText("");
    } catch {
      URL.revokeObjectURL(url);
      setSourceError("この動画は読み込めませんでした。MP4（H.264）に書き出してからお試しください。");
    }
  };

  const clearSource = () => {
    if (sourceUrl && source?.kind === "upload") URL.revokeObjectURL(sourceUrl);
    setSource(null);
    setSourceUrl(null);
    setSourceMeta(null);
    saveFormState(SOURCE_KEY, { jobId: "" });
  };

  // --- 区間・境目・音声・指示（宣言は上） ---
  const startS = parseSeconds(startText);
  const endS = parseSeconds(endText);
  const toEnd = endS == null;

  const setFromPlayhead = (which: "start" | "end") => {
    const t = previewRef.current?.currentTime;
    if (t == null || !Number.isFinite(t)) return;
    const v = String(Math.round(t * 10) / 10);
    if (which === "start") setStartText(v);
    else setEndText(v);
  };

  const quoteResult = useMemo((): { quote: VideoFixQuote | null; error: string | null } => {
    if (!sourceMeta) return { quote: null, error: null };
    if (startS == null) return { quote: null, error: null };
    if (Number.isNaN(startS) || (endS != null && Number.isNaN(endS))) return { quote: null, error: "秒は数字（例: 51.5 か 0:51.5）で入れてください。" };
    if (endS != null && endS > sourceMeta.durationS + 0.05) return { quote: null, error: `終了秒は動画の長さ（${fmtS(sourceMeta.durationS)}）までにしてください。` };
    if (endS != null && endS - startS < 1) return { quote: null, error: "作り直す区間は 1 秒以上にしてください。" };
    try {
      return {
        quote: videoFixQuote({
          durationS: sourceMeta.durationS,
          width: sourceMeta.width,
          height: sourceMeta.height,
          startS,
          endS,
          seamStart,
          seamEnd: toEnd ? "blend" : seamEnd,
          extraRefCount: refs.length,
          knobs,
        }),
        error: null,
      };
    } catch (err) {
      return { quote: null, error: err instanceof Error ? err.message : "区間の指定が正しくありません。" };
    }
  }, [sourceMeta, startS, endS, seamStart, seamEnd, toEnd, refs.length, knobs]);
  const quote = quoteResult.quote;
  const cost = quote?.credits ?? 0;
  const insufficientCredits = Boolean(user) && !creditsLoading && Boolean(quote) && (credits ?? 0) < cost;

  // --- ジョブ ---
  const [phase, setPhase] = useState<Phase>("idle");
  const [jobId, setJobId] = useState<string | null>(() => loadFormState<{ jobId: string }>(JOB_KEY)?.jobId || null);
  const [job, setJob] = useState<DirectorJobStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastSnapshot, setLastSnapshot] = useState<Snapshot | null>(null);
  const busy = phase === "submitting" || phase === "running";
  const elapsedMs = useElapsedTimer(phase === "running" && job?.status === "processing");
  const { isWarm: gpuWarm, remainingMs: gpuWarmMs, markWarm: markGpuWarm } = useLocalWarmCountdown(30);
  const resultReloadsRef = useRef(0);

  const trackedRef = useRef<string[]>(loadFormState<{ ids: string[] }>(RESERVED_KEY)?.ids ?? []);
  const [reservedIds, setReservedIds] = useState<string[]>([]);
  const [reserving, setReserving] = useState(0);
  const [queueError, setQueueError] = useState<string | null>(null);

  const buildSnapshot = (): Snapshot | null => {
    if (!source || !sourceMeta) {
      setSourceError("作り直す動画を入れてください。");
      return null;
    }
    if (!quote) {
      setErrorMessage(quoteResult.error ?? "作り直す区間の開始秒を入れてください。");
      setPhase("error");
      return null;
    }
    if (!prompt.trim()) {
      setErrorMessage("作り直す区間で何が起きるかを書いてください。");
      setPhase("error");
      return null;
    }
    return {
      source,
      meta: sourceMeta,
      startS: startS as number,
      endS,
      seamStart,
      seamEnd: toEnd ? "blend" : seamEnd,
      keepAudio,
      prompt: prompt.trim(),
      refs,
    };
  };

  const start = useCallback(
    (s: Snapshot, opts: { priority?: boolean; queue?: boolean } = {}) => {
      if (!user) throw new Error("ログインが必要です。");
      return startVideoFixJob({
        userId: user.id,
        source: s.source.kind === "director" ? { jobId: s.source.jobId } : { file: s.source.file, ...s.meta },
        startS: s.startS,
        endS: s.endS,
        seamStart: s.seamStart,
        seamEnd: s.seamEnd,
        keepAudio: s.keepAudio,
        prompt: s.prompt,
        extraRefs: s.refs.map((r) => r.file),
        extraRefRoles: s.refs.map((r) => r.role),
        ...opts,
      });
    },
    [user],
  );

  const runGenerate = async (s: Snapshot, opts: { priority?: boolean } = {}) => {
    if (!user) return;
    setPhase("submitting");
    setErrorMessage(null);
    setActionError(null);
    setJob(null);
    try {
      const res = await start(s, opts);
      broadcastCreditsUpdate(user.id, res.remainingCredits);
      armAutoDownload(res.jobId);
      setLastSnapshot(s);
      resultReloadsRef.current = 0;
      setJobId(res.jobId);
      setPhase("running");
    } catch (err) {
      const e = err as DirectorApiError;
      if (typeof e.remainingCredits === "number") broadcastCreditsUpdate(user.id, e.remainingCredits);
      setPhase("error");
      setErrorMessage(e.message || "ジョブの作成に失敗しました。");
      if (e.message?.includes("クレジット")) setChargeOpen(true);
    }
  };

  const handleRun = () => {
    if (!user) return setLoginOpen(true);
    const s = buildSnapshot();
    if (!s) return;
    if (busy) return setQueueChoiceOpen(true);
    if (insufficientCredits) return setChargeOpen(true);
    void runGenerate(s);
  };

  const followJob = useCallback((id: string) => {
    trackedRef.current = trackedRef.current.filter((x) => x !== id);
    saveFormState(RESERVED_KEY, { ids: trackedRef.current });
    resultReloadsRef.current = 0;
    setErrorMessage(null);
    setJob(null);
    setJobId(id);
    setPhase("running");
  }, []);

  const advanceAndFollow = useCallback(
    async (follow: boolean) => {
      const q = await advanceStudioQueue("director");
      if (!q) return;
      setReservedIds(q.reserved.filter((id) => trackedRef.current.includes(id)));
      if (!follow) return;
      const moved = trackedRef.current.filter((id) => !q.reserved.includes(id));
      const next = q.started && moved.includes(q.started) ? q.started : (moved[0] ?? null);
      if (next) followJob(next);
    },
    [followJob],
  );

  const resumedJobId = useMemo(() => loadFormState<{ jobId: string }>(JOB_KEY)?.jobId || null, []);
  useEffect(() => {
    if (!user) return;
    queueMicrotask(() => void advanceAndFollow(!resumedJobId));
  }, [user, resumedJobId, advanceAndFollow]);

  const reserve = async (s: Snapshot) => {
    if (!user) return;
    setQueueError(null);
    setReserving((n) => n + 1);
    try {
      const res = await start(s, { queue: true });
      broadcastCreditsUpdate(user.id, res.remainingCredits);
      armAutoDownload(res.jobId);
      setLastSnapshot(s);
      trackedRef.current = [...trackedRef.current.filter((x) => x !== res.jobId), res.jobId];
      saveFormState(RESERVED_KEY, { ids: trackedRef.current });
      if (res.reserved) setReservedIds((prev) => (prev.includes(res.jobId) ? prev : [...prev, res.jobId]));
      else followJob(res.jobId);
    } catch (err) {
      const e = err as DirectorApiError;
      if (typeof e.remainingCredits === "number") broadcastCreditsUpdate(user.id, e.remainingCredits);
      setQueueError(e.message || "予約に失敗しました。");
    } finally {
      setReserving((n) => n - 1);
    }
  };

  const handleQueueWait = async () => {
    const s = buildSnapshot();
    if (!s || !user) return;
    setQueueChoiceOpen(false);
    if (insufficientCredits) return setChargeOpen(true);
    await reserve(s);
  };

  const handleQueueParallel = () => {
    const s = buildSnapshot();
    if (!s) return;
    setQueueChoiceOpen(false);
    if (!creditsLoading && (credits ?? 0) < cost + directorPriorityParallelSurcharge(knobs, cost)) return setChargeOpen(true);
    void runGenerate(s, { priority: true });
  };

  const handleCancelQueue = async () => {
    if (!user || reservedIds.length === 0) return;
    setQueueError(null);
    try {
      const r = await cancelStudioQueue("director", reservedIds);
      if (r.remainingCredits != null) broadcastCreditsUpdate(user.id, r.remainingCredits);
      trackedRef.current = trackedRef.current.filter((x) => !r.cancelled.includes(x));
      saveFormState(RESERVED_KEY, { ids: trackedRef.current });
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : "予約の取り消しに失敗しました。");
    }
    void advanceAndFollow(false);
  };

  // --- ポーリング（完了しても job key は消さない＝リロードしても結果が出る、CLAUDE.md §6-1） ---
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let errorStreak = 0;
    let sawInProgress = false;
    saveFormState(JOB_KEY, { jobId });
    (async () => {
      while (!cancelled) {
        try {
          const next = await pollDirectorJob(jobId);
          if (cancelled) return;
          errorStreak = 0;
          setJob(next);
          if (next.status === "completed") {
            setPhase("done");
            if (sawInProgress) markGpuWarm();
            if (next.videoUrl && takeAutoDownload(jobId)) {
              runAutoDownload("VideoFixTab", async () => {
                // 署名は 15 分で切れるので、保存する時点で取り直す（CLAUDE.md §6-11）。
                const fresh = (await pollDirectorJob(jobId)).videoUrl;
                if (fresh) await downloadDirectorVideo(fresh, fixFilename(jobId));
              });
            }
            void advanceAndFollow(true);
            return;
          }
          if (next.status === "failed") {
            setPhase("error");
            setErrorMessage(next.errorMessage || "生成に失敗しました。");
            void advanceAndFollow(false);
            return;
          }
          sawInProgress = true;
          setPhase("running");
        } catch (err) {
          if (cancelled) return;
          if (err instanceof DirectorJobNotFoundError) {
            setPhase("error");
            setErrorMessage("このジョブの記録が見つかりませんでした。お手数ですが新しく作り直してください。");
            saveFormState(JOB_KEY, { jobId: "" });
            return;
          }
          errorStreak += 1;
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
  }, [jobId, markGpuWarm, advanceAndFollow]);

  const refreshResult = useCallback(async (): Promise<string | null> => {
    if (!jobId) return null;
    try {
      const next = await pollDirectorJob(jobId);
      setJob(next);
      return next.videoUrl;
    } catch {
      return null;
    }
  }, [jobId]);

  const handleDownload = async () => {
    if (!jobId) return;
    setActionError(null);
    const url = await refreshResult();
    if (!url) return setActionError("動画の取得に失敗しました。時間をおいてもう一度お試しください。");
    downloadDirectorVideo(url, fixFilename(jobId)).catch((err) => {
      console.error("[VideoFixTab] download failed:", err);
      setActionError("ダウンロードに失敗しました。");
    });
  };

  // 直した動画を、さらに直す元にする（別の区間を続けて直す）。
  const handleFixAgain = () => {
    if (!jobId) return;
    adoptDirectorSource({ jobId, durationS: job?.totalDurationS ?? null });
    setPrompt("");
    setTimeout(() => previewRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  // 同じ指定でもう一度（揺れだけ変わる）。指定はこの画面で送ったときのものだけ覚えている。
  const handleRetry = () => {
    if (!lastSnapshot) return;
    if (busy) return setQueueChoiceOpen(true);
    void runGenerate(lastSnapshot);
  };

  const canRun = Boolean(source && sourceMeta && quote && prompt.trim()) && phase !== "submitting";
  const chargeFirst = Boolean(user) && insufficientCredits && !busy;
  const cuts = job?.isVideoFix ? job.videoFixCuts : null;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      <InsufficientCreditsModal open={chargeOpen} onClose={() => setChargeOpen(false)} credits={credits} cost={cost} />
      <QueueChoiceModal
        open={queueChoiceOpen}
        surcharge={directorPriorityParallelSurcharge(knobs, cost)}
        total={cost + directorPriorityParallelSurcharge(knobs, cost)}
        queueCost={cost}
        onCancel={() => setQueueChoiceOpen(false)}
        onQueue={() => void handleQueueWait()}
        onParallel={handleQueueParallel}
      />

      {/* --- 入力 --- */}
      <div className="space-y-5 rounded-2xl border border-border bg-surface p-5">
        <div>
          <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">作り直す動画</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,.mp4,.mov,.m4v,.webm,.mkv"
            className="hidden"
            onChange={(e) => {
              void pickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {source ? (
            <div className="relative overflow-hidden rounded-xl border border-border bg-background">
              {sourceUrl ? (
                <video
                  ref={previewRef}
                  src={sourceUrl}
                  controls
                  playsInline
                  className="mx-auto max-h-80 w-full bg-black object-contain"
                  onError={() => {
                    if (source.kind !== "director" || sourceReloadsRef.current >= 2) return;
                    sourceReloadsRef.current += 1;
                    setTimeout(() => void loadDirectorSource(source.jobId), 1500);
                  }}
                />
              ) : (
                <p className="px-4 py-10 text-center text-xs text-muted">{sourceLoading ? "動画を読み込んでいます…" : ""}</p>
              )}
              <button
                type="button"
                onClick={clearSource}
                className="absolute right-2 top-2 rounded bg-black/60 p-1 text-white transition-colors hover:bg-black/80"
                aria-label="動画を外す"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void pickFile(e.dataTransfer.files?.[0]);
              }}
              className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-10 transition-colors ${
                dragging ? "border-neon-pink/60 bg-neon-pink/5" : "border-border hover:border-neon-violet/40"
              }`}
            >
              <Film size={28} className="text-muted" />
              <span className="text-sm font-medium text-foreground">直したい動画をドロップ / 選択</span>
              <span className="text-[11px] text-muted">
                Cinematic Director の動画は、結果の「一部を作り直す」からも送れます（{VIDEO_FIX_MAX_SOURCE_S / 60} 分まで）
              </span>
            </button>
          )}
          {sourceMeta && (
            <p className="mt-1.5 text-[11px] text-muted">
              長さ <span className="font-mono text-foreground">{fmtS(sourceMeta.durationS)}</span>・
              {source?.kind === "director" ? "Cinematic Director の動画" : "持ち込みの動画"}
            </p>
          )}
          {sourceError && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-red-400">
              <AlertTriangle size={12} className="shrink-0" />
              {sourceError}
            </p>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">作り直す区間</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-muted">開始（秒）</label>
              <div className="flex gap-1.5">
                <input
                  value={startText}
                  onChange={(e) => setStartText(e.target.value)}
                  inputMode="decimal"
                  placeholder="例: 50"
                  className="w-full min-w-0 rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-sm text-foreground"
                />
                <button
                  type="button"
                  onClick={() => setFromPlayhead("start")}
                  disabled={!sourceUrl}
                  className="shrink-0 rounded-lg border border-border bg-background px-2 text-[11px] text-muted transition-colors hover:text-foreground disabled:opacity-40"
                >
                  今の位置
                </button>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted">終了（秒・空欄で最後まで）</label>
              <div className="flex gap-1.5">
                <input
                  value={endText}
                  onChange={(e) => setEndText(e.target.value)}
                  inputMode="decimal"
                  placeholder="最後まで"
                  className="w-full min-w-0 rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-sm text-foreground"
                />
                <button
                  type="button"
                  onClick={() => setFromPlayhead("end")}
                  disabled={!sourceUrl}
                  className="shrink-0 rounded-lg border border-border bg-background px-2 text-[11px] text-muted transition-colors hover:text-foreground disabled:opacity-40"
                >
                  今の位置
                </button>
              </div>
            </div>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            動画を止めて「今の位置」を押すと、その秒が入ります。終了は、人物の動きやカメラが落ち着いたところに置くとつながりやすくなります。
          </p>
          {quoteResult.error && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-red-400">
              <AlertTriangle size={12} className="shrink-0" />
              {quoteResult.error}
            </p>
          )}
          {quote?.truncated && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-amber-400">
              1 回で作り直せる長さを超えるため、{fmtS(quote.regenStart / 24)}〜{fmtS(quote.regenEnd / 24)} を作り直し、その後ろは元のまま残します。
              続きは結果の「続けて直す」で作り直せます。
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <SeamPicker label="始まりのつなぎ方" value={seamStart} onChange={setSeamStart} />
          <SeamPicker
            label="終わりのつなぎ方"
            value={seamEnd}
            onChange={setSeamEnd}
            disabled={toEnd}
            disabledNote="最後まで作り直すので不要です"
          />
        </div>
        <HelpNote
          id="videofix.seam"
          title="なじませる・カットの選び方"
          summary="前後と同じ場面のまま直すなら「なじませる」、場面が変わってよいなら「カット」。"
        >
          「なじませる」は、区間の前（{VIDEO_FIX_PREROLL_S} 秒）と後ろ（{VIDEO_FIX_POSTROLL_S} 秒）の映像を手がかりにして、境目が自然につながるように作り直します。
          顔の崩れや、一瞬の不自然な動きを直すのに向いています。区間の後ろの映像と食い違う内容を書くと、区間の中で場面が急に切り替わることがあります。
          <br />
          「カット」は、前後の映像を手がかりにせず、新しいショットとして作ります。境目は映画のカット（場面の切り替え）になります。
          構図や場面を変えたいとき、前後とつながらない内容にしたいときに選んでください。
        </HelpNote>

        <div>
          <label className="mb-1 block text-xs text-muted">音声</label>
          <div className="flex items-center gap-1 rounded-xl border border-border bg-background p-1">
            {(
              [
                [true, "元のまま"],
                [false, "作り直す"],
              ] as const
            ).map(([v, text]) => (
              <button
                key={text}
                type="button"
                onClick={() => setKeepAudio(v)}
                className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                  keepAudio === v ? "bg-neon-violet/15 text-foreground" : "text-muted hover:text-foreground"
                }`}
              >
                {text}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            {keepAudio
              ? "歌やセリフは元の音声のまま残し、口の動きを合わせて作り直します。"
              : "作り直す区間の音（声・効果音）も新しく作ります。区間の外は元の音声のままです。"}
          </p>
        </div>

        <div>
          <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">作り直す区間で起きること</p>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, VIDEO_FIX_PROMPT_MAX_LENGTH))}
            rows={5}
            placeholder={PROMPT_EXAMPLE}
            className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60"
          />
          <p className="mt-1 text-right text-[10px] text-muted">
            {prompt.length} / {VIDEO_FIX_PROMPT_MAX_LENGTH}
          </p>
          <HelpNote
            id="videofix.prompt"
            title="うまく書くコツ"
            summary="場所・人物・服は前後と同じに書き、区間の中で起きることだけを変えます。してほしいことだけを書いてください。"
          >
            「振り向かない」「窓の外を見ない」のような打ち消しは、かえってその動きを呼びやすくなります。「カメラを見つめたまま歌い続ける」のように、してほしいことを書いてください。
            人物は、作り直す直前のコマを <span className="font-mono">Picture 1</span> として自動で使います。顔をより保ちたいときは、下に人物の写真を足してください（
            <span className="font-mono">Picture 2</span> から）。同じ指定でも、作り直すたびに少しずつ違う結果になります。
          </HelpNote>
        </div>

        <RefPhotoPicker value={refs} onChange={setRefs} label="写真を足す（任意）" />
      </div>

      {/* --- 実行と結果 --- */}
      <div className="space-y-4">
        <div className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted">
              <Scissors size={14} />
              動画の部分修正
            </span>
            <span className="font-mono font-medium text-neon-pink">{quote ? `${cost} Credits` : "—"}</span>
          </div>
          {quote && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              作り直す: <span className="font-mono text-foreground">{fmtS(quote.regenStart / 24)}〜{quote.toEnd ? "最後" : fmtS(quote.regenEnd / 24)}</span>
              ・処理する長さ <span className="font-mono text-foreground">{fmtS(quote.winSeconds)}</span>（前後の手がかりを含む）
              ・解像度 <span className="font-mono text-foreground">{quote.width}×{quote.height}px</span>
            </p>
          )}
          {!user ? (
            <button
              type="button"
              onClick={() => setLoginOpen(true)}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-background transition-all hover:opacity-90"
            >
              <LogIn size={16} />
              ログインして作り直す
            </button>
          ) : (
            <button
              type="button"
              onClick={chargeFirst ? () => setChargeOpen(true) : handleRun}
              disabled={!canRun && !chargeFirst}
              className={`mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 ${
                chargeFirst ? "bg-amber-600/80 text-white" : "bg-gradient-to-r from-neon-pink to-neon-violet text-background"
              }`}
            >
              {chargeFirst ? (
                <>
                  <Zap size={16} />
                  クレジットをチャージ
                </>
              ) : phase === "submitting" ? (
                "送信中..."
              ) : phase === "running" ? (
                <QueueNextButtonLabel
                  status={job?.status === "processing" ? `作り直し中 ${formatElapsedSeconds(elapsedMs)}` : "生成準備中（GPU 起動中）"}
                />
              ) : (
                "この区間を作り直す"
              )}
            </button>
          )}
          <GenerationCaveat />
          {user && (
            <div className="mt-2">
              <AutoDownloadToggle />
            </div>
          )}
          {!busy && gpuWarm && <WarmCountdownBanner remainingMs={gpuWarmMs} />}
          {busy && reservedIds.length === 0 && reserving === 0 && (
            <p className="mt-2 flex items-start gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/10 px-3 py-2 text-xs leading-relaxed text-neon-violet">
              <Sparkles size={14} className="mt-0.5 shrink-0" />
              {job?.status === "processing"
                ? "バックグラウンドで作り直し中です。もう一度ボタンを押すと、次の作り直しを予約できます。"
                : "生成準備中…GPU を起動しています（初回は 1〜2 分）。画面を閉じても作り直しは続きます。"}
            </p>
          )}
          {(reservedIds.length > 0 || reserving > 0) && (
            <div className="mt-2">
              <QueuedNextBanner count={reservedIds.length + reserving} serverSide onCancel={() => void handleCancelQueue()} />
            </div>
          )}
          {queueError && <p className="mt-2 text-xs text-red-400">{queueError}</p>}
        </div>

        {phase === "running" && job?.queue && job.queue.queuePosition > 0 && (
          <p className="text-center text-[11px] text-muted">
            順番待ち: 残り{job.queue.queuePosition}件（推定 約{Math.round(job.queue.estimatedWaitSeconds / 60)}分）
          </p>
        )}
        {phase === "running" && (
          <div className="flex justify-center">
            <VramBadge gb={job?.vramUsedGb ?? null} />
          </div>
        )}

        {phase === "error" && errorMessage && (
          <div className="flex items-start gap-1.5 rounded-xl border border-red-500/40 bg-red-500/5 px-3 py-2.5 text-[12px] leading-relaxed text-red-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="flex-1">{errorMessage}</span>
            <button
              type="button"
              onClick={() => {
                setPhase("idle");
                setErrorMessage(null);
                setJob(null);
                setJobId(null);
                saveFormState(JOB_KEY, { jobId: "" });
              }}
              aria-label="エラーを閉じる"
              className="shrink-0 text-red-300/70 transition-colors hover:text-red-200"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {phase === "done" && job?.videoUrl && (
          <div className="rounded-xl border border-border bg-background p-3">
            <video
              src={job.videoUrl}
              controls
              playsInline
              className="w-full rounded-lg bg-black object-contain"
              onError={() => {
                if (resultReloadsRef.current >= 2) return;
                resultReloadsRef.current += 1;
                setTimeout(() => void refreshResult(), 1500);
              }}
            />
            {cuts && cuts.length > 0 && (
              <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>
                  作り直した区間の {cuts.map((c) => fmtS(c)).join("・")} で場面が切り替わっています。区間の後ろの映像と内容が食い違うと起きやすくなります。
                  終了を動きの落ち着いたところへずらすか、終わりのつなぎ方を「カット」にするか、もう一度作り直してください。
                </span>
              </p>
            )}
            <div className="mt-3 grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => void handleDownload()}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
              >
                <Download size={12} />
                保存
              </button>
              <button
                type="button"
                onClick={handleFixAgain}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
              >
                <Scissors size={12} />
                続けて直す
              </button>
              <button
                type="button"
                onClick={handleRetry}
                disabled={!lastSnapshot}
                title={lastSnapshot ? "同じ指定で、別のパターンを作ります" : "この画面で送った指定だけ、もう一度作れます"}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Wand2 size={12} />
                別のパターン
              </button>
            </div>
            {job.outWidth != null && job.outHeight != null && (
              <p className="mt-2 text-center text-[11px] text-muted">
                解像度: <span className="font-mono text-foreground">{job.outWidth}×{job.outHeight}px</span>
              </p>
            )}
            {job.vramUsedGb != null && (
              <div className="mt-3 flex justify-center">
                <VramBadge gb={job.vramUsedGb} />
              </div>
            )}
          </div>
        )}
        {actionError && <p className="text-xs text-red-400">{actionError}</p>}
      </div>
    </div>
  );
}
