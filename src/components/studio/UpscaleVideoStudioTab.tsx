"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Download,
  Film,
  Loader2,
  LogIn,
  Sparkles,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import {
  DEFAULT_UPSCALE_MODEL,
  DEFAULT_UPSCALE_VIDEO_PRESET,
  UPSCALE_MODELS,
  UPSCALE_VIDEO_MAX_BYTES,
  UPSCALE_VIDEO_MAX_FRAMES,
  UPSCALE_VIDEO_MAX_SECONDS,
  UPSCALE_VIDEO_PRESETS,
  type UpscaleVideoPresetId,
  getUpscaleModel,
  upscaleVideoCostBreakdown,
  validateVideoInputResolution,
} from "@/lib/upscaleStudio";
import {
  downloadUpscaleImage,
  pollUpscaleJob,
  startUpscaleVideoJob,
  UpscaleJobNotFoundError,
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

const JOB_KEY = "upscale-video-active-job";
const POLL_INTERVAL_MS = 2500;
const POLL_MAX_CONSECUTIVE_ERRORS = 8;
const FALLBACK_FPS = 30;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type VideoMeta = { duration: number; width: number; height: number; fps: number };

/** <video> には fps を直接読む標準 API が無い。captureStream() の track
 * settings から取れれば実測、取れなければ FALLBACK_FPS で保守的に見積もる
 * （最終的な確定額は Worker 側の ffprobe 実測ベース）。 */
async function readVideoMeta(file: File): Promise<VideoMeta | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const url = URL.createObjectURL(file);
    video.src = url;

    const cleanup = () => URL.revokeObjectURL(url);

    video.onloadedmetadata = () => {
      let fps = FALLBACK_FPS;
      try {
        const stream = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.();
        const track = stream?.getVideoTracks?.()[0];
        const settings = track?.getSettings?.();
        if (settings?.frameRate && settings.frameRate > 0) fps = settings.frameRate;
      } catch {
        // captureStream 非対応ブラウザは fallback のまま
      }
      const meta = {
        duration: video.duration || 0,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        fps,
      };
      cleanup();
      resolve(meta.duration > 0 && meta.width > 0 ? meta : null);
    };
    video.onerror = () => {
      cleanup();
      resolve(null);
    };
  });
}

/** 実効的な尺上限（秒）。フレーム数上限がより厳しい制約になることが多い
 * （例: fps=30 なら 90フレーム上限 → 実質3秒）。 */
