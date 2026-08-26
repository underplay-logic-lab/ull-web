"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  Clapperboard,
  Download,
  Film,
  ImagePlus,
  Loader2,
  LogIn,
  Play,
  Sparkles,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import {
  CINEMATIC_MODES,
  cinematicTargetDimensions,
  type CinematicAspectRatio,
  type CinematicModeId,
} from "@/lib/cinematicPricing";
import { generateCinematicVideo, pollCinematicJob } from "@/lib/cinematicApi";
import { resizeImageBlobTo } from "@/lib/imageCanvas";
import { ImageCropper } from "@/components/studio/ImageCropper";
import { GpuWarmStokeWidget } from "@/components/studio/GpuWarmStokeWidget";
import { LoginModal } from "@/components/LoginModal";
import { ToastStack, type ToastData } from "@/components/Toast";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useElapsedTimer, formatElapsedSeconds } from "@/hooks/useElapsedTimer";

type Status = "idle" | "loading" | "done" | "error";
// Sub-phase of "loading" — the job itself reports this via GET
// /api/jobs/[id] (see pollCinematicJob), distinguishing "still in Modal's
// queue" from "a GPU container is actually rendering it" for the UI.
type JobPhase = "queued" | "processing" | null;

// How often to poll GET /api/jobs/[id] while a job is queued/processing.
const JOB_POLL_INTERVAL_MS = 2000;

const SAMPLE_VIDEOS = [
  "/samples/cinematic/sample_01.mp4",
  "/samples/cinematic/sample_02.mp4",
  "/samples/cinematic/sample_03.mp4",
];

function buildDownloadFilename() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `ullstudio_cinematic_${datePart}_${timePart}.mp4`;
}

