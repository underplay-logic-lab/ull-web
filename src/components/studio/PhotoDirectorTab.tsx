"use client";

// 📸 Photo Director（2026-10-06）: 参照写真（人物・持ち物・場所・画風、最大 9 枚）と「どんな写真か」から静止画を 1〜4 枚。
// 中身は Cinematic Director と同じ GPU・同じ土台で、参照モードを 5 フレームだけ回した 1 コマ目（cinematicWorkflow.ts の
// buildPhotoWorkflow）。ジョブも Director と同じ予約の順番に並ぶ（route は /api/director/generate の output: "photo"）。
// Studio タブの標準（CLAUDE.md §6）: リロードで消えない・見つからない専用エラー・VRAM バッジ・起動待ち表示・
// 実行中は順番待ち／並列・対応外ファイルのエラー・URL を使い回さない・切り抜かない・完了したら自動保存。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Camera, Clapperboard, Download, ImagePlus, LogIn, Sparkles, X, Zap } from "lucide-react";
import { HelpNote } from "./HelpNote";
import { TopupActions } from "./TopupActions";
import { RefPhotoPicker, type RefPhoto } from "./RefPhotoPicker";
import { RestrictedChoiceModal, UnrestrictedToggle } from "./RestrictedChoiceModal";
import {
  DIRECTOR_ASPECTS,
  PHOTO_COUNTS,
  PHOTO_IDEA_MAX_LENGTH,
  PHOTO_MIN_COUNT,
  directorPriorityParallelSurcharge,
  directorUnrestrictedScriptSurcharge,
  photoDirectorCredits,
  type DirectorAspectId,
} from "@/lib/directorPricing";
import {
  DirectorJobNotFoundError,
  pollDirectorJob,
  startPhotoJob,
  type DirectorApiError,
  type DirectorJobStatus,
  type DirectorScriptEngine,
} from "@/lib/directorApi";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { VramBadge } from "@/components/studio/VramBadge";
import AutoDownloadToggle from "@/components/studio/AutoDownloadToggle";
import GenerationCaveat from "@/components/studio/GenerationCaveat";
import { armAutoDownload, runAutoDownload, takeAutoDownload } from "@/lib/autoDownload";
import { advanceStudioQueue, cancelStudioQueue } from "@/lib/studioQueue";
import { requestStudioBatchHandoff } from "@/lib/studioHandoff";
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

const JOB_KEY = "photo-director-active-job";
// このブラウザで予約し、まだ画面に出していない予約（Director と同じサーバー側の順番）。
const RESERVED_KEY = "photo-director-reserved-jobs";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_CONSECUTIVE_ERRORS = 8;

