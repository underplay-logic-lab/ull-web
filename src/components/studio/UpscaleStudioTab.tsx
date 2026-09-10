"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  UPSCALE_MODELS,
  UPSCALE_MODES,
  estimateOutputSize,
  getUpscaleMode,
  getUpscaleModel,
  upscaleCostBreakdown,
  type UpscaleModeId,
} from "@/lib/upscaleStudio";
import {
  downloadUpscaleImage,
  pollUpscaleJob,
  startUpscaleJob,
  type UpscaleApiError,
  type UpscaleJob,
} from "@/lib/upscaleApi";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { VramBadge } from "@/components/studio/VramBadge";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useElapsedTimer, formatElapsedSeconds } from "@/hooks/useElapsedTimer";

type Phase = "idle" | "submitting" | "running" | "done" | "error";

const FORM_ID = "upscale-studio";
const JOB_KEY = "upscale-active-job";
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

  const handleFiles = (files: FileList | null) => {
    const picked = files?.[0];
    if (picked && picked.type.startsWith("image/")) onFileSelected(picked);
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

  const resumedJobId = useMemo(
    () => loadFormState<{ jobId: string }>(JOB_KEY)?.jobId || null,
    [],
  );
  const [phase, setPhase] = useState<Phase>(resumedJobId ? "running" : "idle");
  const [jobId, setJobId] = useState<string | null>(resumedJobId);
  const [job, setJob] = useState<UpscaleJob | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultBeforeUrl, setResultBeforeUrl] = useState<string | null>(null);

  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);

  const elapsedMs = useElapsedTimer(phase === "running");

  useEffect(() => {
    saveFormState(FORM_ID, { modeId, modelKey } satisfies PersistedForm);
  }, [modeId, modelKey]);

  const handleImageSelected = useCallback((file: File) => {
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

  // --- ポーリングループ ----------------------------------------------
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let errorStreak = 0;
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
            saveFormState(JOB_KEY, { jobId: "" });
            return;
          }
          if (next.status === "failed") {
            setPhase("error");
            setErrorMessage(next.errorMessage || "アップスケールに失敗しました。");
            saveFormState(JOB_KEY, { jobId: "" });
            return;
          }
          setPhase("running");
        } catch (err) {
          if (cancelled) return;
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
  }, [jobId]);

  const model = getUpscaleModel(modelKey);
  const mode = getUpscaleMode(modeId);

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
      ? estimateOutputSize(inputSize.width, inputSize.height, mode)
      : null;

  const insufficientCredits =
    Boolean(user) && !creditsLoading && cost > 0 && (credits ?? 0) < cost;
  const busy = phase === "submitting" || phase === "running";
  const canRun = Boolean(image) && cost > 0 && !busy;

  const handleRun = useCallback(async () => {
    if (!user) return setLoginOpen(true);
    if (!image) return;
    if (insufficientCredits) return setChargeOpen(true);

    setPhase("submitting");
    setErrorMessage(null);
    setJob(null);
    setResultBeforeUrl(image ? URL.createObjectURL(image) : null);

    try {
      const res = await startUpscaleJob({ image, modelKey, modeId });
      broadcastCreditsUpdate(user.id, res.remainingCredits);
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
  }, [user, image, modelKey, modeId, insufficientCredits]);

  const progressPct = phase === "running" ? (job?.status === "processing" ? 70 : 25) : 0;

  return (
    <div
      data-source-file="src/components/studio/UpscaleStudioTab.tsx"
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
    >
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
            この入力サイズだと {mode.label} フル倍率は上限（約 45MP）を超えるため、
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
          <div className="grid grid-cols-3 gap-2">
            {UPSCALE_MODES.filter((m) => m.kind === "multiplier").map((m) => (
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

          {/* パワーティア: 8K */}
          {UPSCALE_MODES.filter((m) => m.powerTier).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setModeId(m.id)}
              className={`mt-2 flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors ${
                modeId === m.id
                  ? "border-neon-violet/50 bg-neon-violet/10"
                  : "border-border bg-background hover:border-neon-violet/40"
              }`}
            >
              <span>
                <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <Sparkles size={13} className="text-neon-violet" />
                  {m.label} パワーモード
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
                  {m.subLabel}。DiT・VAE とも全画面 1 パス処理（タイル分割なし）。
                </span>
              </span>
              {breakdown.powerMult > 1 && modeId === m.id && (
                <span className="shrink-0 rounded bg-neon-violet/20 px-1.5 py-0.5 text-[10px] font-medium text-neon-violet">
                  ×{breakdown.powerMult}
                </span>
              )}
            </button>
          ))}

          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
            <Sparkles size={12} className="mt-0.5 shrink-0 text-neon-violet" />
            アスペクト比は維持されます。出力の上限は約 45MP（8K 級）。
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
                  className="h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-violet transition-[width] duration-500"
                  style={{ width: `${Math.max(4, progressPct)}%` }}
                />
              </div>
              <p className="mt-1.5 text-center text-[11px] text-muted">
                アップスケール中（{formatElapsedSeconds(elapsedMs)}s）
              </p>
              {job?.vramUsedGb != null && (
                <div className="mt-2 flex justify-center">
                  <VramBadge gb={job.vramUsedGb} />
                </div>
              )}
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
            {busy ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                処理中…
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
            {resultBeforeUrl ? (
              <CompareSlider before={resultBeforeUrl} after={job.resultUrl} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={job.resultUrl}
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
              onClick={() =>
                job.resultUrl && downloadUpscaleImage(job.resultUrl, buildOutFilename(job.resultUrl))
              }
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:border-neon-violet/40"
            >
              <Download size={16} />
              ダウンロード
            </button>
          </div>
        )}

        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <ImagePlus size={14} className="mt-0.5 shrink-0 text-neon-violet" />
          {user
            ? "料金は出力の画素数で決まります。処理は数十秒。連続でかけるとウォームアップぶん速くなります。"
            : "超解像スタジオの利用にはログインが必要です。初回登録で10クレジットが付与されます。"}
        </p>
      </div>

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        message="超解像スタジオを利用するにはログインしてください。"
      />
      <InsufficientCreditsModal
        open={chargeOpen}
        onClose={() => setChargeOpen(false)}
        credits={credits}
        cost={cost || 8}
      />
    </div>
  );
}
