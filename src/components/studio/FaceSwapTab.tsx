"use client";

// 🔁 顔入れ替え（2026-10-09・許可制 face_swap_head）: 入れ替え先の画像の人の頭（顔＋髪型）を、参照の顔に入れ替える。
// 体・服・ポーズ・背景は入れ替え先のまま。2 人写っている画像は左右で指定して 1 人ずつ（2 人目は 1 人目の結果に重ねる）。
// 入れ替え先が白黒（漫画の原稿）なら、ワーカーが参照も白黒にそろえる（カラーの参照だと目だけ色が付くため）。
// Studio タブの標準（CLAUDE.md §6）: リロードで消えない・見つからない専用エラー・VRAM バッジ・起動待ち表示・
// 実行中は順番待ち／並列・対応外ファイルのエラー・URL を使い回さない・切り抜かない・完了したら自動保存。使うモデルの名前は出さない（§2）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Download, ImagePlus, LogIn, Repeat, Sparkles, X, Zap } from "lucide-react";
import { HelpNote } from "./HelpNote";
import { TopupActions } from "./TopupActions";
import { FACE_SWAP_MAX_PEOPLE, faceSwapCredits, faceSwapPriorityParallelSurcharge, type FaceSwapSide } from "@/lib/faceSwapPricing";
import {
  FaceSwapJobNotFoundError,
  fetchFaceSwapImage,
  pollFaceSwapJob,
  saveBlob,
  startFaceSwapJob,
  type FaceSwapApiError,
  type FaceSwapJobStatus,
} from "@/lib/faceSwapApi";
import { uploadStudioAsset } from "@/lib/studioUploads";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { VramBadge } from "@/components/studio/VramBadge";
import AutoDownloadToggle from "@/components/studio/AutoDownloadToggle";
import GenerationCaveat from "@/components/studio/GenerationCaveat";
import { armAutoDownload, runAutoDownload, takeAutoDownload } from "@/lib/autoDownload";
import { advanceStudioQueue, cancelStudioQueue } from "@/lib/studioQueue";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useElapsedTimer, formatElapsedSeconds } from "@/hooks/useElapsedTimer";
import { useLocalWarmCountdown } from "@/hooks/useLocalWarmCountdown";
import { PrevResultPanel } from "@/components/studio/PrevResultPanel";
import { QueueChoiceModal, QueuedNextBanner, QueueNextButtonLabel, WarmCountdownBanner } from "@/components/studio/QueueChoiceModal";

type Phase = "idle" | "submitting" | "running" | "done" | "error";
/** 誰を入れ替えるか。"both" は左右 2 人とも（顔を 2 枚入れる）。 */
type Target = "auto" | "left" | "right" | "both";

const JOB_KEY = "faceswap-active-job";
const RESERVED_KEY = "faceswap-reserved-jobs";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_CONSECUTIVE_ERRORS = 8;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

const TARGETS: { id: Target; label: string; sub: string }[] = [
  { id: "auto", label: "1 人だけ", sub: "写っているのが 1 人" },
  { id: "left", label: "左の人", sub: "2 人のうち左" },
  { id: "right", label: "右の人", sub: "2 人のうち右" },
  { id: "both", label: "2 人とも", sub: "左右それぞれ別の顔" },
];

type Snapshot = { body: File; faces: { file: File; side: FaceSwapSide }[] };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultFilename(jobId: string): string {
  return `ull_faceswap_${jobId.slice(0, 8)}.png`;
}