function effectiveMaxSeconds(fps: number): number {
  const byFrames = fps > 0 ? UPSCALE_VIDEO_MAX_FRAMES / fps : UPSCALE_VIDEO_MAX_SECONDS;
  return Math.min(UPSCALE_VIDEO_MAX_SECONDS, byFrames);
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

function buildOutFilename() {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `ullstudio_upscale_video_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(
    now.getHours(),
  )}${p(now.getMinutes())}${p(now.getSeconds())}.mp4`;
}

function VideoDropzone({
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
    if (picked && picked.type.startsWith("video/")) onFileSelected(picked);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {file && previewUrl ? (
        <div className="relative overflow-hidden rounded-xl border border-border bg-background">
          <video src={previewUrl} controls className="mx-auto max-h-72 w-auto" />
          <button
            type="button"
            onClick={onClear}
            className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white transition-colors hover:bg-black/80"
            aria-label="動画を外す"
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
          <Film size={28} className="text-muted" />
          <span className="text-sm font-medium text-foreground">
            アップスケールしたい動画をドロップ / 選択
          </span>
          <span className="text-[11px] text-muted">
            最大{UPSCALE_VIDEO_MAX_SECONDS}秒・短い素材ほど高速に仕上がります
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

export function UpscaleVideoStudioTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs } = usePricingKnobs();

  const [video, setVideo] = useState<File | null>(null);
  const videoPreview = useObjectUrl(video);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);

  const [modelKey] = useState<string>(DEFAULT_UPSCALE_MODEL);
  const [presetId, setPresetId] = useState<UpscaleVideoPresetId>(DEFAULT_UPSCALE_VIDEO_PRESET);

  const resumedJobId = useMemo(
    () => loadFormState<{ jobId: string }>(JOB_KEY)?.jobId || null,
    [],
  );
  const [phase, setPhase] = useState<Phase>(resumedJobId ? "running" : "idle");
  const [jobId, setJobId] = useState<string | null>(resumedJobId);
  const [job, setJob] = useState<UpscaleJob | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);

  const elapsedMs = useElapsedTimer(phase === "running");

  const handleVideoSelected = useCallback(async (file: File) => {
    setVideoError(null);
    setVideoMeta(null);
    if (file.size > UPSCALE_VIDEO_MAX_BYTES) {
      setVideoError(`動画ファイルが大きすぎます。${Math.floor(UPSCALE_VIDEO_MAX_BYTES / 1024 / 1024)}MB 以下の動画を選んでください。`);
      return;
    }
    setVideo(file);
    setPhase("idle");
    setJob(null);

    const meta = await readVideoMeta(file);
    if (!meta) {
      setVideoError("動画の情報を読み取れませんでした。別の動画でお試しください。");
      setVideo(null);
      return;
    }
    const maxSec = effectiveMaxSeconds(meta.fps);
    if (meta.duration > maxSec + 0.3) {
      setVideoError(
        `この動画（約${meta.fps.toFixed(0)}fps）は${maxSec.toFixed(1)}秒以内にしてください（${meta.duration.toFixed(1)}秒でした）。`,
      );
      setVideo(null);
      return;
    }
    const resError = validateVideoInputResolution(meta.width, meta.height);
    if (resError) {
      setVideoError(resError);
      setVideo(null);
      return;
    }
    setVideoMeta(meta);
  }, []);

  const handleClearVideo = useCallback(() => {
    setVideo(null);
    setVideoMeta(null);
    setVideoError(null);
  }, []);

  // --- ポーリングループ（画像タブと同じ規約: 完了後も job key をクリアしない） --
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
            return;
          }
          if (next.status === "failed") {
            setPhase("error");
            setErrorMessage(next.errorMessage || "アップスケールに失敗しました。");
            return;
          }
          setPhase("running");
        } catch (err) {
          if (cancelled) return;
          if (err instanceof UpscaleJobNotFoundError) {
            setPhase("error");
            setErrorMessage(
              "このジョブの記録が見つかりませんでした（生成から14日以上経つと自動的に削除されます）。お手数ですが新しく生成してください。",
            );
            saveFormState(JOB_KEY, { jobId: "" });
            return;
          }
          errorStreak += 1;
          console.warn("[UpscaleVideoStudioTab] poll error:", err);
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

  const breakdown = useMemo(
    () =>
      upscaleVideoCostBreakdown({
        durationSec: videoMeta?.duration ?? 0,
        fps: videoMeta?.fps ?? 0,
        inW: videoMeta?.width ?? 0,
        inH: videoMeta?.height ?? 0,
        presetId,
        modelKey,
        knobs,
      }),
    [videoMeta, presetId, modelKey, knobs],
  );
  const cost = breakdown.credits;

  const insufficientCredits =
    Boolean(user) && !creditsLoading && cost > 0 && (credits ?? 0) < cost;
  const busy = phase === "submitting" || phase === "running";
  const canRun = Boolean(video) && cost > 0 && !busy && !videoError;

  const handleRun = useCallback(async () => {
    if (!user) return setLoginOpen(true);
    if (!video || !videoMeta) return;
    if (insufficientCredits) return setChargeOpen(true);

    setPhase("submitting");
    setErrorMessage(null);
    setJob(null);

    try {
      const res = await startUpscaleVideoJob({
        video,
        modelKey,
        presetId,
        durationSec: videoMeta.duration,
        fps: videoMeta.fps,
        width: videoMeta.width,
        height: videoMeta.height,
      });
      broadcastCreditsUpdate(user.id, res.remainingCredits);
      setJobId(res.jobId);
      setPhase("running");
    } catch (err) {
      const e = err as UpscaleApiError;
      console.error("[UpscaleVideoStudioTab] start failed:", e);
      const remaining = e.remainingCredits;
      if (typeof remaining === "number") broadcastCreditsUpdate(user.id, remaining);
      setPhase("error");
      setErrorMessage(e.message || "ジョブの作成に失敗しました。");
      if (e.message?.includes("クレジット")) setChargeOpen(true);
    }
  }, [user, video, videoMeta, modelKey, presetId, insufficientCredits]);

  const progressPct = phase === "running" ? (job?.status === "processing" ? 70 : 25) : 0;

  return (
    <div data-source-file="src/components/studio/UpscaleVideoStudioTab.tsx" className="flex flex-col gap-4">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ── 左: 入力 ─────────────────────────────────────────── */}
        <div className="flex flex-col gap-5 rounded-2xl border-gradient bg-surface/40 p-5">
          <VideoDropzone
            file={video}
            previewUrl={videoPreview}
            onFileSelected={handleVideoSelected}
            onClear={handleClearVideo}
          />
          {videoError && <p className="-mt-2 text-[11px] text-red-400">{videoError}</p>}
          {videoMeta && (
            <p className="-mt-3 text-[11px] text-muted">
              入力 {videoMeta.width}×{videoMeta.height}px ・ {videoMeta.duration.toFixed(1)}秒 ・
              約{videoMeta.fps.toFixed(0)}fps（推定{breakdown.frameCount}フレーム）
              {breakdown.outputWidth > 0 && (
                <>
                  {" → "}出力 {breakdown.outputWidth}×{breakdown.outputHeight}px
                </>
              )}
            </p>
          )}

          <div>
            <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">出力解像度</p>
            <div className="grid grid-cols-3 gap-2">
              {UPSCALE_VIDEO_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPresetId(p.id)}
                  className={`rounded-xl border px-3 py-2.5 text-center transition-colors ${
                    presetId === p.id
                      ? "border-neon-pink/40 bg-neon-pink/5 text-neon-pink"
                      : "border-border bg-background text-muted hover:border-neon-violet/40"
                  }`}
                >
                  <span className="block text-sm font-semibold">{p.label}</span>
                  <span className="block text-[10px]">{p.subLabel}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-background px-4 py-3">
            <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-widest text-muted">
              <Wand2 size={12} />
              エンジン
            </p>
            <p className="mt-1 text-sm font-medium text-foreground">{model.label}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{model.descJa}</p>
          </div>

          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
            <Sparkles size={12} className="mt-0.5 shrink-0 text-neon-violet" />
            動画超解像は最小構成の提供です（最大{UPSCALE_VIDEO_MAX_SECONDS}秒・音声はそのまま維持されます）。
            解像度が高いほど、またフレーム数が多い動画ほど処理時間・消費クレジットが増えます。すでに4K相当以上の動画は対応していません。
          </p>
        </div>

        {/* ── 右: アクション / 結果 ───────────────────────────── */}
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-border bg-background p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-muted">
                <Film size={14} />
                動画超解像
              </span>
              <span className="font-mono font-medium text-foreground">
                {cost > 0 ? (
                  <span className="text-neon-pink">{cost} Credits</span>
                ) : (
                  <span className="text-muted">動画を選択</span>
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
                  動画をアップスケール
                </>
              )}
            </button>
          </div>

          {busy && (
            <p className="flex items-start gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/10 px-3 py-2 text-xs leading-relaxed text-neon-violet">
              <Sparkles size={14} className="mt-0.5 shrink-0" />
              バックグラウンドで処理中です。タブを閉じたり再読み込みしても継続し、次に開いたときに結果が表示されます。
              動画は画像より処理に時間がかかります。
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
              <video
                src={job.resultUrl}
                controls
                className="w-full rounded-xl border border-border bg-background"
              />
              <div className="flex items-center justify-between text-[11px] text-muted">
                <span>
                  {job.outWidth && job.outHeight ? `${job.outWidth}×${job.outHeight}px` : ""}
                  {job.elapsedTime ? ` ・ ${job.elapsedTime}s` : ""}
                </span>
                {job.vramPeakGb != null && <VramBadge gb={job.vramPeakGb} />}
              </div>
              <button
                type="button"
                onClick={() => job.resultUrl && downloadUpscaleImage(job.resultUrl, buildOutFilename())}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:border-neon-violet/40"
              >
                <Download size={16} />
                ダウンロード
              </button>
            </div>
          )}

          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
            <Film size={14} className="mt-0.5 shrink-0 text-neon-violet" />
            {user
              ? "料金はフレーム数（尺 × fps）で決まります。短い素材ほど割安です。"
              : "超解像スタジオの利用にはログインが必要です。初回登録で10クレジットが付与されます。"}
          </p>
        </div>
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
        cost={cost || 20}
      />
    </div>
  );
}
