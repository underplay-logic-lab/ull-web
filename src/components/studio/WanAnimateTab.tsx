"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  Download,
  Film,
  ImagePlus,
  Loader2,
  LogIn,
  Sparkles,
  UploadCloud,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import {
  WAN_ANIMATE_GENERATION_COST,
  WAN_ANIMATE_GPU_SPEC,
  WAN_ANIMATE_GPU_ULTRA_ADDON,
  WAN_ANIMATE_MODEL_NAME,
  WAN_ANIMATE_MODEL_PARAMS,
  WAN_ANIMATE_ULTRA_GPU_SPEC,
} from "@/lib/data";
import { generateWanAnimateVideo } from "@/lib/wanAnimateApi";
import type { GpuTier } from "@/lib/gpuTier";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { LoginModal } from "@/components/LoginModal";
import { GpuTierSelector } from "@/components/studio/GpuTierSelector";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits } from "@/hooks/useProfileCredits";
import { broadcastCreditsUpdate } from "@/hooks/useProfileCredits";

type Status = "idle" | "loading" | "done" | "error";
type MotionMode = "preset" | "custom";

const GPU_TIER_ADDON_KEY = "wan_animate_gpu_ultra_addon";

// This tab has no per-workflow slug (unlike CustomWorkflowsTab), so it uses
// a single fixed persistence id — see studioFormPersistence.ts. Image/video
// File values are never persisted (browsers can't restore an actual File).
const WAN_ANIMATE_FORM_ID = "wan-animate-2";

type PersistedWanAnimateForm = {
  motionMode: MotionMode;
  gpuTier: GpuTier;
  selectedPresetId: string | null;
  prompt: string;
};

type StudioMotionPreset = {
  id: string;
  title: string;
  category: string;
  video_url: string;
  thumbnail_url: string | null;
  priority: number;
};

const PRICING_KEY_BY_MODE: Record<MotionMode, string> = {
  preset: "wan_animate_preset",
  custom: "wan_animate_custom",
};

function useObjectUrl(file: File | null): string | null {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  return url;
}

function buildDownloadFilename() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `ullstudio_wananimate_${datePart}_${timePart}.mp4`;
}

type FileDropzoneProps = {
  accept: string;
  file: File | null;
  previewUrl: string | null;
  onFileSelected: (file: File) => void;
  onClear: () => void;
  icon: ReactNode;
  label: string;
  hint: string;
  previewKind: "image" | "video";
};

