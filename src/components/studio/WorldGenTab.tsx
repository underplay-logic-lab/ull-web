"use client";

// 🏠 背景づくり（360°）（2026-10-10・許可制 worldgen_trial）: 部屋の説明（または部屋の画像 1 枚）から 360 度の部屋を作り、
// 画面で見回して、好きな向き・画角で背景用の画像を書き出す。1 枚のパノラマから切り出すので、どの向きでも物の位置がそろう
// （漫画の背景の「同じ部屋を別アングルで」用）。絵柄は写真寄りなので、漫画にするならクリスタの LT 変換などで仕上げる。
// Studio タブの標準（CLAUDE.md §6）: リロードで消えない・見つからない専用エラー・VRAM バッジ・起動待ち表示・
// 実行中は順番待ち／並列・対応外ファイルのエラー・URL を使い回さない・前の結果・完了したら自動保存。使うモデルの名前は出さない（§2）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Download, Home, ImagePlus, LogIn, Sparkles, X, Zap } from "lucide-react";
import { HelpNote } from "./HelpNote";
import { TopupActions } from "./TopupActions";
import { PanoramaViewer } from "./PanoramaViewer";
import { WORLDGEN_PROMPT_MAX_LENGTH, worldgenCredits, worldgenPriorityParallelSurcharge } from "@/lib/worldgenPricing";
import {
  WorldgenJobNotFoundError,
  fetchBlob,
  pollWorldgenJob,
  saveBlob,
  startWorldgenJob,
  type WorldgenApiError,
  type WorldgenJobStatus,
} from "@/lib/worldgenApi";
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
type Mode = "t2s" | "i2s";

const JOB_KEY = "worldgen-active-job";
const RESERVED_KEY = "worldgen-reserved-jobs";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_CONSECUTIVE_ERRORS = 8;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const PROMPT_EXAMPLE = "日本のアパートのリビングとキッチン。角に白い冷蔵庫、灰色のソファ、低い木のテーブル、カーテンの窓、木の床";

type Snapshot = { mode: Mode; prompt: string; image: File | null };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function panoFilename(jobId: string): string {
  return `ull_room360_${jobId.slice(0, 8)}.png`;
}

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