type Snapshot = {
  image: File;
  idea: string;
  count: number;
  aspect: DirectorAspectId;
  refs: RefPhoto[];
  scriptEngine: DirectorScriptEngine;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadImage(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`画像の取得に失敗しました (${res.status})`);
  const objectUrl = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

function photoFilename(jobId: string, i: number): string {
  return `ull_photo_director_${jobId.slice(0, 8)}_${i + 1}.png`;
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

export function PhotoDirectorTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs } = usePricingKnobs();
  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [queueChoiceOpen, setQueueChoiceOpen] = useState(false);

  // --- 入力 ---
  const [image, setImage] = useState<File | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageUrl = useMemo(() => (image ? URL.createObjectURL(image) : null), [image]);
  useEffect(() => () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  }, [imageUrl]);
  const [refs, setRefs] = useState<RefPhoto[]>([]);
  const [aspect, setAspect] = useState<DirectorAspectId>("3:4");
  const [count, setCount] = useState<number>(PHOTO_MIN_COUNT);
  const [idea, setIdea] = useState("");
  // 制限なしモード（2026-10-06）: 最初から選ぶスイッチと、断られたときの「解除しますか？」。
  const [unrestricted, setUnrestricted] = useState(false);
  const [restrictedRetry, setRestrictedRetry] = useState<{ snapshot: Snapshot; opts: { priority?: boolean; queue?: boolean } } | null>(null);

  const pickImage = (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setImageError("画像ファイル（PNG・JPEG・WebP など）を選んでください。");
      return;
    }
    setImageError(null);
    setImage(file);
  };

  const unrestrictedSurcharge = directorUnrestrictedScriptSurcharge(knobs);
  const cost = photoDirectorCredits(count, refs.length, knobs) + (unrestricted ? unrestrictedSurcharge : 0);
  const insufficientCredits = Boolean(user) && !creditsLoading && (credits ?? 0) < cost;

  // --- ジョブ ---
  const [phase, setPhase] = useState<Phase>("idle");
  const [jobId, setJobId] = useState<string | null>(() => loadFormState<{ jobId: string }>(JOB_KEY)?.jobId || null);
  const [job, setJob] = useState<DirectorJobStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = phase === "submitting" || phase === "running";
  const elapsedMs = useElapsedTimer(phase === "running" && job?.status === "processing");
  const { isWarm: gpuWarm, remainingMs: gpuWarmMs, markWarm: markGpuWarm } = useLocalWarmCountdown(30);
  const reloadsRef = useRef<Record<number, number>>({});

  // 予約（サーバー側の順番待ち）。
  const trackedRef = useRef<string[]>(loadFormState<{ ids: string[] }>(RESERVED_KEY)?.ids ?? []);
  const [reservedIds, setReservedIds] = useState<string[]>([]);
  const [reserving, setReserving] = useState(0);
  const [queueError, setQueueError] = useState<string | null>(null);

  const buildSnapshot = (): Snapshot | null => {
    if (!image) {
      setImageError("人物の写真を入れてください。");
      return null;
    }
    if (!idea.trim()) {
      setErrorMessage("どんな写真にしたいかを書いてください。");
      setPhase("error");
      return null;
    }
    return { image, idea: idea.trim(), count, aspect, refs, scriptEngine: unrestricted ? "unrestricted" : "standard" };
  };

  const start = useCallback(
    (s: Snapshot, opts: { priority?: boolean; queue?: boolean } = {}) => {
      if (!user) throw new Error("ログインが必要です。");
      return startPhotoJob({
        userId: user.id,
        image: s.image,
        idea: s.idea,
        count: s.count,
        aspect: s.aspect,
        extraRefs: s.refs.map((r) => r.file),
        extraRefRoles: s.refs.map((r) => r.role),
        scriptEngine: s.scriptEngine,
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
      reloadsRef.current = {};
      setJobId(res.jobId);
      setPhase("running");
    } catch (err) {
      const e = err as DirectorApiError;
      if (typeof e.remainingCredits === "number") broadcastCreditsUpdate(user.id, e.remainingCredits);
      if (e.code === "restricted") {
        setPhase("idle");
        setRestrictedRetry({ snapshot: s, opts });
        return;
      }
      setPhase("error");
      setErrorMessage(e.message || "ジョブの作成に失敗しました。");
      if (e.message?.includes("クレジット")) setChargeOpen(true);
    }
  };

  const handleRun = () => {
    if (!user) return setLoginOpen(true);
    const s = buildSnapshot();
    if (!s) return;
    // 実行中に押したら「順番待ち」か「並列」かを選ばせる（CLAUDE.md §6-7）。クレジット不足より先。
    if (busy) return setQueueChoiceOpen(true);
    if (insufficientCredits) return setChargeOpen(true);
    void runGenerate(s);
  };

  const followJob = useCallback((id: string) => {
    trackedRef.current = trackedRef.current.filter((x) => x !== id);
    saveFormState(RESERVED_KEY, { ids: trackedRef.current });
    reloadsRef.current = {};
    setErrorMessage(null);
    setJob(null);
    setJobId(id);
    setPhase("running");
  }, []);

  // 順番が来ていれば次を起動させ、予約一覧を取り直す。follow: このタブで予約したジョブが始まっていれば画面を切り替える。
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

  const handleQueueWait = async () => {
    const s = buildSnapshot();
    if (!s || !user) return;
    setQueueChoiceOpen(false);
    if (insufficientCredits) return setChargeOpen(true);
    await reserve(s);
  };

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
      const e = err as DirectorApiError;
      if (typeof e.remainingCredits === "number") broadcastCreditsUpdate(user.id, e.remainingCredits);
      if (e.code === "restricted") setRestrictedRetry({ snapshot: s, opts: { queue: true } });
      else setQueueError(e.message || "予約に失敗しました。");
    } finally {
      setReserving((n) => n - 1);
    }
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
            if (next.imageUrls.length && takeAutoDownload(jobId)) {
              runAutoDownload("PhotoDirectorTab", async () => {
                // 署名は 15 分で切れるので、保存する時点で取り直す（CLAUDE.md §6-11）。
                const fresh = (await pollDirectorJob(jobId)).imageUrls;
                for (let i = 0; i < fresh.length; i++) await downloadImage(fresh[i], photoFilename(jobId, i));
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
            setErrorMessage("このジョブの記録が見つかりませんでした。お手数ですが新しく生成してください。");
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

  // 結果の URL は使い回さない: 表示に失敗したら取り直す（2 回まで）。
  const refreshUrls = useCallback(async (): Promise<string[]> => {
    if (!jobId) return [];
    try {
      const next = await pollDirectorJob(jobId);
      setJob(next);
      return next.imageUrls;
    } catch {
      return [];
    }
  }, [jobId]);

  const handleDownload = async (i: number) => {
    if (!jobId) return;
    setActionError(null);
    const url = (await refreshUrls())[i];
    if (!url) return setActionError("画像の取得に失敗しました。時間をおいてもう一度お試しください。");
    downloadImage(url, photoFilename(jobId, i)).catch((err) => {
      console.error("[PhotoDirectorTab] download failed:", err);
      setActionError("ダウンロードに失敗しました。");
    });
  };

  // 出来た写真を Director へ: その写真を 1 枚目（人物）にし、今の参照の「同じ人物」の写真を後ろに足す。
  const handleToDirector = async (i: number) => {
    if (!jobId) return;
    setActionError(null);
    try {
      const url = (await refreshUrls())[i];
      if (!url) throw new Error("no url");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const photo = new File([await res.blob()], photoFilename(jobId, i), { type: "image/png" });
      const people = [...(image ? [image] : []), ...refs.filter((r) => r.role === "person").map((r) => r.file)];
      requestStudioBatchHandoff(
        {
          files: [photo, ...people].slice(0, 9),
          source: "Photo Director の写真",
          hint: "写真を顔写真として使う設定にしました。",
        },
        "director",
      );
    } catch (err) {
      console.error("[PhotoDirectorTab] handoff failed:", err);
      setActionError("Director へ渡せませんでした。もう一度お試しください。");
    }
  };

  const canRun = Boolean(image) && idea.trim().length > 0 && phase !== "submitting";
  const chargeFirst = Boolean(user) && insufficientCredits && !busy;
  const imageUrls = job?.isPhoto ? job.imageUrls : [];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      <InsufficientCreditsModal open={chargeOpen} onClose={() => setChargeOpen(false)} credits={credits} cost={cost} />
      <RestrictedChoiceModal
        open={restrictedRetry != null}
        surcharge={unrestrictedSurcharge}
        onCancel={() => setRestrictedRetry(null)}
        onUnlock={() => {
          const r = restrictedRetry;
          setRestrictedRetry(null);
          if (!r) return;
          const s: Snapshot = { ...r.snapshot, scriptEngine: "unrestricted" };
          if (r.opts.queue) void reserve(s);
          else void runGenerate(s, r.opts);
        }}
      />
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
          <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">人物の写真</p>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              pickImage(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {image && imageUrl ? (
            <div className="relative overflow-hidden rounded-xl border border-border bg-background">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl} alt="人物の写真" className="mx-auto max-h-72 w-full object-contain" />
              <button
                type="button"
                onClick={() => setImage(null)}
                className="absolute right-2 top-2 rounded bg-black/60 p-1 text-white transition-colors hover:bg-black/80"
                aria-label="写真を外す"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pickImage(e.dataTransfer.files?.[0]);
              }}
              className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-10 transition-colors ${
                dragging ? "border-neon-pink/60 bg-neon-pink/5" : "border-border hover:border-neon-violet/40"
              }`}
            >
              <ImagePlus size={28} className="text-muted" />
              <span className="text-sm font-medium text-foreground">写したい人の写真をドロップ / 選択</span>
              <span className="text-[11px] text-muted">顔がはっきり写った写真がおすすめです</span>
            </button>
          )}
          {imageError && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-red-400">
              <AlertTriangle size={12} className="shrink-0" />
              {imageError}
            </p>
          )}
        </div>

        <RefPhotoPicker value={refs} onChange={setRefs} />

        <div>
          <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">どんな写真？</p>
          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value.slice(0, PHOTO_IDEA_MAX_LENGTH))}
            rows={4}
            placeholder="例: 夕方の屋上でギターを抱えて、カメラに向かってやさしく笑うバストアップ"
            className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60"
          />
          <p className="mt-1 text-right text-[10px] text-muted">
            {idea.length} / {PHOTO_IDEA_MAX_LENGTH}
          </p>
          <HelpNote
            id="photo.idea"
            title="うまく書くコツ"
            summary="写り方（顔のアップ・バストアップ・全身）、表情、服、場所、光の感じを書くと狙いどおりになりやすいです。"
          >
            動き（歩く・振り向く）は書かず、止まった 1 枚として書いてください。持ち物や場所は、写真を「持ち物」「場所」で入れると形や景色がそのまま出ます。
          </HelpNote>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted">画面の縦横</label>
            <select
              value={aspect}
              onChange={(e) => setAspect(e.target.value as DirectorAspectId)}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground"
            >
              {DIRECTOR_ASPECTS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">1 回で出す枚数</label>
            <select
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground"
            >
              {PHOTO_COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n} 枚
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="-mt-2 text-[11px] leading-relaxed text-muted">
          同じ指示で少しずつ違う写真を並べて出すので、気に入った 1 枚を選べます。まとめて出すほど 1 枚あたりが安くなります。
        </p>
        <UnrestrictedToggle checked={unrestricted} onChange={setUnrestricted} surcharge={unrestrictedSurcharge} />
      </div>

      {/* --- 実行と結果 --- */}
      <div className="space-y-4">
        <div className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted">
              <Camera size={14} />
              Photo Director
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
              ログインして生成
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
                  status={job?.status === "processing" ? `生成中 ${formatElapsedSeconds(elapsedMs)}` : "生成準備中（GPU 起動中）"}
                />
              ) : (
                "写真を作る"
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
                ? "バックグラウンドで生成中です。もう一度ボタンを押すと、次の生成を予約できます。"
                : "生成準備中…GPU を起動しています（初回は 1〜2 分）。画面を閉じても生成は続きます。"}
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
          <p className="flex items-start gap-1.5 rounded-xl border border-red-500/40 bg-red-500/5 px-3 py-2.5 text-[12px] leading-relaxed text-red-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {errorMessage}
          </p>
        )}

        {phase === "done" && imageUrls.length > 0 && (
          <div className="rounded-xl border border-border bg-background p-3">
            <div className={`grid gap-3 ${imageUrls.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
              {imageUrls.map((u, i) => (
                <div key={i} className="flex flex-col gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={u}
                    alt={`写真 ${i + 1}`}
                    className="w-full rounded-lg bg-surface object-contain"
                    onError={() => {
                      const n = reloadsRef.current[i] ?? 0;
                      if (n >= 2) return;
                      reloadsRef.current[i] = n + 1;
                      setTimeout(() => void refreshUrls(), 1500);
                    }}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleDownload(i)}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
                    >
                      <Download size={12} />
                      保存
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToDirector(i)}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
                    >
                      <Clapperboard size={12} />
                      動画にする
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {job?.vramUsedGb != null && (
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