/** 画像かどうかを確かめ、だめなら理由を返す（CLAUDE.md §6-8: 黙って無視しない）。 */
function imageFileError(file: File): string | null {
  if (!file.type.startsWith("image/")) {
    return file.type.startsWith("video/") ? "動画は使えません。画像ファイルを選んでください。" : "画像ファイルのみ対応しています。";
  }
  if (file.size > MAX_INPUT_BYTES) return "画像ファイルが大きすぎます。25MB 以下の画像を選んでください。";
  return null;
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

/** 画像 1 枚の取り込み欄（ドロップ／選択・プレビュー・外す）。型の確認は親の onPick で行う。 */
function ImageSlot({
  label,
  hint,
  file,
  onPick,
  onClear,
}: {
  label: string;
  hint: string;
  file: File | null;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);

  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-foreground">{label}</p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
      {file && previewUrl ? (
        <div className="relative overflow-hidden rounded-xl border border-border bg-background">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt={label} className="mx-auto max-h-64 w-auto object-contain" />
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
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) onPick(f);
          }}
          className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center transition-colors ${
            dragging ? "border-neon-pink/60 bg-neon-pink/5" : "border-border bg-background hover:border-neon-violet/40"
          }`}
        >
          <ImagePlus size={24} className="text-muted" />
          <span className="text-xs font-medium text-foreground">ドロップ / 選択</span>
          <span className="text-[11px] text-muted">{hint}</span>
        </button>
      )}
    </div>
  );
}

export function FaceSwapTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs } = usePricingKnobs();
  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [queueChoiceOpen, setQueueChoiceOpen] = useState(false);

  // --- 入力（File はリロードで戻せないので保存しない） ---
  const [body, setBody] = useState<File | null>(null);
  const [target, setTarget] = useState<Target>("auto");
  const [faceA, setFaceA] = useState<File | null>(null);
  const [faceB, setFaceB] = useState<File | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const people = target === "both" ? FACE_SWAP_MAX_PEOPLE : 1;
  const cost = faceSwapCredits(people, knobs);
  const insufficientCredits = Boolean(user) && !creditsLoading && (credits ?? 0) < cost;

  // 同じ File を何度も上げない（入れ替え直し・予約のたびに上げ直さない）。
  const uploadedRef = useRef<WeakMap<File, string>>(new WeakMap());
  const uploadOnce = useCallback(
    async (file: File): Promise<string> => {
      if (!user) throw new Error("ログインが必要です。");
      const hit = uploadedRef.current.get(file);
      if (hit) return hit;
      const { path } = await uploadStudioAsset(user.id, file);
      uploadedRef.current.set(file, path);
      return path;
    },
    [user],
  );

  const pick = (setter: (f: File | null) => void) => (file: File) => {
    const err = imageFileError(file);
    if (err) return setInputError(err);
    setInputError(null);
    setter(file);
  };

  // --- ジョブ ---
  const [phase, setPhase] = useState<Phase>("idle");
  const [jobId, setJobId] = useState<string | null>(() => loadFormState<{ jobId: string }>(JOB_KEY)?.jobId || null);
  const [job, setJob] = useState<FaceSwapJobStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const busy = phase === "submitting" || phase === "running";
  const elapsedMs = useElapsedTimer(phase === "running" && job?.status === "processing");
  const { isWarm: gpuWarm, remainingMs: gpuWarmMs, markWarm: markGpuWarm } = useLocalWarmCountdown(30);

  // 前の結果（2026-10-09、studio-tab-patterns §7）: 予約した次の生成が始まっても直前の完了分を別枠で見せる（PrevResultPanel）。
  const [peekId, setPeekId] = useState<string | null>(null);
  const jobRefForPeek = useRef<typeof job>(null);
  useEffect(() => {
    jobRefForPeek.current = job;
  }, [job]);
  const trackedRef = useRef<string[]>(loadFormState<{ ids: string[] }>(RESERVED_KEY)?.ids ?? []);
  const [reservedIds, setReservedIds] = useState<string[]>([]);
  const [reserving, setReserving] = useState(0);
  const [queueError, setQueueError] = useState<string | null>(null);

  const buildSnapshot = (): Snapshot | null => {
    const fail = (msg: string) => {
      setInputError(msg);
      return null;
    };
    if (!body) return fail("入れ替え先の画像を入れてください。");
    if (target === "both") {
      if (!faceA || !faceB) return fail("左の人と右の人の顔を両方入れてください。");
      return { body, faces: [{ file: faceA, side: "left" }, { file: faceB, side: "right" }] };
    }
    if (!faceA) return fail("顔の画像を入れてください。");
    return { body, faces: [{ file: faceA, side: target }] };
  };

  const start = useCallback(
    async (s: Snapshot, opts: { priority?: boolean; queue?: boolean } = {}) => {
      setUploading(true);
      try {
        const bodyPath = await uploadOnce(s.body);
        const swaps = [];
        for (const f of s.faces) swaps.push({ facePath: await uploadOnce(f.file), side: f.side });
        return await startFaceSwapJob({ bodyPath, swaps, ...opts });
      } finally {
        setUploading(false);
      }
    },
    [uploadOnce],
  );

  const handleStartError = (err: unknown) => {
    const e = err as FaceSwapApiError;
    if (user && typeof e.remainingCredits === "number") broadcastCreditsUpdate(user.id, e.remainingCredits);
    setPhase("error");
    setErrorMessage(e.message || "顔入れ替えの開始に失敗しました。");
    if (e.message?.includes("クレジット")) setChargeOpen(true);
  };

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
      setJobId(res.jobId);
      setPhase("running");
    } catch (err) {
      handleStartError(err);
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
    const prevJob = jobRefForPeek.current;
    if (prevJob && prevJob.status === "completed") setPeekId(prevJob.jobId);
    trackedRef.current = trackedRef.current.filter((x) => x !== id);
    saveFormState(RESERVED_KEY, { ids: trackedRef.current });
    setErrorMessage(null);
    setJob(null);
    setJobId(id);
    setPhase("running");
  }, []);

  const advanceAndFollow = useCallback(
    async (follow: boolean) => {
      const q = await advanceStudioQueue("face_swap");
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
      trackedRef.current = [...trackedRef.current.filter((x) => x !== res.jobId), res.jobId];
      saveFormState(RESERVED_KEY, { ids: trackedRef.current });
      if (res.reserved) setReservedIds((prev) => (prev.includes(res.jobId) ? prev : [...prev, res.jobId]));
      else followJob(res.jobId);
    } catch (err) {
      const e = err as FaceSwapApiError;
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
    if (!creditsLoading && (credits ?? 0) < cost + faceSwapPriorityParallelSurcharge(knobs, cost)) return setChargeOpen(true);
    void runGenerate(s, { priority: true });
  };

  const handleCancelQueue = async () => {
    if (!user || reservedIds.length === 0) return;
    setQueueError(null);
    try {
      const r = await cancelStudioQueue("face_swap", reservedIds);
      if (r.remainingCredits != null) broadcastCreditsUpdate(user.id, r.remainingCredits);
      trackedRef.current = trackedRef.current.filter((x) => !r.cancelled.includes(x));
      saveFormState(RESERVED_KEY, { ids: trackedRef.current });
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : "予約の取り消しに失敗しました。");
    }
    void advanceAndFollow(false);
  };

  // --- ポーリング（完了しても job key は消さない、CLAUDE.md §6-1） ---
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let errorStreak = 0;
    let sawInProgress = false;
    saveFormState(JOB_KEY, { jobId });
    (async () => {
      while (!cancelled) {
        try {
          const next = await pollFaceSwapJob(jobId);
          if (cancelled) return;
          errorStreak = 0;
          setJob(next);
          if (next.status === "completed") {
            setPhase("done");
            if (sawInProgress) markGpuWarm();
            if (next.imageUrls.length && takeAutoDownload(jobId)) {
              runAutoDownload("FaceSwapTab", async () => {
                // 署名は 15 分で切れるので保存する時点で取り直す（CLAUDE.md §6-11）。
                const fresh = await pollFaceSwapJob(jobId);
                if (fresh.imageUrls[0]) saveBlob(await fetchFaceSwapImage(fresh.imageUrls[0]), resultFilename(jobId));
              });
            }
            void advanceAndFollow(true);
            return;
          }
          if (next.status === "failed" || next.status === "cancelled" || next.status === "failed_timeout") {
            setPhase("error");
            setErrorMessage(next.errorMessage ? "入れ替えできませんでした。クレジットは戻しています。" : "入れ替えできませんでした。");
            void advanceAndFollow(false);
            return;
          }
          sawInProgress = sawInProgress || next.status === "processing";
          setPhase("running");
        } catch (err) {
          if (cancelled) return;
          if (err instanceof FaceSwapJobNotFoundError) {
            setPhase("error");
            setErrorMessage("このジョブの記録が見つかりませんでした。お手数ですが新しく作ってください。");
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

  /** 署名 URL を取り直して画像を取ってくる（保存・入れ替え先への流用。URL は使い回さない、CLAUDE.md §6-11）。 */
  const fetchResult = async (): Promise<Blob | null> => {
    if (!jobId) return null;
    try {
      const next = await pollFaceSwapJob(jobId);
      setJob(next);
      return next.imageUrls[0] ? await fetchFaceSwapImage(next.imageUrls[0]) : null;
    } catch {
      return null;
    }
  };

  const handleDownload = async () => {
    if (!jobId) return;
    setActionError(null);
    const blob = await fetchResult();
    if (!blob) return setActionError("画像の取得に失敗しました。時間をおいてもう一度お試しください。");
    saveBlob(blob, resultFilename(jobId));
  };

  // 結果を入れ替え先にして続ける（3 人目を入れ替える・別の顔で試し直す）。
  const handleUseAsBody = async () => {
    if (!jobId) return;
    setActionError(null);
    const blob = await fetchResult();
    if (!blob) return setActionError("画像の取得に失敗しました。時間をおいてもう一度お試しください。");
    setBody(new File([blob], resultFilename(jobId), { type: blob.type || "image/png" }));
    setFaceA(null);
    setFaceB(null);
    setPhase("idle");
  };

  const reloadsRef = useRef(0);
  const ready = Boolean(body && faceA && (target !== "both" || faceB));
  const canRun = ready && phase !== "submitting";
  const chargeFirst = Boolean(user) && insufficientCredits && !busy;
  const resultUrl = job?.imageUrls[0] ?? null;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      <InsufficientCreditsModal open={chargeOpen} onClose={() => setChargeOpen(false)} credits={credits} cost={cost} />
      <QueueChoiceModal
        open={queueChoiceOpen}
        surcharge={faceSwapPriorityParallelSurcharge(knobs, cost)}
        total={cost + faceSwapPriorityParallelSurcharge(knobs, cost)}
        queueCost={cost}
        onCancel={() => setQueueChoiceOpen(false)}
        onQueue={() => void handleQueueWait()}
        onParallel={handleQueueParallel}
      />

      {/* --- 入力 --- */}
      <div className="space-y-5 rounded-2xl border border-border bg-surface p-5">
        <ImageSlot
          label="入れ替え先の画像"
          hint="体・服・ポーズ・背景はこの画像のまま残ります"
          file={body}
          onPick={pick(setBody)}
          onClear={() => setBody(null)}
        />

        <div>
          <p className="mb-1.5 text-xs font-medium text-foreground">入れ替える人</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {TARGETS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTarget(t.id)}
                className={`rounded-xl border px-2 py-2 text-xs transition-colors ${
                  target === t.id
                    ? "border-neon-pink/40 bg-neon-pink/10 text-neon-pink"
                    : "border-border bg-background text-muted hover:border-neon-violet/40 hover:text-foreground"
                }`}
              >
                <span className="block font-medium">{t.label}</span>
                <span className="block text-[10px] opacity-70">{t.sub}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={target === "both" ? "grid gap-4 sm:grid-cols-2" : undefined}>
          <ImageSlot
            label={target === "both" ? "左の人の顔" : "顔の画像"}
            hint="顔と髪型がはっきり写った 1 人の画像"
            file={faceA}
            onPick={pick(setFaceA)}
            onClear={() => setFaceA(null)}
          />
          {target === "both" && (
            <ImageSlot label="右の人の顔" hint="顔と髪型がはっきり写った 1 人の画像" file={faceB} onPick={pick(setFaceB)} onClear={() => setFaceB(null)} />
          )}
        </div>
        {inputError && <p className="text-xs text-red-400">{inputError}</p>}

        <HelpNote
          id="faceswap.howto"
          title="使い方のコツ"
          summary="顔と髪型が入れ替わり、表情・顔の向きは入れ替え先のまま残ります。"
        >
          <ul className="mt-1 list-disc space-y-1 pl-4">
            <li>白黒の漫画の原稿は、自動で白黒の顔にそろえて入れ替えます（カラーの顔写真のままで大丈夫です）。</li>
            <li>3 人以上写っている画像は、結果の「この結果をさらに入れ替える」で 1 人ずつ続けてください。</li>
            <li>画像全体を描き直すため、入れ替えた人のすぐ隣の細かい柄などが少し変わることがあります。</li>
          </ul>
        </HelpNote>
        <p className="text-[11px] leading-relaxed text-amber-300/90">
          実在の人の顔は、ご本人の同意があるものだけを使ってください。有名人や、同意のない人の顔への入れ替えは禁止です。
        </p>
      </div>

      {/* --- 実行と結果 --- */}
      <div className="space-y-4">
        <div className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted">
              <Repeat size={14} />
              顔入れ替え（{people} 人）
            </span>
            <span className="font-mono font-medium text-neon-pink">{cost} Credits</span>
          </div>
          {!user ? (
            <button
              type="button"
              onClick={() => setLoginOpen(true)}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-background transition-all hover:opacity-90"
            >
              <LogIn size={16} />
              ログインして使う
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
                uploading ? "画像を送信中..." : "準備中..."
              ) : phase === "running" ? (
                <QueueNextButtonLabel
                  status={
                    job?.status === "processing"
                      ? `入れ替え中 ${job.progressMessage ?? ""} ${formatElapsedSeconds(elapsedMs)}`
                      : "生成準備中（GPU 起動中）"
                  }
                />
              ) : (
                "顔を入れ替える"
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
                ? "バックグラウンドで入れ替え中です。画面を閉じても続きます。もう一度ボタンを押すと次を予約できます。"
                : "生成準備中…GPU を起動しています（初回は 1〜2 分）。画面を閉じても続きます。"}
            </p>
          )}
          {(reservedIds.length > 0 || reserving > 0) && (
            <div className="mt-2">
              <QueuedNextBanner count={reservedIds.length + reserving} serverSide onCancel={() => void handleCancelQueue()} />
            </div>
          )}
          {queueError && <p className="mt-2 text-xs text-red-400">{queueError}</p>}
        </div>

        {phase === "running" && (
          <div className="flex justify-center">
            <VramBadge gb={job?.vramUsedGb ?? null} />
          </div>
        )}

        {phase === "error" && errorMessage && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/5 px-3 py-2.5 text-[12px] leading-relaxed text-red-300">
            <p className="flex items-start gap-1.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {errorMessage}
            </p>
          </div>
        )}

        {phase === "done" && resultUrl && (
          <div className="space-y-3 rounded-xl border border-border bg-background p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={resultUrl}
              alt="入れ替えた結果"
              className="mx-auto max-h-[32rem] w-auto rounded-lg bg-surface object-contain"
              onError={() => {
                if (reloadsRef.current >= 2) return;
                reloadsRef.current += 1;
                setTimeout(() => void fetchResult(), 1500);
              }}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleDownload()}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
              >
                <Download size={12} />
                保存
              </button>
              <button
                type="button"
                onClick={() => void handleUseAsBody()}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
              >
                <Repeat size={12} />
                この結果をさらに入れ替える
              </button>
            </div>
            {job?.vramUsedGb != null && (
              <div className="flex justify-center">
                <VramBadge gb={job.vramUsedGb} />
              </div>
            )}
          </div>
        )}
        {actionError && <p className="text-xs text-red-400">{actionError}</p>}
        {peekId && peekId !== jobId && (
          <PrevResultPanel
            key={peekId}
            kind="image"
            resolveUrl={async () => (await pollFaceSwapJob(peekId)).imageUrls[0] ?? null}
            onDownload={async (url) => saveBlob(await fetchFaceSwapImage(url), resultFilename(peekId))}
            onClose={() => setPeekId(null)}
          />
        )}
      </div>
    </div>
  );
}