export function WorldGenTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs } = usePricingKnobs();
  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [queueChoiceOpen, setQueueChoiceOpen] = useState(false);

  // --- 入力 ---
  const [mode, setMode] = useState<Mode>("t2s");
  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const imagePreview = useMemo(() => (image ? URL.createObjectURL(image) : null), [image]);
  useEffect(() => () => void (imagePreview && URL.revokeObjectURL(imagePreview)), [imagePreview]);
  const cost = worldgenCredits(knobs);
  const insufficientCredits = Boolean(user) && !creditsLoading && (credits ?? 0) < cost;

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

  const pickImage = (file: File) => {
    const err = imageFileError(file);
    if (err) return setInputError(err);
    setInputError(null);
    setImage(file);
  };

  // --- ジョブ ---
  const [phase, setPhase] = useState<Phase>("idle");
  const [jobId, setJobId] = useState<string | null>(() => loadFormState<{ jobId: string }>(JOB_KEY)?.jobId || null);
  const [job, setJob] = useState<WorldgenJobStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const busy = phase === "submitting" || phase === "running";
  const elapsedMs = useElapsedTimer(phase === "running" && job?.status === "processing");
  const { isWarm: gpuWarm, remainingMs: gpuWarmMs, markWarm: markGpuWarm } = useLocalWarmCountdown(30);

  // 前の結果（studio-tab-patterns §7）: 予約した次の生成が始まっても直前の完了分を別枠で見せる。
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
    if (mode === "t2s" && !prompt.trim()) {
      setInputError("どんな部屋にしたいかを書いてください。");
      return null;
    }
    if (mode === "i2s" && !image) {
      setInputError("部屋の画像を入れてください。");
      return null;
    }
    return { mode, prompt: prompt.trim(), image: mode === "i2s" ? image : null };
  };

  const start = useCallback(
    async (s: Snapshot, opts: { priority?: boolean; queue?: boolean } = {}) => {
      setUploading(s.mode === "i2s");
      try {
        const imagePath = s.mode === "i2s" && s.image ? await uploadOnce(s.image) : undefined;
        return await startWorldgenJob({ mode: s.mode, prompt: s.prompt || undefined, imagePath, ...opts });
      } finally {
        setUploading(false);
      }
    },
    [uploadOnce],
  );

  const handleStartError = (err: unknown) => {
    const e = err as WorldgenApiError;
    if (user && typeof e.remainingCredits === "number") broadcastCreditsUpdate(user.id, e.remainingCredits);
    setPhase("error");
    setErrorMessage(e.message || "背景づくりの開始に失敗しました。");
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

  const followJob = useCallback(
    (id: string) => {
      const prevJob = jobRefForPeek.current;
      if (prevJob && prevJob.status === "completed") setPeekId(prevJob.jobId);
      trackedRef.current = trackedRef.current.filter((x) => x !== id);
      saveFormState(RESERVED_KEY, { ids: trackedRef.current });
      setErrorMessage(null);
      setJob(null);
      setJobId(id);
      setPhase("running");
    },
    [setPeekId],
  );

  const advanceAndFollow = useCallback(
    async (follow: boolean) => {
      const q = await advanceStudioQueue("worldgen");
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
      const e = err as WorldgenApiError;
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
    if (!creditsLoading && (credits ?? 0) < cost + worldgenPriorityParallelSurcharge(knobs, cost)) return setChargeOpen(true);
    void runGenerate(s, { priority: true });
  };

  const handleCancelQueue = async () => {
    if (!user || reservedIds.length === 0) return;
    setQueueError(null);
    try {
      const r = await cancelStudioQueue("worldgen", reservedIds);
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
          const next = await pollWorldgenJob(jobId);
          if (cancelled) return;
          errorStreak = 0;
          setJob(next);
          if (next.status === "completed") {
            setPhase("done");
            if (sawInProgress) markGpuWarm();
            if (next.panoUrl && takeAutoDownload(jobId)) {
              runAutoDownload("WorldGenTab", async () => {
                // 署名は 15 分で切れるので保存する時点で取り直す（CLAUDE.md §6-11）。
                const fresh = await pollWorldgenJob(jobId);
                if (fresh.panoUrl) saveBlob(await fetchBlob(fresh.panoUrl), panoFilename(jobId));
              });
            }
            void advanceAndFollow(true);
            return;
          }
          if (next.status === "failed" || next.status === "cancelled" || next.status === "failed_timeout") {
            setPhase("error");
            setErrorMessage(next.errorMessage ? "部屋を作れませんでした。クレジットは戻しています。" : "部屋を作れませんでした。");
            void advanceAndFollow(false);
            return;
          }
          sawInProgress = sawInProgress || next.status === "processing";
          setPhase("running");
        } catch (err) {
          if (cancelled) return;
          if (err instanceof WorldgenJobNotFoundError) {
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

  /** 署名 URL を取り直す（表示の失敗時・保存時。URL は使い回さない、CLAUDE.md §6-11）。 */
  const refreshJob = useCallback(async (): Promise<WorldgenJobStatus | null> => {
    if (!jobId) return null;
    try {
      const next = await pollWorldgenJob(jobId);
      setJob(next);
      return next;
    } catch {
      return null;
    }
  }, [jobId]);

  const handleDownload = async (kind: "pano" | "ply") => {
    if (!jobId) return;
    setActionError(null);
    const next = await refreshJob();
    const url = kind === "pano" ? next?.panoUrl : next?.plyUrl;
    if (!url) return setActionError("ファイルの取得に失敗しました。時間をおいてもう一度お試しください。");
    try {
      saveBlob(await fetchBlob(url), kind === "pano" ? panoFilename(jobId) : panoFilename(jobId).replace(/\.png$/, ".ply"));
    } catch (err) {
      console.error("[WorldGenTab] download failed:", err);
      setActionError("ダウンロードに失敗しました。");
    }
  };

  const reloadsRef = useRef(0);
  const onViewerError = useCallback(() => {
    if (reloadsRef.current >= 2) return;
    reloadsRef.current += 1;
    setTimeout(() => void refreshJob(), 1500);
  }, [refreshJob]);

  const canRun = (mode === "t2s" ? prompt.trim().length > 0 : Boolean(image)) && phase !== "submitting";
  const chargeFirst = Boolean(user) && insufficientCredits && !busy;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      <InsufficientCreditsModal open={chargeOpen} onClose={() => setChargeOpen(false)} credits={credits} cost={cost} />
      <QueueChoiceModal
        open={queueChoiceOpen}
        surcharge={worldgenPriorityParallelSurcharge(knobs, cost)}
        total={cost + worldgenPriorityParallelSurcharge(knobs, cost)}
        queueCost={cost}
        onCancel={() => setQueueChoiceOpen(false)}
        onQueue={() => void handleQueueWait()}
        onParallel={handleQueueParallel}
      />

      {/* --- 入力 --- */}
      <div className="space-y-5 rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-background p-1">
          {(
            [
              { id: "t2s", label: "説明から", sub: "どんな部屋かを書く" },
              { id: "i2s", label: "画像から", sub: "部屋の画像 1 枚" },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                setMode(m.id);
                setInputError(null);
              }}
              className={`flex-1 rounded-lg px-3 py-2 text-xs transition-colors ${
                mode === m.id ? "bg-neon-pink/10 text-neon-pink" : "text-muted hover:text-foreground"
              }`}
            >
              <span className="block font-medium">{m.label}</span>
              <span className="block text-[10px] opacity-70">{m.sub}</span>
            </button>
          ))}
        </div>

        {mode === "t2s" ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-foreground">どんな部屋？</p>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, WORLDGEN_PROMPT_MAX_LENGTH))}
              rows={5}
              placeholder={PROMPT_EXAMPLE}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-neon-violet/50"
            />
            <div className="mt-1 flex items-start justify-between gap-2 text-[11px] leading-relaxed text-muted">
              <p>
                部屋の種類 → 置きたい物の順に、短く書いてください。大事な物から書くと出やすくなります。
              </p>
              <span className="shrink-0 text-[10px]">
                {prompt.length} / {WORLDGEN_PROMPT_MAX_LENGTH}
              </span>
            </div>
          </div>
        ) : (
          <div>
            <p className="mb-1.5 text-xs font-medium text-foreground">部屋の画像</p>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickImage(f);
                e.target.value = "";
              }}
            />
            {image && imagePreview ? (
              <div className="relative overflow-hidden rounded-xl border border-border bg-background">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imagePreview} alt="部屋の画像" className="mx-auto max-h-64 w-auto object-contain" />
                <button
                  type="button"
                  onClick={() => setImage(null)}
                  className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white transition-colors hover:bg-black/80"
                  aria-label="画像を外す"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f) pickImage(f);
                }}
                className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-background px-4 py-8 text-center transition-colors hover:border-neon-violet/40"
              >
                <ImagePlus size={24} className="text-muted" />
                <span className="text-xs font-medium text-foreground">ドロップ / 選択</span>
                <span className="text-[11px] text-muted">この部屋の周りを広げて、360 度にします</span>
              </button>
            )}
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, WORLDGEN_PROMPT_MAX_LENGTH))}
              rows={2}
              placeholder="補足（任意）: 部屋の様子をひとこと"
              className="mt-2 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-neon-violet/50"
            />
          </div>
        )}
        {inputError && <p className="text-xs text-red-400">{inputError}</p>}

        <HelpNote id="worldgen.howto" title="使い方のコツ" summary="1 枚の 360 度の部屋から切り出すので、どの向きでも物の位置がそろいます。">
          <ul className="mt-1 list-disc space-y-1 pl-4">
            <li>出来上がった部屋をドラッグで見回し、「この向きで保存」で背景用の画像を書き出せます。</li>
            <li>絵柄は写真寄りです。漫画の背景にするときは、クリスタの LT 変換などで線画・トーンにしてください。</li>
            <li>説明は 150 文字まで。部屋の種類（リビング・教室・カフェなど）を最初に、続けて置きたい物を書くと出やすくなります。</li>
            <li>雰囲気（夕方・散らかった・高級な など）も短く足せます。長い文章よりも、名詞を並べる方が効きます。</li>
            <li>「画像から」は、入れた画像の部屋がそのまま残るとは限りません（周りを含めて描き直されます）。</li>
          </ul>
        </HelpNote>
      </div>

      {/* --- 実行と結果 --- */}
      <div className="space-y-4">
        <div className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted">
              <Home size={14} />
              背景づくり（360°）
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
                    job?.status === "processing" ? `部屋を作成中 ${formatElapsedSeconds(elapsedMs)}` : "生成準備中（GPU 起動中）"
                  }
                />
              ) : (
                "部屋を作る"
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
                ? "バックグラウンドで作成中です（1 分ほど）。画面を閉じても続きます。もう一度ボタンを押すと次を予約できます。"
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

        {phase === "done" && job?.panoUrl && jobId && (
          <div className="space-y-3 rounded-xl border border-border bg-background p-3">
            <PanoramaViewer key={job.panoUrl} src={job.panoUrl} filenameBase={`ull_room360_${jobId.slice(0, 8)}`} onError={onViewerError} />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleDownload("pano")}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
              >
                <Download size={12} />
                360 度パノラマを保存
              </button>
              {job.plyUrl && (
                <button
                  type="button"
                  onClick={() => void handleDownload("ply")}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
                >
                  <Download size={12} />
                  3D（.ply）を保存
                </button>
              )}
            </div>
            {job.vramUsedGb != null && (
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
            resolveUrl={async () => (await pollWorldgenJob(peekId)).panoUrl}
            onDownload={async (url) => saveBlob(await fetchBlob(url), panoFilename(peekId))}
            onClose={() => setPeekId(null)}
          />
        )}
      </div>
    </div>
  );
}
