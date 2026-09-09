"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import JSZip from "jszip";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ImagePlus,
  Layers,
  Loader2,
  LogIn,
  RefreshCw,
  Sparkles,
  Wand2,
  X,
  Zap,
  ZoomIn,
} from "lucide-react";
import {
  ANGLE_MODES,
  ANGLE_PRESETS,
  angleCreditsPerAngle,
  AZIMUTH_OPTIONS,
  angleSelectionWarning,
  buildAngleCombos,
  DISTANCE_OPTIONS,
  ELEVATION_OPTIONS,
  EMPTY_ANGLE_SELECTION,
  MAX_ANGLES,
  MIN_ANGLES,
  type AngleAxis,
  type AngleAxisOption,
  type AngleCombo,
  type AngleMode,
  type AngleSelection,
} from "@/lib/angleStudio";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import {
  downloadAngleImage,
  pollAngleJob,
  startAngleJob,
  type AngleApiError,
  type AngleJob,
} from "@/lib/angleApi";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { VramBadge } from "@/components/studio/VramBadge";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useElapsedTimer, formatElapsedSeconds } from "@/hooks/useElapsedTimer";

type Phase = "idle" | "submitting" | "running" | "done" | "error";

const FORM_ID = "multi-angle-studio";
const JOB_KEY = "multi-angle-active-job";
// アップロード前の生ファイルの受け入れ上限。これを超えるとブラウザでの
// 縮小（createImageBitmap → canvas）でメモリを食い過ぎるうえ、縮小に失敗
// した場合にサーバーの 12MB 制限に確実に弾かれる。縮小後は数百KBになる。
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const POLL_INTERVAL_MS = 2500;
const POLL_MAX_CONSECUTIVE_ERRORS = 8;

type PersistedForm = { mode: AngleMode; selection: AngleSelection };

function useObjectUrl(file: File | null): string | null {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return url;
}

function buildZipFilename() {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `ullstudio_angle_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(
    now.getHours(),
  )}${p(now.getMinutes())}${p(now.getSeconds())}.zip`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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
        className={`relative flex min-h-[200px] cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-dashed p-4 text-center transition-colors ${
          isDragging
            ? "border-neon-pink/70 bg-neon-pink/10"
            : "border-border bg-background hover:border-neon-violet/40"
        }`}
      >
        {previewUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt={file?.name ?? "アップロード画像"}
              className="absolute inset-0 h-full w-full object-contain"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
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
            <span className="text-muted">
              <ImagePlus size={26} />
            </span>
            <p className="text-sm font-medium text-foreground">
              ドラッグ＆ドロップ、またはクリックして選択
            </p>
            <p className="text-[11px] text-muted">JPG / PNG（キャラクターがはっきり写った画像推奨）</p>
          </>
        )}
      </div>
    </div>
  );
}

// --- 構図軸（チェックボックス群） -------------------------------------
function AxisGroup({
  title,
  options,
  selected,
  onToggle,
  onAll,
  onClear,
}: {
  title: string;
  options: AngleAxisOption[];
  selected: string[];
  onToggle: (id: string) => void;
  onAll: () => void;
  onClear: () => void;
}) {
  const selectedSet = new Set(selected);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-xs font-medium text-muted">{title}</p>
        <div className="flex gap-2 text-[10px] text-muted">
          <button type="button" onClick={onAll} className="transition-colors hover:text-neon-violet">
            全部
          </button>
          <span className="text-border">/</span>
          <button type="button" onClick={onClear} className="transition-colors hover:text-neon-violet">
            クリア
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const on = selectedSet.has(opt.id);
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onToggle(opt.id)}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                on
                  ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                  : "border-border bg-background text-muted hover:border-neon-violet/40 hover:text-foreground"
              }`}
            >
              <span
                className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${
                  on ? "border-neon-pink bg-neon-pink text-white" : "border-border"
                }`}
              >
                {on && <Check size={10} />}
              </span>
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- 結果ライトボックス（最小構成） ----------------------------------
type LightItem = { url: string; label: string };