function FileDropzone({
  accept,
  file,
  previewUrl,
  onFileSelected,
  onClear,
  icon,
  label,
  hint,
  previewKind,
}: FileDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = (files: FileList | null) => {
    const picked = files?.[0];
    if (picked) onFileSelected(picked);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
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
        className={`relative flex min-h-[180px] cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-dashed p-4 text-center transition-colors ${
          isDragging
            ? "border-neon-pink/70 bg-neon-pink/10"
            : "border-border bg-background hover:border-neon-violet/40"
        }`}
      >
        {previewUrl ? (
          <>
            {previewKind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt={file?.name ?? "アップロード画像"}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <video
                src={previewUrl}
                className="absolute inset-0 h-full w-full object-cover"
                muted
                loop
                autoPlay
                playsInline
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
              aria-label="削除"
              className="absolute right-2 top-2 z-10 rounded-full bg-black/60 p-1.5 text-white transition-colors hover:bg-black/80"
            >
              <X size={14} />
            </button>
            <span className="relative z-10 mt-auto max-w-full truncate rounded-md bg-black/60 px-2 py-1 text-[11px] text-white">
              {file?.name}
            </span>
          </>
        ) : (
          <>
            <span className="text-muted">{icon}</span>
            <p className="text-sm font-medium text-foreground">{label}</p>
            <p className="text-[11px] text-muted">{hint}</p>
          </>
        )}
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
      data-source-file="src/components/studio/WanAnimateTab.tsx"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border-gradient bg-surface p-8"
        onClick={(e) => e.stopPropagation()}
      >
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
          Wan Animate 2 の動画生成には {cost} クレジット必要です。現在の保有クレジット:{" "}
          {credits ?? 0}
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

export function WanAnimateTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);

  const [characterImage, setCharacterImage] = useState<File | null>(null);
  const characterPreviewUrl = useObjectUrl(characterImage);

  const savedForm = useMemo(() => loadFormState<PersistedWanAnimateForm>(WAN_ANIMATE_FORM_ID), []);

  const [motionMode, setMotionMode] = useState<MotionMode>(savedForm?.motionMode ?? "preset");
  const [gpuTier, setGpuTier] = useState<GpuTier>(savedForm?.gpuTier === "ultra" ? "ultra" : "standard");
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(savedForm?.selectedPresetId ?? null);
  const [customVideoFile, setCustomVideoFile] = useState<File | null>(null);
  const customVideoPreviewUrl = useObjectUrl(customVideoFile);

  const [presets, setPresets] = useState<StudioMotionPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [pricing, setPricing] = useState<Record<string, number>>({});

  const [prompt, setPrompt] = useState(savedForm?.prompt ?? "");
  const [status, setStatus] = useState<Status>("idle");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [downloadFilename, setDownloadFilename] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeModalOpen, setChargeModalOpen] = useState(false);

  useEffect(() => {
    (async () => {
      setPresetsLoading(true);
      try {
        const res = await fetch("/api/studio/presets");
        const data = await res.json();
        if (res.ok) {
          setPresets(data.presets as StudioMotionPreset[]);
        } else {
          console.error("[WanAnimateTab] failed to load presets:", data?.error);
        }
      } catch (err) {
        console.error("[WanAnimateTab] failed to load presets:", err);
      } finally {
        setPresetsLoading(false);
      }
    })();

    (async () => {
      try {
        const res = await fetch("/api/studio/pricing");
        const data = await res.json();
        if (res.ok) {
          setPricing(data.pricing as Record<string, number>);
        } else {
          console.error("[WanAnimateTab] failed to load pricing:", data?.error);
        }
      } catch (err) {
        console.error("[WanAnimateTab] failed to load pricing:", err);
      }
    })();
  }, []);

  // Auto-save text/mode/preset selection + GPU tier — image/video File
  // values are intentionally excluded (see PersistedWanAnimateForm).
  useEffect(() => {
    const state: PersistedWanAnimateForm = { motionMode, gpuTier, selectedPresetId, prompt };
    saveFormState(WAN_ANIMATE_FORM_ID, state);
  }, [motionMode, gpuTier, selectedPresetId, prompt]);

  const baseGenerationCost = pricing[PRICING_KEY_BY_MODE[motionMode]] ?? WAN_ANIMATE_GENERATION_COST;
  const gpuTierAddon = pricing[GPU_TIER_ADDON_KEY] ?? WAN_ANIMATE_GPU_ULTRA_ADDON;
  const generationCost = baseGenerationCost + (gpuTier === "ultra" ? gpuTierAddon : 0);
  const activeGpuSpec = gpuTier === "ultra" ? WAN_ANIMATE_ULTRA_GPU_SPEC : WAN_ANIMATE_GPU_SPEC;

  const missingInputs =
    !characterImage || (motionMode === "preset" ? !selectedPresetId : !customVideoFile);
  const insufficientCredits =
    Boolean(user) && !creditsLoading && (credits ?? 0) < generationCost;

  const handleGenerate = async () => {
    if (status === "loading" || missingInputs || !characterImage) return;

    if (!user) {
      setLoginOpen(true);
      return;
    }

    if (insufficientCredits) {
      setChargeModalOpen(true);
      return;
    }

    setStatus("loading");
    setResultUrl(null);
    setDownloadFilename(null);
    setErrorMessage(null);

    try {
      const result = await generateWanAnimateVideo({
        characterImage,
        motionMode,
        presetId: motionMode === "preset" ? selectedPresetId : null,
        customMotionVideo: motionMode === "custom" ? customVideoFile : null,
        prompt,
        gpuTier,
      });

      setResultUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return result.videoUrl;
      });
      setDownloadFilename(buildDownloadFilename());
      setStatus("done");
      broadcastCreditsUpdate(user.id, result.remainingCredits);
    } catch (err) {
      console.error("[WanAnimateTab] generation failed:", err);
      setErrorMessage(err instanceof Error ? err.message : "動画生成に失敗しました。");
      setStatus("error");

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
        生成中...
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
        {generationCost} クレジットで生成
      </>
    );
  }

  return (
    <div
      data-source-file="src/components/studio/WanAnimateTab.tsx"
      className="grid gap-8 rounded-2xl border-gradient bg-surface/40 p-6 sm:p-8 lg:grid-cols-2"
    >
      <div className="flex flex-col gap-6">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted">
            キャラクター画像
          </label>
          <FileDropzone
            accept="image/*"
            file={characterImage}
            previewUrl={characterPreviewUrl}
            onFileSelected={setCharacterImage}
            onClear={() => setCharacterImage(null)}
            icon={<ImagePlus size={26} />}
            label="ドラッグ＆ドロップ、またはクリックして選択"
            hint="JPG / PNG（顔がはっきり写っている画像推奨）"
            previewKind="image"
          />
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">動作（ポーズ動画）</p>
          <div className="flex gap-1 rounded-lg border border-border bg-background p-1">
            <button
              type="button"
              onClick={() => setMotionMode("preset")}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                motionMode === "preset"
                  ? "bg-surface-hover text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              プリセットから選ぶ（初心者向け）
            </button>
            <button
              type="button"
              onClick={() => setMotionMode("custom")}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                motionMode === "custom"
                  ? "bg-surface-hover text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              カスタム動画をアップロード（Pro向け）
            </button>
          </div>

          {motionMode === "preset" ? (
            presetsLoading ? (
              <div className="mt-3 flex items-center justify-center gap-2 rounded-lg border border-border bg-background py-10 text-xs text-muted">
                <Loader2 size={16} className="animate-spin" />
                プリセットを読み込み中...
              </div>
            ) : presets.length === 0 ? (
              <div className="mt-3 rounded-lg border border-border bg-background py-10 text-center text-xs text-muted">
                利用可能なプリセットがありません。カスタム動画をご利用ください。
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-3 gap-3">
                {presets.map((preset) => {
                  const isSelected = selectedPresetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setSelectedPresetId(preset.id)}
                      className={`group relative aspect-video overflow-hidden rounded-lg border transition-colors ${
                        isSelected
                          ? "border-neon-pink"
                          : "border-border hover:border-neon-violet/50"
                      }`}
                    >
                      <video
                        src={preset.video_url}
                        poster={preset.thumbnail_url ?? undefined}
                        className="h-full w-full object-cover"
                        muted
                        loop
                        autoPlay
                        playsInline
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/5 to-transparent" />
                      <span className="absolute inset-x-0 bottom-0 p-1.5 text-center text-[11px] font-medium leading-tight text-white">
                        {preset.title}
                      </span>
                      {isSelected && (
                        <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neon-pink text-white">
                          <Check size={12} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )
          ) : (
            <div className="mt-3">
              <FileDropzone
                accept="video/mp4,.mp4"
                file={customVideoFile}
                previewUrl={customVideoPreviewUrl}
                onFileSelected={setCustomVideoFile}
                onClear={() => setCustomVideoFile(null)}
                icon={<UploadCloud size={26} />}
                label="ドラッグ＆ドロップ、またはクリックして選択"
                hint="MP4形式（人物の全身が映る動画推奨）"
                previewKind="video"
              />
            </div>
          )}
        </div>

        <div>
          <label htmlFor="wan-animate-prompt" className="mb-1.5 block text-xs font-medium text-muted">
            プロンプト（任意）
          </label>
          <textarea
            id="wan-animate-prompt"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="未入力の場合は自動で最適なアニメーションを生成します"
            className="w-full resize-none rounded-lg border border-border bg-background px-4 py-3 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
          />
        </div>

        <GpuTierSelector value={gpuTier} onChange={setGpuTier} baseCost={baseGenerationCost} addonCost={gpuTierAddon} />

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
            ? `保有クレジットの範囲でいつでも生成できます（1生成につき${generationCost}クレジット消費）。`
            : "Wan Animate 2 の利用には新規登録 / ログインが必要です。初回登録で10クレジットが付与されます。"}
        </p>

        <p className="-mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          動画生成は処理に時間がかかる場合があります。最大実行時間は30分です。超過した場合は処理が強制終了され、消費済みクレジットの返金はできませんのでご了承ください。
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
                {activeGpuSpec.name} ({activeGpuSpec.vramGb}GB VRAM){" "}
                {activeGpuSpec.deploymentMode}
              </span>

              <Loader2 size={28} className="relative z-10 animate-spin text-neon-pink" />

              <span className="relative z-10 font-mono text-xs text-muted">
                {WAN_ANIMATE_MODEL_NAME} ({WAN_ANIMATE_MODEL_PARAMS}) モデルで高精度サンプリング中...
              </span>
              <span className="relative z-10 max-w-[80%] text-center text-[11px] text-muted/70">
                キャラクターの動きを解析し、アニメーションを合成しています
              </span>
            </div>
          )}

          {status === "idle" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted">
              <Film size={28} className="opacity-40" />
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
            <video
              src={resultUrl}
              controls
              autoPlay
              loop
              playsInline
              className="h-full w-full object-contain"
            />
          )}
        </div>

        {status === "done" && resultUrl && (
          <a
            href={resultUrl}
            download={downloadFilename ?? buildDownloadFilename()}
            className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-border bg-surface/60 px-6 py-3 text-sm font-medium text-foreground transition-colors hover:border-neon-pink/50 hover:bg-surface-hover"
          >
            <Download size={16} />
            Download
          </a>
        )}
      </div>

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        message="Wan Animate 2 で動画を生成するにはログインしてください。"
      />
      <InsufficientCreditsModal
        open={chargeModalOpen}
        onClose={() => setChargeModalOpen(false)}
        credits={credits}
        cost={generationCost}
      />
    </div>
  );
}
