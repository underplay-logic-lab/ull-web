"use client";

// 🖌️ 画風を変える（構図そのまま・2026-10-10・許可制 restyle_trial）: 元画像の構図（線）だけを借りて、指定の画風で別の絵に描き直す。
// お客さん（AI 漫画家）の「写真や素材を、構図はそのまま漫画・アニメの絵柄に」の要望。結果はマルチアングル（別の向きを作る）・
// Photo Director（キャラを入れる）へそのまま渡せる（一気通貫）。
// Studio タブの標準（CLAUDE.md §6）: リロードで消えない・見つからない専用エラー・VRAM バッジ・起動待ち表示・実行中は順番待ち／並列・
// 対応外ファイルのエラー・URL を使い回さない・切り抜かない・完了したら自動保存。使うモデルの名前は出さない（§2）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Download, ImagePlus, LogIn, Paintbrush, Sparkles, Users, View, X, Zap } from "lucide-react";
import { HelpNote } from "./HelpNote";
import { TopupActions } from "./TopupActions";
import {
  RESTYLE_COUNTS,
  RESTYLE_FREE_STYLE_MAX,
  RESTYLE_KEEPS,
  RESTYLE_STYLES,
  restyleCredits,
  restylePriorityParallelSurcharge,
  type RestyleCount,
  type RestyleKeepId,
  type RestyleStyleId,
} from "@/lib/restylePricing";
import { RestyleJobNotFoundError, pollRestyleJob, startRestyleJob, type RestyleApiError, type RestyleJobStatus } from "@/lib/restyleApi";
import { fetchFaceSwapImage as fetchImage, saveBlob } from "@/lib/faceSwapApi";
import { requestStudioHandoff, studioHandoffToFile, takeStudioHandoff } from "@/lib/studioHandoff";
import { uploadStudioAsset } from "@/lib/studioUploads";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { VramBadge } from "@/components/studio/VramBadge";
import { WarmPriceHint } from "@/components/studio/WarmPriceHint";
import { WarmRefundNote } from "@/components/studio/WarmRefundNote";
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

const JOB_KEY = "restyle-active-job";
const FORM_KEY = "restyle-form";
const RESERVED_KEY = "restyle-reserved-jobs";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_CONSECUTIVE_ERRORS = 8;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