function SampleGallery() {
  return (
    <div
      data-source-file="src/components/studio/CinematicVideoTab.tsx"
      className="mb-8 overflow-hidden rounded-2xl border-gradient bg-surface/40"
    >
      <div className="flex flex-col items-center gap-2 px-6 pt-6 text-center">
        <span className="flex items-center gap-1.5 rounded-full border border-neon-pink/40 bg-neon-pink/10 px-3 py-1 font-mono text-[11px] font-medium text-neon-pink">
          <Sparkles size={12} />
          DEMO GALLERY
        </span>
        <p className="max-w-lg text-sm font-semibold text-foreground sm:text-base">
          高解像度15秒シネマティック映像を、独自の最適化パイプラインで即時レンダリング
        </p>
        <p className="text-xs text-muted">1枚の画像をアップロードするだけ。音声付きの動画をAIが自動生成します。</p>
      </div>

      <div className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-3">
        {SAMPLE_VIDEOS.map((src, i) => (
          <div key={src} className="group relative aspect-[9/16] overflow-hidden rounded-xl border border-border bg-background">
            <video
              src={src}
              className="h-full w-full object-cover"
              muted
              loop
              playsInline
              preload="metadata"
              onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
              onMouseLeave={(e) => {
                e.currentTarget.pause();
                e.currentTarget.currentTime = 0;
              }}
            />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100">
              <Play size={28} className="text-white drop-shadow" />
            </div>
            <a
              href={src}
              download={`sample_${i + 1}.mp4`}
              onClick={(e) => e.stopPropagation()}
              className="absolute right-2 top-2 z-10 rounded-full bg-black/60 p-1.5 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
              aria-label="サンプルをダウンロード"
            >
              <Download size={14} />
            </a>
          </div>
        ))}
      </div>
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
      data-source-file="src/components/studio/CinematicVideoTab.tsx"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="w-full max-w-sm rounded-2xl border-gradient bg-surface p-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">クレジットが不足しています</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-muted transition-colors hover:text-foreground"
          >
            <X size={20} />
          </button>
        </div>

        <p className="mt-2 text-sm leading-relaxed text-muted">
          この画質モードでの生成には {cost} クレジット必要です。現在の保有クレジット: {credits ?? 0}
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

export function CinematicVideoTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);

  const [sourceImageUrl, setSourceImageUrl] = useState<string | null>(null);
  const [croppedBlob, setCroppedBlob] = useState<Blob | null>(null);
  const [croppedPreviewUrl, setCroppedPreviewUrl] = useState<string | null>(null);
  const [aspect, setAspect] = useState<CinematicAspectRatio>("16:9");
  const [cropperOpen, setCropperOpen] = useState(false);

  const [modeId, setModeId] = useState<CinematicModeId>("standard");
  const mode = useMemo(() => CINEMATIC_MODES.find((m) => m.id === modeId)!, [modeId]);
  const targetDims = useMemo(() => cinematicTargetDimensions(mode, aspect), [mode, aspect]);

  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [jobPhase, setJobPhase] = useState<JobPhase>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [downloadFilename, setDownloadFilename] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const dismissToast = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeModalOpen, setChargeModalOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const elapsedMs = useElapsedTimer(status === "loading");

  // Tracks the in-flight job poll loop so it can be torn down cleanly on
  // unmount — same ref-tracked recursive-setTimeout pattern as
  // src/app/admin/comfyui-loading/page.tsx, for the same reason: a
  // `cancelled` flag alone stops it from *acting* after unmount, but
  // doesn't stop one more harmless tick from firing, so this clears the
  // timer outright too.
  const pollCancelledRef = useRef(false);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      pollCancelledRef.current = true;
      if (pollTimeoutRef.current !== null) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (sourceImageUrl) URL.revokeObjectURL(sourceImageUrl);
    };
  }, [sourceImageUrl]);
  useEffect(() => {
    return () => {
      if (croppedPreviewUrl) URL.revokeObjectURL(croppedPreviewUrl);
    };
  }, [croppedPreviewUrl]);

  const insufficientCredits = Boolean(user) && !creditsLoading && (credits ?? 0) < mode.credits;
  const missingInputs = !croppedBlob;

  const handleFileSelected = (file: File) => {
    if (sourceImageUrl) URL.revokeObjectURL(sourceImageUrl);
    setSourceImageUrl(URL.createObjectURL(file));
    setCropperOpen(true);
  };

  const handleCropConfirm = ({ blob, aspect: chosenAspect }: { blob: Blob; aspect: CinematicAspectRatio }) => {
    setCroppedPreviewUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(blob);
    });
    setCroppedBlob(blob);
    setAspect(chosenAspect);
    setCropperOpen(false);
  };

  const handleGenerate = async () => {
    if (status === "loading" || missingInputs || !croppedBlob) return;

    if (!user) {
      setLoginOpen(true);
      return;
    }

    if (insufficientCredits) {
      setChargeModalOpen(true);
      return;
    }

    setStatus("loading");
    setJobPhase("queued");
    setResultUrl(null);
    setDownloadFilename(null);
    setErrorMessage(null);
    pollCancelledRef.current = false;

    try {
      // Absolute condition: the uploaded payload is always forced to this
      // mode's exact 16-multiple dimensions, regardless of what the crop
      // step originally produced (see cinematicTargetDimensions).
      const { width, height } = targetDims;
      const finalImage = await resizeImageBlobTo(croppedBlob, width, height);

      // Only starts the job now — see generateCinematicVideo's own comment.
      // The actual render is watched via the poll loop below, not this call.
      const { jobId, remainingCredits } = await generateCinematicVideo({
        image: finalImage,
        mode: modeId,
        prompt,
      });
      broadcastCreditsUpdate(user.id, remainingCredits);

      const poll = async () => {
        if (pollCancelledRef.current) return;
        try {
          const job = await pollCinematicJob(jobId);
          if (pollCancelledRef.current) return;

          if (job.status === "completed") {
            setResultUrl(job.videoUrl);
            setDownloadFilename(buildDownloadFilename());
            setStatus("done");
            setJobPhase(null);
            setToasts((prev) => [...prev, { id: Date.now(), message: "🎬 動画生成が完了しました" }]);
            return;
          }
          if (job.status === "failed") {
            setErrorMessage(
              job.errorMessage
                ? `${job.errorMessage}（消費したクレジットは返金されました）`
                : "動画生成に失敗しました（消費したクレジットは返金されました）。",
            );
            setStatus("error");
            setJobPhase(null);
            setToasts((prev) => [
              ...prev,
              { id: Date.now(), message: "⚠️ 動画生成に失敗しました（クレジットは返金されました）" },
            ]);
            return;
          }
          setJobPhase(job.status);
        } catch (err) {
          // A transient poll failure shouldn't flip the whole job to
          // "error" — the render itself may still be in progress on
          // Modal's side regardless of whether this one status check
          // succeeded, so just try again next tick.
          console.error("[CinematicVideoTab] job poll failed:", err);
        }
        if (!pollCancelledRef.current) {
          pollTimeoutRef.current = setTimeout(poll, JOB_POLL_INTERVAL_MS);
        }
      };

      pollTimeoutRef.current = setTimeout(poll, JOB_POLL_INTERVAL_MS);
    } catch (err) {
      console.error("[CinematicVideoTab] generation failed to start:", err);
      setErrorMessage(err instanceof Error ? err.message : "動画生成に失敗しました。");
      setStatus("error");
      setJobPhase(null);

      const remainingCredits = (err as { remainingCredits?: number })?.remainingCredits;
      if (typeof remainingCredits === "number") {
        broadcastCreditsUpdate(user.id, remainingCredits);
      }
    }
  };

  let buttonLabel: ReactNode;
  if (status === "loading") {
    buttonLabel = (
      <>
        <Loader2 size={16} className="animate-spin" />
        {jobPhase === "queued" ? "⏳ 待機列に並んでいます" : "⚡ レンダリング中"}... {formatElapsedSeconds(elapsedMs)}s
      </>
    );
  } else if (!user) {
    buttonLabel = (
      <>
        <LogIn size={16} />
        ログインして生成
      </>
    );
  } else if (insufficientCredits) {
    buttonLabel = (
      <>
        <Zap size={16} />
        クレジットが不足しています
      </>
    );
  } else {
    buttonLabel = (
      <>
        <Wand2 size={16} />
        {mode.credits} クレジットで生成
      </>
    );
  }

  return (
    <div data-source-file="src/components/studio/CinematicVideoTab.tsx">
      <SampleGallery />

      <div className="grid gap-8 rounded-2xl border-gradient bg-surface/40 p-6 sm:p-8 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">画像をアップロード</label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileSelected(file);
                e.target.value = "";
              }}
            />
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              className="relative flex min-h-[180px] cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-dashed border-border bg-background p-4 text-center transition-colors hover:border-neon-violet/40"
            >
              {croppedPreviewUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={croppedPreviewUrl}
                    alt="クロップ済み画像"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                  <span className="relative z-10 mt-auto rounded-md bg-black/60 px-2 py-1 text-[11px] text-white">
                    クリックして選び直す（アスペクト比: {aspect}）
                  </span>
                </>
              ) : (
                <>
                  <ImagePlus size={26} className="text-muted" />
                  <p className="text-sm font-medium text-foreground">クリックして画像を選択</p>
                  <p className="text-[11px] text-muted">選択後、クロップ画面でアスペクト比を指定します</p>
                </>
              )}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-muted">画質・速度モード</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {CINEMATIC_MODES.map((m) => {
                const dims = cinematicTargetDimensions(m, aspect);
                const isSelected = modeId === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setModeId(m.id)}
                    className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors ${
                      isSelected
                        ? "border-neon-pink/50 bg-neon-pink/10"
                        : "border-border bg-background hover:border-neon-violet/40"
                    }`}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="text-sm font-semibold text-foreground">{m.label}</span>
                      {isSelected && (
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-neon-pink text-white">
                          <Check size={10} />
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-muted">{m.tagline}</span>
                    <span className="font-mono text-[11px] text-neon-pink">
                      {m.credits} Credit{m.credits > 1 ? "s" : ""}
                    </span>
                    <span className="font-mono text-[10px] text-muted/70">
                      {dims.width}×{dims.height} / {m.steps} steps
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="cinematic-prompt" className="mb-1.5 block text-xs font-medium text-muted">
              プロンプト（任意）
            </label>
            <textarea
              id="cinematic-prompt"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="未入力の場合は自動でシネマティックな演出を生成します"
              className="w-full resize-none rounded-lg border border-border bg-background px-4 py-3 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
            />
          </div>

          <GpuWarmStokeWidget />

          <button
            type="button"
            onClick={handleGenerate}
            disabled={status === "loading" || missingInputs}
            className={`flex items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-sm font-semibold text-white transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
              insufficientCredits
                ? "bg-amber-600/80 hover:opacity-90"
                : "bg-gradient-to-r from-neon-pink to-neon-violet hover:opacity-90 glow-pink"
            }`}
          >
            {buttonLabel}
          </button>

          <p className="-mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted">
            <Sparkles size={14} className="mt-0.5 shrink-0 text-neon-violet" />
            {user
              ? "保有クレジットの範囲でいつでも生成できます。15秒の音声付き動画が生成されます。"
              : "Cinematic Video の利用には新規登録 / ログインが必要です。"}
          </p>

          <p className="-mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            動画生成は処理に時間がかかる場合があります（サーバーの混雑状況により数分かかることがあります）。処理中にページを離れると結果を受け取れません。
          </p>

          {status === "error" && errorMessage && (
            <p className="-mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {errorMessage}
            </p>
          )}
        </div>

        <div className="flex flex-col">
          <p className="mb-1.5 text-xs font-medium text-muted">プレビュー</p>
          <p className="mb-3 text-xs leading-relaxed text-muted">
            ※生成動画自体はサーバー上に保存されず、ブラウザを閉じると消滅します。生成後すぐにダウンロードしてください。
          </p>

          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-background">
            {status === "loading" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface/60">
                <div className="absolute inset-4 animate-pulse rounded-lg bg-surface-hover/60" />
                <span className="relative z-10 flex items-center gap-1.5 rounded-full border border-neon-pink/40 bg-neon-pink/10 px-3 py-1 font-mono text-[11px] font-medium text-neon-pink">
                  <Zap size={12} />
                  Logic Engine ({mode.label})
                </span>
                <span className="relative z-10 flex items-center gap-1.5 rounded-full border border-border bg-background/80 px-3 py-1 font-mono text-[11px] font-medium text-foreground">
                  {jobPhase === "queued"
                    ? "⏳ サーバー待機列に並んでいます..."
                    : `⚡ レンダリング中... ${formatElapsedSeconds(elapsedMs)}s`}
                </span>
                <Loader2 size={28} className="relative z-10 animate-spin text-neon-pink" />
                <span className="relative z-10 font-mono text-xs text-muted">
                  {jobPhase === "queued" ? "空きGPUを確保しています..." : "高精度サンプリング中..."}
                </span>
              </div>
            )}

            {status === "idle" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted">
                <Clapperboard size={28} className="opacity-40" />
                <span className="text-xs">生成結果がここに表示されます</span>
              </div>
            )}

            {status === "error" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted">
                <Film size={28} className="opacity-40" />
                <span className="text-xs">生成に失敗しました</span>
              </div>
            )}

            {status === "done" && resultUrl && (
              <video src={resultUrl} controls autoPlay loop playsInline className="h-full w-full object-contain" />
            )}
          </div>

          {status === "done" && resultUrl && (
            <>
              <p className="mt-3 text-center font-mono text-xs text-muted">
                ⚡ 生成完了（所要時間: {formatElapsedSeconds(elapsedMs)}秒）
              </p>
              <a
                href={resultUrl}
                download={downloadFilename ?? buildDownloadFilename()}
                className="mt-2 flex items-center justify-center gap-2 rounded-xl border border-border bg-surface/60 px-6 py-3 text-sm font-medium text-foreground transition-colors hover:border-neon-pink/50 hover:bg-surface-hover"
              >
                <Download size={16} />
                Download
              </a>
            </>
          )}
        </div>
      </div>

      <ImageCropper
        open={cropperOpen}
        imageUrl={sourceImageUrl}
        initialAspect={aspect}
        onCancel={() => setCropperOpen(false)}
        onConfirm={handleCropConfirm}
      />

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        message="Cinematic Video で動画を生成するにはログインしてください。"
      />
      <InsufficientCreditsModal
        open={chargeModalOpen}
        onClose={() => setChargeModalOpen(false)}
        credits={credits}
        cost={mode.credits}
      />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