function AngleLightbox({
  items,
  index,
  onIndexChange,
  onClose,
}: {
  items: LightItem[];
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
}) {
  const item = items[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onIndexChange(Math.max(0, index - 1));
      else if (e.key === "ArrowRight") onIndexChange(Math.min(items.length - 1, index + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length, index, onClose, onIndexChange]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (!item || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="生成画像の拡大表示"
    >
      <div
        className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs text-white/80"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 truncate">
          {item.label}
          <span className="ml-2 text-white/40">
            {index + 1} / {items.length}
          </span>
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              downloadAngleImage(item.url, `${String(index + 1).padStart(2, "0")}_angle.png`).catch(() => {})
            }
            className="inline-flex items-center gap-1 rounded-md border border-white/20 px-2 py-1 text-[11px] transition-colors hover:bg-white/10"
          >
            <Download size={12} />
            保存
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="inline-flex items-center justify-center rounded-md border border-white/20 p-1.5 transition-colors hover:bg-white/10"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="absolute inset-0 flex items-center justify-center p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.url} alt={item.label} className="max-h-full max-w-full select-none object-contain" />
        </div>
        {items.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => onIndexChange(Math.max(0, index - 1))}
              disabled={index === 0}
              aria-label="前の画像"
              className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full border border-white/20 bg-black/50 p-2 text-white transition-colors hover:bg-black/70 disabled:opacity-25"
            >
              <ChevronLeft size={22} />
            </button>
            <button
              type="button"
              onClick={() => onIndexChange(Math.min(items.length - 1, index + 1))}
              disabled={index === items.length - 1}
              aria-label="次の画像"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full border border-white/20 bg-black/50 p-2 text-white transition-colors hover:bg-black/70 disabled:opacity-25"
            >
              <ChevronRight size={22} />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
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
          この生成には {cost} クレジット必要です。現在の保有クレジット: {credits ?? 0}
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

export function MultiAngleStudioTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs } = usePricingKnobs();

  const savedForm = useMemo(() => loadFormState<PersistedForm>(FORM_ID), []);

  const [image, setImage] = useState<File | null>(null);
  const imagePreview = useObjectUrl(image);
  const [imageError, setImageError] = useState<string | null>(null);

  const handleImageSelected = useCallback((file: File) => {
    if (file.size > MAX_SOURCE_BYTES) {
      setImageError("画像ファイルが大きすぎます。25MB 以下の画像を選んでください。");
      return;
    }
    setImageError(null);
    setImage(file);
  }, []);

  // 2026-09-09: turbo/pro を廃止し単一モードに統一。
  const mode: AngleMode = "standard";
  const [selection, setSelection] = useState<AngleSelection>(() => {
    const s = savedForm?.selection;
    if (!s || !Array.isArray(s.azimuths) || !Array.isArray(s.elevations) || !Array.isArray(s.distances)) {
      return ANGLE_PRESETS[0].selection;
    }
    return { azimuths: s.azimuths, elevations: s.elevations, distances: s.distances };
  });

  // 直近のアクティブジョブがあれば復元してポーリングを再開する（初期値で解決 —
  // 効果内 setState を避ける）。
  const resumedJobId = useMemo(() => loadFormState<{ jobId: string }>(JOB_KEY)?.jobId || null, []);
  const [phase, setPhase] = useState<Phase>(resumedJobId ? "running" : "idle");
  const [jobId, setJobId] = useState<string | null>(resumedJobId);
  const [job, setJob] = useState<AngleJob | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // reroll: 別ジョブを1構図で投げ、完了したら該当セルの URL を差し替える。
  const [submittedCombos, setSubmittedCombos] = useState<AngleCombo[]>([]);
  const [reroll, setReroll] = useState<{ index: number; jobId: string } | null>(null);

  const [zipping, setZipping] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);

  const elapsedMs = useElapsedTimer(phase === "running");

  useEffect(() => {
    saveFormState(FORM_ID, { mode, selection } satisfies PersistedForm);
  }, [mode, selection]);

  // --- メインポーリングループ ----------------------------------------
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let errorStreak = 0;

    (async () => {
      while (!cancelled) {
        try {
          const next = await pollAngleJob(jobId);
          if (cancelled) return;
          errorStreak = 0;
          setJob(next);

          if (next.status === "completed") {
            setPhase("done");
            return;
          }
          if (next.status === "failed") {
            setPhase("error");
            setErrorMessage(next.errorMessage || "生成に失敗しました。");
            return;
          }
          setPhase("running");
        } catch (err) {
          if (cancelled) return;
          errorStreak += 1;
          console.warn("[MultiAngleStudioTab] poll error:", err);
          if (errorStreak >= POLL_MAX_CONSECUTIVE_ERRORS) {
            setPhase("error");
            setErrorMessage("生成状況の取得に繰り返し失敗しました。時間をおいて再読み込みしてください。");
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

  // --- reroll ジョブのポーリング -------------------------------------
  useEffect(() => {
    if (!reroll) return;
    let cancelled = false;

    (async () => {
      let streak = 0;
      while (!cancelled) {
        try {
          const r = await pollAngleJob(reroll.jobId);
          if (cancelled) return;
          streak = 0;
          if (r.status === "completed" && r.images[0]) {
            setJob((prev) => {
              if (!prev) return prev;
              const images = [...prev.images];
              images[reroll.index] = r.images[0];
              return { ...prev, images };
            });
            setReroll(null);
            return;
          }
          if (r.status === "failed") {
            setReroll(null);
            setErrorMessage("リロールに失敗しました。");
            return;
          }
        } catch {
          streak += 1;
          if (streak >= POLL_MAX_CONSECUTIVE_ERRORS) {
            setReroll(null);
            return;
          }
        }
        await sleep(POLL_INTERVAL_MS);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reroll]);

  const combos = useMemo(() => buildAngleCombos(selection), [selection]);
  const selectionWarning = useMemo(() => angleSelectionWarning(selection), [selection]);
  const count = combos.length;
  const perAngle = angleCreditsPerAngle(knobs);
  const cost = count * perAngle;
  const overCap = count > MAX_ANGLES;
  const underMin = count > 0 && count < MIN_ANGLES;

  const insufficientCredits = Boolean(user) && !creditsLoading && (credits ?? 0) < cost;
  const busy = phase === "submitting" || phase === "running";
  const missingInputs = !image || count === 0 || overCap || underMin;

  const toggleOption = useCallback((axis: AngleAxis, id: string) => {
    setSelection((prev) => {
      const has = prev[axis].includes(id);
      return { ...prev, [axis]: has ? prev[axis].filter((x) => x !== id) : [...prev[axis], id] };
    });
  }, []);

  const setAxis = useCallback((axis: AngleAxis, ids: string[]) => {
    setSelection((prev) => ({ ...prev, [axis]: ids }));
  }, []);

  const handleGenerate = async () => {
    if (busy || missingInputs || !image) return;
    if (!user) return setLoginOpen(true);
    if (insufficientCredits) return setChargeOpen(true);

    setPhase("submitting");
    setErrorMessage(null);
    setJob(null);
    setSubmittedCombos(combos);

    try {
      const res = await startAngleJob({ image, selection, mode });
      broadcastCreditsUpdate(user.id, res.remainingCredits);
      saveFormState(JOB_KEY, { jobId: res.jobId });
      setJob({
        id: res.jobId,
        status: "pending",
        mode,
        totalAngles: res.totalAngles,
        completedAngles: 0,
        images: [],
        labels: combos.map((c) => c.labelJa),
        errorMessage: null,
        vramUsedGb: null,
      });
      setJobId(res.jobId);
      setPhase("running");
    } catch (err) {
      console.error("[MultiAngleStudioTab] start failed:", err);
      setErrorMessage(err instanceof Error ? err.message : "ジョブの作成に失敗しました。");
      setPhase("error");
      const remaining = (err as AngleApiError)?.remainingCredits;
      if (typeof remaining === "number") broadcastCreditsUpdate(user.id, remaining);
    }
  };

  const handleReroll = async (index: number) => {
    const combo = submittedCombos[index];
    if (!image || !user || !combo || reroll) return;
    if (!creditsLoading && (credits ?? 0) < perAngle) return setChargeOpen(true);
    try {
      // seed を渡さない = worker が generator なしで実行 → 毎回別の結果。
      const res = await startAngleJob({ image, selection: combo.selection, mode });
      broadcastCreditsUpdate(user.id, res.remainingCredits);
      setReroll({ index, jobId: res.jobId });
    } catch (err) {
      const remaining = (err as AngleApiError)?.remainingCredits;
      if (typeof remaining === "number") {
        broadcastCreditsUpdate(user.id, remaining);
        setChargeOpen(true);
      } else {
        setErrorMessage(err instanceof Error ? err.message : "リロールの起動に失敗しました。");
      }
    }
  };

  const images = job?.images ?? [];
  const labels = job?.labels ?? [];
  const lightItems: LightItem[] = images.map((url, i) => ({ url, label: labels[i] ?? "" }));

  const handleZip = async () => {
    if (!images.length || zipping) return;
    setZipping(true);
    try {
      const zip = new JSZip();
      await Promise.all(
        images.map(async (url, i) => {
          const res = await fetch(url);
          if (!res.ok) return;
          const buf = await res.arrayBuffer();
          zip.file(`${String(i + 1).padStart(2, "0")}_angle.png`, buf);
        }),
      );
      const blob = await zip.generateAsync({ type: "blob" });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = buildZipFilename();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (err) {
      console.error("[MultiAngleStudioTab] zip failed:", err);
      setErrorMessage("ZIP の作成に失敗しました。");
    } finally {
      setZipping(false);
    }
  };

  const progressPct = job && job.totalAngles > 0 ? (job.completedAngles / job.totalAngles) * 100 : 0;

  let buttonLabel: ReactNode;
  if (phase === "submitting") {
    buttonLabel = (
      <>
        <Loader2 size={16} className="animate-spin" />
        ジョブを作成中...
      </>
    );
  } else if (phase === "running") {
    buttonLabel = (
      <>
        <Loader2 size={16} className="animate-spin" />
        生成中 {job ? `${job.completedAngles}/${job.totalAngles}` : ""}
      </>
    );
  } else if (!user) {
    buttonLabel = (
      <>
        <LogIn size={16} />
        ログインして生成
      </>
    );
  } else if (overCap) {
    buttonLabel = (
      <>
        <AlertTriangle size={16} />
        構図が多すぎます（最大 {MAX_ANGLES}）
      </>
    );
  } else if (underMin) {
    buttonLabel = (
      <>
        <AlertTriangle size={16} />
        最低 {MIN_ANGLES} 構図から生成できます
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
        {count} 構図を一括生成（{cost} クレジット）
      </>
    );
  }

  const presetActive = (sel: AngleSelection) => JSON.stringify(sel) === JSON.stringify(selection);

  return (
    <div
      data-source-file="src/components/studio/MultiAngleStudioTab.tsx"
      className="rounded-2xl border-gradient bg-surface/40 p-6 sm:p-8"
    >
      <div className="grid gap-8 lg:grid-cols-2">
        {/* 左: 入力 */}
        <div className="flex flex-col gap-6">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">キャラクター画像</label>
            <ImageDropzone
              file={image}
              previewUrl={imagePreview}
              onFileSelected={handleImageSelected}
              onClear={() => {
                setImage(null);
                setImageError(null);
              }}
            />
            {imageError && (
              <p className="mt-1.5 text-[11px] text-red-400">{imageError}</p>
            )}
          </div>


          {/* アクションバー */}
          <div className="rounded-xl border border-border bg-background p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-muted">
                <Layers size={14} />
                選択中
              </span>
              <span className="font-mono font-medium text-foreground">
                {count} 構図{" "}
                <span className={overCap ? "text-red-400" : "text-neon-pink"}>（{cost} Credits）</span>
              </span>
            </div>

            {phase === "running" && job && (
              <div className="mt-3">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-violet transition-[width] duration-500"
                    style={{ width: `${Math.max(4, progressPct)}%` }}
                  />
                </div>
                <p className="mt-1.5 text-center text-[11px] text-muted">
                  {job.completedAngles} / {job.totalAngles} 構図 完了（{formatElapsedSeconds(elapsedMs)}s）
                </p>
                {job.vramUsedGb != null && (
                  <div className="mt-2 flex justify-center">
                    <VramBadge gb={job.vramUsedGb} />
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={handleGenerate}
              disabled={busy || missingInputs}
              className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-sm font-semibold text-white transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                overCap || insufficientCredits
                  ? "bg-amber-600/80 hover:opacity-90"
                  : "bg-gradient-to-r from-neon-pink to-neon-violet hover:opacity-90 glow-pink"
              }`}
            >
              {buttonLabel}
            </button>
          </div>

          {busy && (
            <p className="-mt-2 flex items-start gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/10 px-3 py-2 text-xs leading-relaxed text-neon-violet">
              <Sparkles size={14} className="mt-0.5 shrink-0" />
              バックグラウンドで生成中です。このタブを閉じたり再読み込みしても生成は継続し、次に開いたときに途中から表示されます。
            </p>
          )}

          <p className="-mt-2 flex items-start gap-2 text-xs leading-relaxed text-muted">
            <Sparkles size={14} className="mt-0.5 shrink-0 text-neon-violet" />
            {user
              ? `1 構図あたり ${perAngle} クレジット（${ANGLE_MODES[mode].label}）。生成は 1 構図完了するごとに下のギャラリーへ順次追加されます。`
              : "Multi-Angle Studio の利用にはログインが必要です。初回登録で10クレジットが付与されます。"}
          </p>

          {phase === "error" && errorMessage && (
            <p className="-mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {errorMessage}
            </p>
          )}
        </div>

        {/* 右: 構図選択マトリクス */}
        <div className="flex flex-col gap-5">
          <div>
            <p className="mb-2 text-xs font-medium text-muted">クイックプリセット</p>
            <div className="flex flex-wrap gap-1.5">
              {ANGLE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setSelection(preset.selection)}
                  title={preset.hint}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    presetActive(preset.selection)
                      ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                      : "border-border bg-background text-muted hover:border-neon-violet/40 hover:text-foreground"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setSelection(EMPTY_ANGLE_SELECTION)}
                className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
              >
                全解除
              </button>
            </div>
          </div>

          <div className="grid gap-4 rounded-xl border border-border bg-background p-4">
            <AxisGroup
              title="方位（Azimuth）"
              options={AZIMUTH_OPTIONS}
              selected={selection.azimuths}
              onToggle={(id) => toggleOption("azimuths", id)}
              onAll={() => setAxis("azimuths", AZIMUTH_OPTIONS.map((o) => o.id))}
              onClear={() => setAxis("azimuths", [])}
            />
            <AxisGroup
              title="仰角（Elevation）"
              options={ELEVATION_OPTIONS}
              selected={selection.elevations}
              onToggle={(id) => toggleOption("elevations", id)}
              onAll={() => setAxis("elevations", ELEVATION_OPTIONS.map((o) => o.id))}
              onClear={() => setAxis("elevations", [])}
            />
            <AxisGroup
              title="距離（Distance）"
              options={DISTANCE_OPTIONS}
              selected={selection.distances}
              onToggle={(id) => toggleOption("distances", id)}
              onAll={() => setAxis("distances", DISTANCE_OPTIONS.map((o) => o.id))}
              onClear={() => setAxis("distances", [])}
            />
            <p className="text-[11px] leading-relaxed text-muted/70">
              各軸の組み合わせ（直積）が構図数になります。未選択の軸は元の画像のままにします。
              {overCap && (
                <span className="mt-1 block text-red-400">
                  現在 {count} 構図です。1 ジョブで生成できるのは最大 {MAX_ANGLES} 構図までです。
                </span>
              )}
            </p>
            {selectionWarning && (
              <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-300">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                {selectionWarning}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* 結果ギャラリー */}
      {job && (phase === "running" || phase === "done" || images.length > 0) && (
        <div className="mt-8 border-t border-border pt-6">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-medium text-muted">
              結果ギャラリー
              <span className="ml-2 text-muted/60">
                {job.completedAngles} / {job.totalAngles} 枚
              </span>
              {phase === "done" && <span className="ml-2 text-green-400">✓ 完了</span>}
            </p>
            {images.length > 0 && (
              <button
                type="button"
                onClick={handleZip}
                disabled={zipping}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-neon-pink/50 hover:bg-surface-hover disabled:opacity-50"
              >
                {zipping ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                一括ZIPダウンロード
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {images.map((url, i) => (
              <div key={i} className="group relative overflow-hidden rounded-lg border border-border bg-background">
                <button
                  type="button"
                  onClick={() => setLightboxIndex(i)}
                  className="block aspect-[3/4] w-full cursor-zoom-in"
                  aria-label={`${labels[i] ?? "構図"} を拡大`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={labels[i] ?? "生成画像"} loading="lazy" className="h-full w-full object-contain" />
                </button>

                {reroll?.index === i && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                    <Loader2 size={22} className="animate-spin text-neon-pink" />
                  </div>
                )}

                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/80 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <span className="truncate text-[10px] font-medium text-white">{labels[i] ?? ""}</span>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => setLightboxIndex(i)}
                      aria-label="拡大"
                      className="rounded-md bg-black/50 p-1 text-white transition-colors hover:bg-black/80"
                    >
                      <ZoomIn size={13} />
                    </button>
                    {submittedCombos[i] && (
                      <button
                        type="button"
                        onClick={() => handleReroll(i)}
                        disabled={Boolean(reroll)}
                        aria-label="リロール（別シードで再生成）"
                        className="rounded-md bg-black/50 p-1 text-white transition-colors hover:bg-black/80 disabled:opacity-40"
                      >
                        <RefreshCw size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        downloadAngleImage(url, `${String(i + 1).padStart(2, "0")}_angle.png`).catch(() => {})
                      }
                      aria-label="ダウンロード"
                      className="rounded-md bg-black/50 p-1 text-white transition-colors hover:bg-black/80"
                    >
                      <Download size={13} />
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {phase === "running" &&
              Array.from({ length: Math.max(0, Math.min(job.totalAngles - images.length, 12)) }).map((_, i) => (
                <div
                  key={`skeleton-${i}`}
                  className="flex aspect-[3/4] animate-pulse items-center justify-center rounded-lg border border-border bg-surface-hover/40"
                >
                  {i === 0 && <Loader2 size={18} className="animate-spin text-muted/50" />}
                </div>
              ))}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-muted/70">
            ※生成画像は一定期間後に自動削除されます。必要なものはダウンロードしてください。
          </p>
        </div>
      )}

      {lightboxIndex != null && lightItems[lightboxIndex] && (
        <AngleLightbox
          items={lightItems}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        message="Multi-Angle Studio で構図を生成するにはログインしてください。"
      />
      <InsufficientCreditsModal
        open={chargeOpen}
        onClose={() => setChargeOpen(false)}
        credits={credits}
        cost={cost || perAngle}
      />
    </div>
  );
}