type Snapshot = { file: File; style: RestyleStyleId; freeStyle: string; keep: RestyleKeepId; count: RestyleCount };
type FormState = { style: RestyleStyleId; freeStyle: string; keep: RestyleKeepId; count: RestyleCount };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultFilename(jobId: string, i: number): string {
  return `ull_restyle_${jobId.slice(0, 8)}_${i + 1}.png`;
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

function ChoiceButtons<T extends string | number>({
  items,
  value,
  onChange,
  cols,
}: {
  items: { id: T; label: string; sub?: string }[];
  value: T;
  onChange: (v: T) => void;
  cols: string;
}) {
  return (
    <div className={`grid gap-2 ${cols}`}>
      {items.map((it) => (
        <button
          key={String(it.id)}
          type="button"
          onClick={() => onChange(it.id)}
          className={`rounded-xl border px-2 py-2 text-xs transition-colors ${
            value === it.id
              ? "border-neon-pink/40 bg-neon-pink/10 text-neon-pink"
              : "border-border bg-background text-muted hover:border-neon-violet/40 hover:text-foreground"
          }`}
        >
          <span className="block font-medium">{it.label}</span>
          {it.sub && <span className="block text-[10px] opacity-70">{it.sub}</span>}
        </button>
      ))}
    </div>
  );
}

export function RestyleTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs } = usePricingKnobs();
  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [queueChoiceOpen, setQueueChoiceOpen] = useState(false);

  // --- 入力（File はリロードで戻せないので保存しない。選んだ設定は次回も使う） ---
  const [file, setFile] = useState<File | null>(null);
  const saved = useMemo(() => loadFormState<FormState>(FORM_KEY), []);
  const [style, setStyle] = useState<RestyleStyleId>(saved?.style ?? "anime");
  const [freeStyle, setFreeStyle] = useState(saved?.freeStyle ?? "");
  const [keep, setKeep] = useState<RestyleKeepId>(saved?.keep ?? "medium");
  const [count, setCount] = useState<RestyleCount>(saved?.count ?? 1);
  useEffect(() => {
    saveFormState(FORM_KEY, { style, freeStyle, keep, count });
  }, [style, freeStyle, keep, count]);
  const [inputError, setInputError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cost = restyleCredits(count, knobs);
  const insufficientCredits = Boolean(user) && !creditsLoading && (credits ?? 0) < cost;
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const pick = (f: File) => {
    const err = imageFileError(f);
    if (err) return setInputError(err);
    setInputError(null);
    setFile(f);
  };

  // 他のタブから渡された画像（マルチアングル・Photo Director などの結果）を取り込む。
  useEffect(() => {
    const h = takeStudioHandoff("image");
    if (!h) return;
    studioHandoffToFile(h)
      .then((f) => {
        setFile(f);
        setNotice(h.source ? `${h.source}を取り込みました。` : "画像を取り込みました。");
      })
      .catch((e: unknown) => setInputError(e instanceof Error ? e.message : "取り込みに失敗しました。"));
  }, []);

  // 同じ File を何度も上げない（描き直し直し・予約のたびに上げ直さない）。
  const uploadedRef = useRef<WeakMap<File, string>>(new WeakMap());
  const uploadOnce = useCallback(
    async (f: File): Promise<string> => {
      if (!user) throw new Error("ログインが必要です。");
      const hit = uploadedRef.current.get(f);
      if (hit) return hit;
      const { path } = await uploadStudioAsset(user.id, f);
      uploadedRef.current.set(f, path);
      return path;
    },
    [user],
  );

  // --- ジョブ ---
  const [phase, setPhase] = useState<Phase>("idle");
  const [jobId, setJobId] = useState<string | null>(() => loadFormState<{ jobId: string }>(JOB_KEY)?.jobId || null);
  const [job, setJob] = useState<RestyleJobStatus | null>(null);
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
    if (!file) {
      setInputError("元の画像を入れてください。");
      return null;
    }
    if (style === "free" && !freeStyle.trim()) {
      setInputError("どんな画風にしたいかを書いてください。");
      return null;
    }
    return { file, style, freeStyle: freeStyle.trim(), keep, count };
  };

  const start = useCallback(
    async (s: Snapshot, opts: { priority?: boolean; queue?: boolean } = {}) => {
      setUploading(true);
      try {
        const imagePath = await uploadOnce(s.file);
        return await startRestyleJob({ imagePath, style: s.style, freeStyle: s.freeStyle, keep: s.keep, count: s.count, ...opts });
      } finally {
        setUploading(false);
      }
    },
    [uploadOnce],
  );

  const handleStartError = (err: unknown) => {
    const e = err as RestyleApiError;
    if (user && typeof e.remainingCredits === "number") broadcastCreditsUpdate(user.id, e.remainingCredits);
    setPhase("error");
    setErrorMessage(e.message || "描き直しの開始に失敗しました。");
    if (e.message?.includes("クレジット")) setChargeOpen(true);
  };

  const runGenerate = async (s: Snapshot, opts: { priority?: boolean } = {}) => {
    if (!user) return;
    // 終わった後に続けて作るときも、直前の結果を「前の結果」に残す。
    if (job?.status === "completed") setPeekId(job.jobId);
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
  }, [setPeekId]);

  // 予約は Photo Director・Director と同じ順番待ち（同じ GPU の仕組み）。自分が予約した分だけを追う。
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
      trackedRef.current = [...trackedRef.current.filter((x) => x !== res.jobId), res.jobId];
      saveFormState(RESERVED_KEY, { ids: trackedRef.current });
      if (res.reserved) setReservedIds((prev) => (prev.includes(res.jobId) ? prev : [...prev, res.jobId]));
      else followJob(res.jobId);
    } catch (err) {
      const e = err as RestyleApiError;
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
    if (!creditsLoading && (credits ?? 0) < cost + restylePriorityParallelSurcharge(knobs, cost)) return setChargeOpen(true);
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
          const next = await pollRestyleJob(jobId);
          if (cancelled) return;
          errorStreak = 0;
          setJob(next);
          if (next.status === "completed") {
            setPhase("done");
            if (sawInProgress) markGpuWarm();
            if (next.imageUrls.length && takeAutoDownload(jobId)) {
              runAutoDownload("RestyleTab", async () => {
                // 署名は 15 分で切れるので保存する時点で取り直す（CLAUDE.md §6-11）。
                const fresh = await pollRestyleJob(jobId);
                for (let i = 0; i < fresh.imageUrls.length; i++) saveBlob(await fetchImage(fresh.imageUrls[i]), resultFilename(jobId, i));
              });
            }
            void advanceAndFollow(true);
            return;
          }
          if (next.status === "failed" || next.status === "cancelled" || next.status === "failed_timeout") {
            setPhase("error");
            setErrorMessage("描き直しできませんでした。クレジットは戻しています。");
            void advanceAndFollow(false);
            return;
          }
          sawInProgress = sawInProgress || next.status === "processing";
          setPhase("running");
        } catch (err) {
          if (cancelled) return;
          if (err instanceof RestyleJobNotFoundError) {
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

  /** 署名 URL を取り直して i 枚目の URL を返す（保存・他タブへの受け渡し。URL は使い回さない、CLAUDE.md §6-11）。 */
  const freshUrl = async (i: number): Promise<string | null> => {
    if (!jobId) return null;
    try {
      const next = await pollRestyleJob(jobId);
      setJob(next);
      return next.imageUrls[i] ?? null;
    } catch {
      return null;
    }
  };

  const handleDownload = async (i: number) => {
    if (!jobId) return;
    setActionError(null);
    const url = await freshUrl(i);
    if (!url) return setActionError("画像の取得に失敗しました。時間をおいてもう一度お試しください。");
    try {
      saveBlob(await fetchImage(url), resultFilename(jobId, i));
    } catch {
      setActionError("画像の取得に失敗しました。時間をおいてもう一度お試しください。");
    }
  };

  const sendTo = async (i: number, tab: "angle" | "photo", source: string) => {
    if (!jobId) return;
    setActionError(null);
    const url = await freshUrl(i);
    if (!url) return setActionError("画像の取得に失敗しました。時間をおいてもう一度お試しください。");
    requestStudioHandoff({ kind: "image", url, filename: resultFilename(jobId, i), source }, tab);
  };

  const reloadsRef = useRef(0);
  const canRun = Boolean(file) && phase !== "submitting";
  const chargeFirst = Boolean(user) && insufficientCredits && !busy;
  const resultUrls = job?.imageUrls ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      <InsufficientCreditsModal open={chargeOpen} onClose={() => setChargeOpen(false)} credits={credits} cost={cost} />
      <QueueChoiceModal
        open={queueChoiceOpen}
        surcharge={restylePriorityParallelSurcharge(knobs, cost)}
        total={cost + restylePriorityParallelSurcharge(knobs, cost)}
        queueCost={cost}
        onCancel={() => setQueueChoiceOpen(false)}
        onQueue={() => void handleQueueWait()}
        onParallel={handleQueueParallel}
      />

      {/* --- 入力 --- */}
      <div className="space-y-5 rounded-2xl border border-border bg-surface p-5">
        <div>
          <p className="mb-1.5 text-xs font-medium text-foreground">元の画像</p>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pick(f);
              e.target.value = "";
            }}
          />
          {file && previewUrl ? (
            <div className="relative overflow-hidden rounded-xl border border-border bg-background">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="元の画像" className="mx-auto max-h-72 w-auto object-contain" />
              <button
                type="button"
                onClick={() => setFile(null)}
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
                if (f) pick(f);
              }}
              className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center transition-colors ${
                dragging ? "border-neon-pink/60 bg-neon-pink/5" : "border-border bg-background hover:border-neon-violet/40"
              }`}
            >
              <ImagePlus size={24} className="text-muted" />
              <span className="text-xs font-medium text-foreground">ドロップ / 選択</span>
              <span className="text-[11px] text-muted">写真・イラスト・3D の画面など。配置（形）だけを借りて描き直します</span>
            </button>
          )}
          {notice && <p className="mt-1.5 text-[11px] text-emerald-500">{notice}</p>}
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium text-foreground">画風</p>
          <ChoiceButtons items={RESTYLE_STYLES} value={style} onChange={setStyle} cols="grid-cols-3" />
          {style === "free" && (
            <textarea
              value={freeStyle}
              onChange={(e) => setFreeStyle(e.target.value.slice(0, RESTYLE_FREE_STYLE_MAX))}
              rows={3}
              placeholder="例: 水彩絵の具でやわらかく塗った絵本の挿絵 ／ 90 年代のセル画アニメ ／ 油絵の風景画"
              className="mt-2 w-full rounded-xl border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted/60 focus:border-neon-violet/50 focus:outline-none"
            />
          )}
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium text-foreground">元の形の残し方</p>
          <ChoiceButtons items={RESTYLE_KEEPS} value={keep} onChange={setKeep} cols="grid-cols-3" />
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium text-foreground">枚数</p>
          <ChoiceButtons
            items={RESTYLE_COUNTS.map((n) => ({ id: n, label: `${n} 枚` }))}
            value={count}
            onChange={(n) => setCount(n as RestyleCount)}
            cols="grid-cols-3"
          />
        </div>
        {inputError && <p className="text-xs text-red-400">{inputError}</p>}

        <HelpNote id="restyle.howto" title="使い方のコツ" summary="元の画像の配置はそのまま、絵柄だけを描き直します。細かい柄や小物は作り変わります。">
          <ul className="mt-1 list-disc space-y-1 pl-4">
            <li>部屋の写真をアニメ・漫画の背景にするときは「ほどほど」がおすすめです。形を崩したくないときは「しっかり」、雰囲気だけ借りるなら「ゆるく」。</li>
            <li>できた絵は「マルチアングルへ」で別の向きを作れます。「Photo Director へ」で、その場所の写真としてキャラクターと一緒に使えます。</li>
            <li>枚数を増やすと、同じ設定で違う描き方の候補が出ます（基本料は 1 回分だけです）。</li>
          </ul>
        </HelpNote>
      </div>

      {/* --- 実行と結果 --- */}
      <div className="space-y-4">
        <div className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted">
              <Paintbrush size={14} />
              画風を変える（{count} 枚）
            </span>
            <span className="font-mono font-medium text-neon-pink">{cost} Credits</span>
          </div>
          <WarmPriceHint />
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
                      ? `描き直し中 ${job.progressMessage ?? ""} ${formatElapsedSeconds(elapsedMs)}`
                      : "生成準備中（GPU 起動中）"
                  }
                />
              ) : (
                "描き直す"
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
                ? "バックグラウンドで描き直し中です。画面を閉じても続きます。もう一度ボタンを押すと次を予約できます。"
                : "生成準備中…GPU を起動しています（初回は 2〜3 分）。画面を閉じても続きます。"}
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

        {phase === "done" && resultUrls.length > 0 && (
          <div className="space-y-3 rounded-xl border border-border bg-background p-3">
            <div className={resultUrls.length > 1 ? "grid gap-3 sm:grid-cols-2" : undefined}>
              {resultUrls.map((url, i) => (
                <div key={url} className="space-y-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={`描き直した結果 ${i + 1}`}
                    className="mx-auto max-h-[28rem] w-auto rounded-lg bg-surface object-contain"
                    onError={() => {
                      if (reloadsRef.current >= 2) return;
                      reloadsRef.current += 1;
                      setTimeout(() => void freshUrl(i), 1500);
                    }}
                  />
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      onClick={() => void handleDownload(i)}
                      className="flex items-center justify-center gap-1 rounded-lg border border-border bg-surface px-1.5 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
                    >
                      <Download size={12} />
                      保存
                    </button>
                    <button
                      type="button"
                      onClick={() => void sendTo(i, "angle", "画風を変えた結果")}
                      className="flex items-center justify-center gap-1 rounded-lg border border-border bg-surface px-1.5 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
                    >
                      <View size={12} />
                      マルチアングルへ
                    </button>
                    <button
                      type="button"
                      onClick={() => void sendTo(i, "photo", "画風を変えた結果")}
                      className="flex items-center justify-center gap-1 rounded-lg border border-border bg-surface px-1.5 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
                    >
                      <Users size={12} />
                      Photo Director へ
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {job?.vramUsedGb != null && (
              <div className="flex justify-center">
                <VramBadge gb={job.vramUsedGb} />
              </div>
            )}
            <WarmRefundNote credits={job?.warmRefundCredits} />
          </div>
        )}
        {actionError && <p className="text-xs text-red-400">{actionError}</p>}
        {peekId && peekId !== jobId && (
          <PrevResultPanel
            key={peekId}
            kind="image"
            resolveUrls={async () => (await pollRestyleJob(peekId)).imageUrls}
            onDownload={async (url, index) => saveBlob(await fetchImage(url), resultFilename(peekId, index ?? 0))}
            onClose={() => setPeekId(null)}
          />
        )}
      </div>
    </div>
  );
}
