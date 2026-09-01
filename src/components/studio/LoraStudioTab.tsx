"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  Clapperboard,
  ClipboardCopy,
  Cpu,
  Download,
  ImagePlus,
  Loader2,
  Lock,
  LogIn,
  MessageCircle,
  RotateCcw,
  Sparkles,
  Trash2,
  Wand2,
  Zap,
} from "lucide-react";
import { LoginModal } from "@/components/LoginModal";
import { ToastStack, type ToastData } from "@/components/Toast";
import { QueueStatusPanel } from "@/components/studio/QueueStatusPanel";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { supabase } from "@/lib/supabaseClient";
import {
  startLoraTraining,
  pollLoraJob,
  uploadLoraDataset,
  downloadLoraCheckpoint,
  getLoraCheckpointDownloadUrl,
  salvageLoraJob,
  fetchRecentLoraJob,
  type LoraJobStatus,
  type LoraApiError,
  type LoraSalvageResult,
} from "@/lib/loraApi";
import {
  LORA_PRESETS,
  LORA_PRESET_GROUP_LABELS,
  LORA_BASE_ARCHITECTURES,
  LORA_RESOLUTIONS,
  LORA_RESOLUTION_LABELS,
  DEFAULT_LORA_RESOLUTION,
  BLOCKED_LORA_MODEL_MESSAGE,
  isBlockedLoraModel,
  loraPresetById,
  recommendedResolution,
  type LoraBaseArchitecture,
  type LoraPresetGroup,
  type LoraResolution,
} from "@/lib/loraModels";
import { DEFAULT_LORA_STEPS, LORA_MAX_STEPS } from "@/lib/loraCredits";
import {
  guiLoraPricingConfig,
  loraPriceBreakdown,
  loraPriceMultiplierSummary,
  LORA_CREDIT_WORST_CASE,
} from "@/lib/loraPricing";
import { validateLoraYaml, loraYamlIdentity } from "@/lib/loraYaml";
import { DatasetCurationUI, type CurationPair } from "@/components/studio/DatasetCurationUI";
import { parseDatasetZip, isZipFile, buildDatasetZip, downloadBlob } from "@/lib/datasetZip";
import {
  LORA_CAPTION_CATEGORIES,
  LORA_CAPTION_CATEGORY_META,
  captionSpecHasInput,
  buildCaptionFallbackPrompt,
  type LoraCaptionCategory,
  type LoraCaptionSpec,
} from "@/lib/loraCaptionSpec";
import { generateCaptionPrompt } from "@/lib/loraCaptionPrompt";
import { generateDatasetCaptions } from "@/lib/loraCaption";
const JOB_POLL_INTERVAL_MS = 3000;
const MAX_IMAGES = 200;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024; // 120 MB of raw image bytes

// Survives a page reload mid-job (dev server restart, browser refresh,
// accidental navigation) — job/phase state otherwise lives only in this
// component's useState and is gone the instant the page re-mounts, even
// though the job itself keeps running (or already finished) server-side.
// A finished job's checkpoint download buttons disappearing this way is
// what this exists to prevent.
const ACTIVE_JOB_STORAGE_KEY = "lora_studio_active_job";

// Auto-saved draft of the form's text inputs — so a browser crash / accidental
// reload / dev-server restart never loses a hand-written trigger word, raw
// YAML, or the Japanese "固定/変化させたい特徴" notes. Cleared only by the
// explicit "フォームを初期化" button, never automatically.
const FORM_DRAFT_STORAGE_KEY = "lora_studio_form_draft_v1";

type LoraFormDraft = {
  triggerWord: string;
  loraName: string;
  captionCategory: LoraCaptionCategory;
  captionFixed: string;
  captionVarying: string;
  captionPromptOverride: string;
  rawYaml: string;
  useRawYaml: boolean;
  curationEnabled: boolean;
};

const DEFAULT_FORM_DRAFT: LoraFormDraft = {
  triggerWord: "",
  loraName: "",
  captionCategory: "person",
  captionFixed: "",
  captionVarying: "",
  captionPromptOverride: "",
  rawYaml: "",
  useRawYaml: false,
  curationEnabled: false,
};

function loadFormDraft(): Partial<LoraFormDraft> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(FORM_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Partial<LoraFormDraft>) : null;
  } catch {
    return null;
  }
}

// Two modes only. Caption handling is no longer a mode: on drop the browser
// AI-captions the images via the cloud vision API (/api/studio/lora/caption);
// an image+.txt / .txt-bearing ZIP instead uses the user's captions verbatim
// and skips the AI pass. The old standalone "セミオート" per-image caption
// form is folded into the optional curation screen (same editing, plus JP
// round-trip translation). The Modal worker's local VLM is a fallback only.
type Mode = "auto" | "pro";

const MODES: { id: Mode; label: string; desc: string }[] = [
  { id: "auto", label: "⚡ オート (Auto)", desc: "画像を入れるだけ。キャプションは自動検知（同名 .txt があれば優先）" },
  { id: "pro", label: "🔬 エキスパート (Pro)", desc: "Rank / LR / Steps スライダーや生 YAML を直接編集" },
];

const PRESET_GROUPS: LoraPresetGroup[] = ["video", "photo", "anime"];

const OPTIMIZERS = ["adamw8bit", "adamw", "prodigy", "adafactor", "lion8bit"];
const LORA_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Safe, discrete hyperparameter choices — no free-form number entry (a
// stray keystroke on Rank/LR used to silently wreck a paid run).
const RANK_OPTIONS = [8, 16, 32, 64, 128] as const;
const ALPHA_OPTIONS = [8, 16, 32, 64, 128] as const;
const STEPS_MIN = 200;
const STEPS_MAX = LORA_MAX_STEPS;
const STEPS_STEP = 50;
const STEPS_QUICK: { value: number; label: string }[] = [
  { value: 500, label: "500 (軽量テスト)" },
  { value: 1000, label: "1000 (標準)" },
  { value: 2000, label: "2000 (高密度/受託推奨)" },
];
const LR_PRESETS: { value: number; label: string }[] = [
  { value: 0.0001, label: "0.0001 (1e-4) ・ 推奨/標準" },
  { value: 0.0002, label: "0.0002 (2e-4) ・ 強め" },
  { value: 0.00005, label: "0.00005 (5e-5) ・ 微調整" },
];

// Auto-caption prompt is now built from the selected LoRA type (人物 / 画風 /
// 物質 / 風景) plus the user's Japanese notes on which features to lock in vs.
// let vary — see src/lib/loraCaptionSpec.ts. On "次へ" the browser calls
// /api/studio/lora/caption-prompt (Gemini) to synthesise the English
// instruction handed to the worker's Qwen captioner as `caption_prompt`.

type DatasetImage = { id: string; file: File; url: string };

type ProConfig = {
  rank: number;
  alpha: number;
  // Alpha tracks Rank 1:1 until the user picks an Alpha value by hand.
  alphaLinked: boolean;
  learningRate: number;
  // true once the user switches the LR dropdown to "カスタム".
  lrCustom: boolean;
  steps: number;
  optimizer: string;
  useRawYaml: boolean;
  rawYaml: string;
};

const DEFAULT_PRO: ProConfig = {
  rank: 32,
  alpha: 32,
  alphaLinked: true,
  learningRate: 1e-4,
  lrCustom: false,
  steps: 2000,
  optimizer: "adamw8bit",
  useRawYaml: false,
  rawYaml: "",
};

type Phase = "form" | "curation" | "starting" | "tracking";

const fieldCls =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50";

// ---------------------------------------------------------------------------

function ImageDropzone({
  images,
  onAdd,
  onRemove,
  disabled,
}: {
  images: DatasetImage[];
  onAdd: (files: FileList | File[]) => void;
  onRemove: (id: string) => void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const totalBytes = images.reduce((s, i) => s + i.file.size, 0);

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!disabled && e.dataTransfer.files.length) onAdd(e.dataTransfer.files);
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragOver ? "border-neon-pink/60 bg-neon-pink/5" : "border-border bg-background/60 hover:border-neon-violet/40"
        } ${disabled ? "pointer-events-none opacity-50" : ""}`}
      >
        <ImagePlus size={26} className="text-neon-violet" />
        <p className="text-sm font-medium text-foreground">画像 / ZIP をドラッグ＆ドロップ / クリックで選択</p>
        <p className="text-[11px] text-muted">
          PNG・JPG・WEBP、複数可（推奨 15〜40 枚）。画像＋同名 .txt（ZIP でも、まとめて選択・D&D でも可）を入れると自前キャプション扱いになります。
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,.zip,application/zip,application/x-zip-compressed,text/plain,.txt"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) onAdd(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {images.length > 0 && (
        <>
          <div className="mt-3 flex items-center justify-between text-[11px] text-muted">
            <span>
              {images.length} 枚 ・ 合計 {(totalBytes / 1024 / 1024).toFixed(1)} MB
            </span>
            {!disabled && (
              <button
                type="button"
                onClick={() => images.forEach((i) => onRemove(i.id))}
                className="text-muted transition-colors hover:text-red-400"
              >
                すべて削除
              </button>
            )}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {images.map((img) => (
              <div
                key={img.id}
                className="group relative flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-border bg-neutral-900"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={img.file.name}
                  className="h-full w-full object-contain"
                />
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => onRemove(img.id)}
                    className="absolute right-1 top-1 rounded-md bg-black/70 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="削除"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

// Shown to non-admins in place of the raw-YAML editor. The editor itself is a
// support / bespoke-contract feature — an unchecked YAML paste is the fastest
// way for a normal user to burn credits on a crashing run — so it's gated to
// admins and everyone else gets this consultation prompt. (No physical GPU
// model / vendor names here — CLAUDE.md §2.)
function YamlVipLockCard() {
  return (
    <div className="rounded-lg border border-neon-violet/40 bg-neon-violet/[0.07] p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-bold text-neon-violet">
        <Lock size={13} className="shrink-0" />
        🔒 VIP / 特注受託専用機能（生YAMLフルカスタム）
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        最上位クラスの専用GPUを用いた特注アーキテクチャ指定、Rank 64
        超の極限LoRA、および業務受託モデルの構築は個別相談にて承っております。
      </p>
      <a
        href="#contact"
        className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-1.5 text-[11px] font-semibold text-white transition-all hover:opacity-90"
      >
        <MessageCircle size={13} />
        💬 特注LoRA・カスタム学習のご相談
      </a>

      {/* Smoke-glass preview of the locked editor. pointer-events-none +
          select-none so it's purely decorative. */}
      <div className="relative mt-2.5 overflow-hidden rounded-md border border-border">
        <pre className="pointer-events-none select-none whitespace-pre-wrap p-2.5 font-mono text-[10px] leading-relaxed text-muted/40 blur-[1.5px]">
          {`job: extension
config:
  name: bespoke_lora
  process:
    - type: sd_trainer
      network:
        type: lora
        linear: 128
      train:
        batch_size: 4
        steps: 4000`}
        </pre>
        <div className="absolute inset-0 flex items-center justify-center bg-background/30 backdrop-blur-[2px]">
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background/85 px-2.5 py-1 text-[10px] font-medium text-muted">
            <Lock size={11} />
            ロック中
          </span>
        </div>
      </div>
    </div>
  );
}

// Spoiler-free live load indicator — deliberately no total, no %, no GPU
// model. Just how much weight is currently resident.
function VramBadge({ gb }: { gb: number | null | undefined }) {
  if (gb == null) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-neon-violet/40 bg-neon-violet/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-neon-violet">
      <Activity size={11} />
      Active VRAM: {gb} GB
    </span>
  );
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Rough "残り時間" for the training progress panel.
function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
  return `${Math.floor(s / 3600)}時間${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}分`;
}

// Shown inside the failed / cancelled error panels. Scans the Volume for
// whatever the run left behind (intermediate weights that survived the
// SIGKILL + the persisted captions) and offers them for download through
// the same signed-URL path a completed job uses.
function SalvageSection({
  jobId,
  label = "💾 救出された中間データ・キャプションをダウンロード (Salvage)",
}: {
  jobId: string;
  label?: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<LoraSalvageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyFile, setBusyFile] = useState<string | null>(null);

  const runSalvage = async () => {
    setState("loading");
    setError(null);
    try {
      setResult(await salvageLoraJob(jobId));
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "救出に失敗しました。");
      setState("error");
    }
  };

  const withBusy = async (filename: string, fn: () => Promise<void>) => {
    setBusyFile(filename);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "処理に失敗しました。");
    } finally {
      setBusyFile(null);
    }
  };

  const ckpts = result?.checkpoints ?? [];
  const weights = ckpts
    .filter((c) => !c.isCaptionArchive && !c.isBundle)
    .sort((a, b) => a.step - b.step);
  const captionArchive = ckpts.find((c) => c.isCaptionArchive) ?? null;
  const bundleArchive = ckpts.find((c) => c.isBundle) ?? null;
  const ordered = [...weights, ...(captionArchive ? [captionArchive] : [])];

  return (
    <div className="mt-3 border-t border-border/40 pt-3">
      {state !== "done" && (
        <>
          <button
            type="button"
            onClick={runSalvage}
            disabled={state === "loading"}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state === "loading" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
            {label}
          </button>
          {state === "loading" && (
            <p className="mt-1.5 text-[10px] text-muted">
              クラウドストレージを走査しています… 最大1分ほどかかります。
            </p>
          )}
          {state === "error" && error && (
            <p className="mt-1.5 text-[10px] text-red-400">{error}</p>
          )}
        </>
      )}

      {state === "done" &&
        (ordered.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-muted">
            復旧できる中間データは見つかりませんでした（学習が初期段階で停止した可能性があります）。
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-[11px] font-medium text-foreground">
              {[
                weights.length > 0 ? `中間チェックポイント ${weights.length} 件` : "",
                captionArchive
                  ? `データセット（画像 ${result?.imageFiles ?? 0} 枚 ＋ キャプション ${result?.captionFiles ?? 0} 件）`
                  : "",
              ]
                .filter(Boolean)
                .join(" ＋ ")}
              を復旧しました
            </p>
            {bundleArchive && (
              <button
                type="button"
                onClick={() =>
                  withBusy(bundleArchive.filename, () =>
                    downloadLoraCheckpoint(jobId, bundleArchive.filename),
                  )
                }
                disabled={busyFile !== null}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-4 py-2 text-xs font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busyFile === bundleArchive.filename ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Download size={13} />
                )}
                📦 全チェックポイント一括DL (ZIP) ・ {formatMb(bundleArchive.sizeBytes)}
              </button>
            )}
            <div className="flex flex-col gap-1.5">
              {ordered.map((c) => (
                <div
                  key={c.filename}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background/40 px-3 py-1.5 text-xs"
                >
                  <span className="flex items-center gap-2 font-mono text-[11px] text-muted">
                    <span className="text-foreground">
                      {c.isCaptionArchive
                        ? "データセット (画像＋キャプション ZIP)"
                        : c.step > 0
                          ? `Step ${c.step}`
                          : "チェックポイント"}
                    </span>
                    <span className="opacity-60">{formatMb(c.sizeBytes)}</span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        withBusy(c.filename, () => downloadLoraCheckpoint(jobId, c.filename))
                      }
                      disabled={busyFile !== null}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busyFile === c.filename ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Download size={11} />
                      )}
                      ⬇️ ダウンロード
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        withBusy(c.filename, async () => {
                          const url = await getLoraCheckpointDownloadUrl(jobId, c.filename);
                          await navigator.clipboard.writeText(url);
                        })
                      }
                      disabled={busyFile !== null}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busyFile === c.filename ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <ClipboardCopy size={11} />
                      )}
                      📋 URLコピー
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted opacity-70">
              直通リンクは約15分間有効です（Model Downloader 等での取り込み用）。
            </p>
            {error && <p className="text-[10px] text-red-400">{error}</p>}
          </div>
        ))}
    </div>
  );
}

// Collapsible "Live Terminal" — streams the worker's recent stdout/stderr
// (synced through generation_jobs.metadata.logs, ~40-line ring buffer). Purely
// presentational; auto-scrolls to the newest line while open.
function LiveTerminal({ logs }: { logs: string[] }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs, open]);
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-800 bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-emerald-400/90 transition-colors hover:text-emerald-300"
      >
        💻 リアルタイム稼働ログを{open ? "隠す" : "表示"} {open ? "▲" : "▼"}
      </button>
      {open && (
        <div
          ref={boxRef}
          className="mt-2 h-48 overflow-y-auto rounded-lg border border-neutral-800 bg-black/90 p-3 font-mono text-xs leading-relaxed text-emerald-400"
        >
          {logs.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProgressPanel({
  job,
  queuedElapsedSec,
  onUseLora,
}: {
  job: LoraJobStatus | null;
  // seconds since this job entered 'queued' — drives the cold-start
  // provisioning copy below (0-15s / 15s+), and stays 0 once the job
  // leaves 'queued'.
  queuedElapsedSec?: number;
  onUseLora?: (loraFilename: string) => void;
}) {
  const [downloadingCkpt, setDownloadingCkpt] = useState<string | null>(null);
  const [copyingCkpt, setCopyingCkpt] = useState<string | null>(null);
  const [ckptError, setCkptError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const pushToast = (message: string) =>
    setToasts((prev) => [...prev, { id: Date.now() + Math.random(), message }]);
  const dismissToast = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  if (!job) return null;

  const handleCkptDownload = async (filename: string) => {
    setDownloadingCkpt(filename);
    setCkptError(null);
    try {
      await downloadLoraCheckpoint(job.jobId, filename);
    } catch (err) {
      setCkptError(err instanceof Error ? err.message : "ダウンロードに失敗しました。");
    } finally {
      setDownloadingCkpt(null);
    }
  };

  const handleCkptCopyUrl = async (filename: string) => {
    setCopyingCkpt(filename);
    setCkptError(null);
    try {
      const url = await getLoraCheckpointDownloadUrl(job.jobId, filename);
      await navigator.clipboard.writeText(url);
      pushToast("Model Downloader用 URLをコピーしました");
    } catch (err) {
      setCkptError(err instanceof Error ? err.message : "URLのコピーに失敗しました。");
    } finally {
      setCopyingCkpt(null);
    }
  };

  if (job.status === "failed_timeout") {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-amber-400">
          <AlertTriangle size={15} />
          自動返金しました
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-300/90">
          クラウド混雑のため自動返金しました。時間をおいて再試行してください。
        </p>
      </div>
    );
  }

  if (job.status === "cancelled") {
    return (
      <div className="rounded-xl border border-border bg-background/60 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-muted">
          <AlertTriangle size={15} />
          この学習ジョブは中止されました
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          {job.errorMessage || "消費したクレジットは返金されています。"}
        </p>
        <SalvageSection jobId={job.jobId} />
      </div>
    );
  }

  if (job.status === "queued") {
    const provisioningMessage =
      (queuedElapsedSec ?? 0) < 15
        ? "専用ハイエンドGPUノードをプロビジョニング中…"
        : "コンテナ初期化 & モデル環境ロード中…";
    return (
      <div className="flex flex-col items-center gap-1">
        <QueueStatusPanel phase="queued" queue={job.queue} />
        <span className="text-[11px] text-neon-violet/80">{provisioningMessage}</span>
        <span className="font-mono text-[10px] text-muted">status: {job.status}</span>
      </div>
    );
  }

  if (job.status === "processing") {
    const pct = job.progressPercent ?? null;
    // Prep-phase sends current_step: 0 — that is NOT a training step, so the
    // "Step X / Y" telemetry only shows once real steps start (> 0).
    const hasSteps =
      job.currentStep != null &&
      job.currentStep > 0 &&
      job.totalSteps != null &&
      job.totalSteps > 0;
    // Phase heading follows the worker's own emoji-tagged message (🎯 prep /
    // 🔥 training); falls back to a generic label.
    const msg = job.progressMessage ?? "";
    const heading = msg.startsWith("🎯")
      ? "多層Latentキャッシュ生成"
      : msg.startsWith("🔥") || hasSteps
        ? "深度最適化学習中…"
        : "準備処理中…";

    // Live training telemetry line — Step X / Y ・ 残り約 … ・ Loss …
    const telemetry = hasSteps ? (
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted">
        <span className="text-foreground">
          Step {job.currentStep!.toLocaleString()} / {job.totalSteps!.toLocaleString()}
        </span>
        {job.etaSeconds != null && <span>残り 約 {formatEta(job.etaSeconds)}</span>}
        {job.loss != null && <span>Loss: {job.loss.toFixed(4)}</span>}
      </div>
    ) : null;

    if (pct == null) {
      return (
        <div className="flex flex-col items-center gap-1">
          <QueueStatusPanel phase="processing" queue={job.queue} />
          <VramBadge gb={job.vramUsedGb} />
          {telemetry ?? (
            <span className="font-mono text-[10px] text-muted">
              status: processing{job.progressMessage ? ` ・ ${job.progressMessage}` : ""}
            </span>
          )}
          {job.logs && job.logs.length > 0 && <LiveTerminal logs={job.logs} />}
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-neon-violet/30 bg-neon-violet/5 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-neon-violet">
            <Loader2 size={15} className="animate-spin" />
            {heading} {pct}%
          </div>
          <VramBadge gb={job.vramUsedGb} />
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-background/70">
          <div
            className="h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-violet transition-[width] duration-700"
            style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
          />
        </div>
        {telemetry}
        {/* Latest one-liner — always visible directly under the bar. */}
        {job.progressMessage && (
          <p className="mt-2 text-[11px] leading-relaxed text-muted">{job.progressMessage}</p>
        )}
        {job.logs && job.logs.length > 0 && <LiveTerminal logs={job.logs} />}
      </div>
    );
  }

  if (job.status === "completed") {
    const filename = job.resultPath ? job.resultPath.split("/").pop() ?? "" : "";
    const allCheckpoints = job.checkpoints ?? [];
    const captionArchive = allCheckpoints.find((c) => c.isCaptionArchive) ?? null;
    const bundleArchive = allCheckpoints.find((c) => c.isBundle) ?? null;
    const checkpoints = allCheckpoints
      .filter((c) => !c.isCaptionArchive && !c.isBundle)
      .sort((a, b) => a.step - b.step);
    return (
      <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-green-400">
          <Check size={16} />
          LoRA 学習が完了しました
        </div>
        <p className="mt-1.5 break-all font-mono text-[11px] text-muted">
          {filename || "(生成済みモデルライブラリに保存されました)"}
        </p>
        <p className="mt-1 text-[11px] text-muted">
          この LoRA はモデルライブラリに保存され、動画生成ワークフローからすぐに利用できます。
        </p>

        {bundleArchive && (
          <button
            type="button"
            onClick={() => handleCkptDownload(bundleArchive.filename)}
            disabled={downloadingCkpt !== null || copyingCkpt !== null}
            title="中間チェックポイントを含む全 .safetensors を1つの ZIP にまとめたものです。"
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-4 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {downloadingCkpt === bundleArchive.filename ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Download size={15} />
            )}
            📦 全チェックポイント一括DL (ZIP) ・ {formatMb(bundleArchive.sizeBytes)}
          </button>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => filename && navigator.clipboard?.writeText(filename)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
          >
            <Sparkles size={13} />
            ファイル名をコピー
          </button>
          {onUseLora && filename && (
            <button
              type="button"
              onClick={() => onUseLora(filename)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-1.5 text-xs font-semibold text-white transition-all hover:opacity-90"
            >
              <Clapperboard size={13} />
              🎬 動画生成でこの LoRA を使う
            </button>
          )}
          {captionArchive && (
            <button
              type="button"
              onClick={() => handleCkptDownload(captionArchive.filename)}
              disabled={downloadingCkpt !== null || copyingCkpt !== null}
              title="学習に使用した画像とキャプション(.txt)を1つのZIPにまとめたものです。そのまま再学習に使えます。"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {downloadingCkpt === captionArchive.filename ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Download size={13} />
              )}
              📦 キャプション付きデータセットDL (ZIP)
            </button>
          )}
        </div>
        {ckptError && !checkpoints.length && (
          <p className="mt-1.5 text-[10px] text-red-400">{ckptError}</p>
        )}

        {checkpoints.length > 0 && (
          <div className="mt-4 border-t border-green-500/20 pt-3">
            <p className="mb-1.5 text-[11px] font-medium text-foreground">
              中間チェックポイント（過学習を避けて最適なステップを選択）
            </p>
            <div className="flex flex-col gap-1.5">
              {checkpoints.map((c) => (
                <div
                  key={c.filename}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-xs ${
                    c.isFinal ? "border-neon-pink/40 bg-neon-pink/5" : "border-border bg-background/40"
                  }`}
                >
                  <span className="flex items-center gap-2 font-mono text-[11px] text-muted">
                    <span className={c.isFinal ? "font-semibold text-neon-pink" : "text-foreground"}>
                      {c.isFinal ? "最終版" : `Step ${c.step}`}
                    </span>
                    <span className="opacity-60">{formatMb(c.sizeBytes)}</span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleCkptDownload(c.filename)}
                      disabled={downloadingCkpt !== null || copyingCkpt !== null}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {downloadingCkpt === c.filename ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Download size={11} />
                      )}
                      ⬇️ ダウンロード
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCkptCopyUrl(c.filename)}
                      disabled={downloadingCkpt !== null || copyingCkpt !== null}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {copyingCkpt === c.filename ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <ClipboardCopy size={11} />
                      )}
                      📋 URLコピー
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] text-muted opacity-70">
              「URLコピー」の直通リンクは約15分間有効です（Model Downloader 等での取り込み用）。
            </p>
            {ckptError && <p className="mt-1.5 text-[10px] text-red-400">{ckptError}</p>}
          </div>
        )}

        {/* On-demand: bundle every .safetensors in this job's folder into one
            ZIP (built on a CPU container, 0 GPU cost) + the captioned dataset. */}
        <SalvageSection jobId={job.jobId} label="📦 全チェックポイント＋データセットを一括DL" />

        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  // failed — refund state comes straight from the worker (infra failures and
  // GUI-mode faults refund; a raw-YAML config error or an over-scoped run
  // that was safety-stopped does not).
  const partialCkpts = (job.checkpoints ?? [])
    .filter((c) => !c.isCaptionArchive && !c.isBundle)
    .sort((a, b) => a.step - b.step);
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-red-400">
        <AlertTriangle size={15} />
        学習に失敗しました
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-red-400/90">
        {job.errorMessage || "不明なエラーが発生しました。"}
        <br />
        {job.safetyStop
          ? "設定負荷に対してクレジットが不足したため、原価割れを避けて安全停止し、全額返金されました。解像度・ステップ数・バッチを下げるか、投入クレジットを増やしてください。中断時点までの中間チェックポイントはダウンロードできます。"
          : job.refunded === true
            ? "消費したクレジットは全額返金されました。"
            : job.refunded === false
              ? "生YAML（カスタム設定）モードのため、消費したクレジットは返金されません。"
              : "返金状況を確認中です。"}
      </p>

      {partialCkpts.length > 0 && (
        <div className="mt-3 border-t border-red-500/20 pt-3">
          <p className="mb-1.5 text-[11px] font-medium text-foreground">
            中断時点までの中間チェックポイント（ダウンロード可）
          </p>
          <div className="flex flex-col gap-1.5">
            {partialCkpts.map((c) => (
              <div
                key={c.filename}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background/40 px-3 py-1.5 text-xs"
              >
                <span className="flex items-center gap-2 font-mono text-[11px] text-muted">
                  <span className="text-foreground">{c.step > 0 ? `Step ${c.step}` : "checkpoint"}</span>
                  <span className="opacity-60">{formatMb(c.sizeBytes)}</span>
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleCkptDownload(c.filename)}
                    disabled={downloadingCkpt !== null || copyingCkpt !== null}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {downloadingCkpt === c.filename ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Download size={11} />
                    )}
                    ⬇️ ダウンロード
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCkptCopyUrl(c.filename)}
                    disabled={downloadingCkpt !== null || copyingCkpt !== null}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {copyingCkpt === c.filename ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <ClipboardCopy size={11} />
                    )}
                    📋 URLコピー
                  </button>
                </div>
              </div>
            ))}
          </div>
          {ckptError && <p className="mt-1.5 text-[10px] text-red-400">{ckptError}</p>}
        </div>
      )}

      <SalvageSection jobId={job.jobId} />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

// ---------------------------------------------------------------------------

export function LoraStudioTab({ onUseLora }: { onUseLora?: (loraFilename: string) => void }) {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  // Gates the raw-YAML editor (a bespoke-contract / support feature). Non-
  // admins get the consultation card and can never reach yamlMode, so the
  // train payload from a normal account can't carry custom_yaml_override.
  const { isAdmin, loading: adminLoading } = useIsAdmin(user);

  const [mode, setMode] = useState<Mode>("auto");
  const [images, setImages] = useState<DatasetImage[]>([]);
  // English caption per image id. Filled by the AI-vision auto-caption pass on
  // drop, or straight from a .txt / ZIP the user brought.
  const [captions, setCaptions] = useState<Record<string, string>>({});
  // Japanese working copy per image id (for the curation UI's review pane).
  const [captionsJa, setCaptionsJa] = useState<Record<string, string>>({});
  // AI-vision auto-caption progress for the current pass.
  const [autoCap, setAutoCap] = useState<{
    running: boolean;
    done: number;
    total: number;
    error: string | null;
    // Transient hint shown while a batch is backing off a rate limit.
    note: string | null;
    everRan: boolean;
  }>({ running: false, done: 0, total: 0, error: null, note: null, everRan: false });
  // Image ids we've already sent to the vision captioner (so a re-render / new
  // drop doesn't re-caption them). Cleared per-id on remove / on "再解析".
  const captionAttemptedRef = useRef<Set<string>>(new Set());
  // Image ids whose caption came from a user .txt / ZIP (NOT the AI) — a
  // blank one of these is intentional, so the worker must not VLM-fill it.
  // State (not a ref) because the routing badge derives from it in render.
  const [userCaptionIds, setUserCaptionIds] = useState<Set<string>>(() => new Set());
  const autoCaptionAbortRef = useRef<AbortController | null>(null);
  // Live set of image ids — read by the async caption pass (which captured a
  // now-stale `targets` list) to drop results for images removed mid-pass.
  // Kept in sync with `images` right after commit; the pass only reads it
  // when a network round trip resolves, long after any effect has run.
  const imageIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    imageIdsRef.current = new Set(images.map((i) => i.id));
  }, [images]);
  // The caption_prompt the AI captions were last generated with — so
  // handleStart only re-captions when the synthesised instruction changed.
  const recaptionPromptRef = useRef<string>("");
  // "__custom__" is the last option in the single model dropdown; anything
  // else is a preset id.
  const [modelChoice, setModelChoice] = useState<string>("minimax_h3");
  const [customModelId, setCustomModelId] = useState("");
  const [baseArchitecture, setBaseArchitecture] = useState<LoraBaseArchitecture>("sdxl");
  const [resolution, setResolution] = useState<LoraResolution>(DEFAULT_LORA_RESOLUTION);
  const [triggerWord, setTriggerWord] = useState("");
  const [loraName, setLoraName] = useState("");
  const [pro, setPro] = useState<ProConfig>(DEFAULT_PRO);
  // LoRA-type-aware auto-caption spec: the training TYPE + the user's JP notes
  // on which features to lock into the trigger (blacklisted from captions) vs.
  // let vary (described). Gemini turns this into the English Qwen instruction.
  const [captionCategory, setCaptionCategory] = useState<LoraCaptionCategory>("person");
  const [captionFixed, setCaptionFixed] = useState("");
  const [captionVarying, setCaptionVarying] = useState("");
  // User-edited final English instruction — empty = use whatever Gemini builds
  // on "次へ". Non-empty overrides generation.
  const [captionPromptOverride, setCaptionPromptOverride] = useState("");
  const [captionPromptOpen, setCaptionPromptOpen] = useState(false);
  // Last synthesised English instruction + how it was produced, for display.
  const [captionGen, setCaptionGen] = useState<{
    state: "idle" | "generating" | "done" | "error";
    prompt: string;
    fromGemini: boolean;
    error: string | null;
  }>({ state: "idle", prompt: "", fromGemini: false, error: null });
  // The instruction actually sent with the current run — set in handleStart so
  // both the direct and post-curation training paths pick it up.
  const resolvedCaptionPromptRef = useRef<string>("");
  // Previous trigger word — so a change can be swapped into existing captions
  // client-side (no re-analysis). Seeded lazily on the first change.
  const prevTriggerRef = useRef<string | null>(null);
  // Mirror of `hasUserCaptions` (defined later) for use in callbacks declared
  // before it.
  const hasUserCaptionsRef = useRef(false);
  // Identity of the caption spec the current captions reflect. handleStart
  // only re-analyses when the live spec differs from this (a bare trigger-word
  // edit is swapped in client-side and updates this without a re-run). Mirrored
  // to state so the "反映済み / 変更あり" badge can react.
  const lastCaptionSpecKeyRef = useRef<string>("");
  const [reflectedSpecKey, setReflectedSpecKey] = useState<string>("");
  const markCaptionsReflect = useCallback((key: string) => {
    lastCaptionSpecKeyRef.current = key;
    setReflectedSpecKey(key);
  }, []);

  const [phase, setPhase] = useState<Phase>("form");
  // Locked the instant "学習を開始" is pressed — before phase flips to
  // "starting" there's an async window (caption passes, prompt synthesis) in
  // which the button must be inert and no form re-render can slip a stale
  // "クレジット不足" card back onto the screen.
  const [submitting, setSubmitting] = useState(false);
  const [datasetZipBusy, setDatasetZipBusy] = useState(false);
  // Opt-in visual dataset curation: after upload, review/cull images and
  // review/edit captions (with JP round-trip translation) before training.
  const [curationEnabled, setCurationEnabled] = useState(false);
  const [curationPairs, setCurationPairs] = useState<CurationPair[]>([]);
  const [zipBusy, setZipBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [job, setJob] = useState<LoraJobStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  // Seconds since the current job entered 'queued' — drives the cold-start
  // provisioning copy in ProgressPanel. Only ever written from the interval
  // callback below (never synchronously in the effect body).
  const [queuedElapsedSec, setQueuedElapsedSec] = useState(0);

  const pollCancelledRef = useRef(false);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The job id currently being polled and when it entered 'queued'.
  const activeJobIdRef = useRef<string>("");
  const queuedSinceRef = useRef<number>(0);
  // Caches a successful dataset upload against a fingerprint of the exact
  // image set. Re-running with the same images (only params / YAML changed)
  // reuses these Storage paths and skips the whole upload — 0s, no re-cost.
  const uploadedDatasetRef = useRef<{ signature: string; paths: string[] } | null>(null);
  useEffect(
    () => () => {
      pollCancelledRef.current = true;
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
      autoCaptionAbortRef.current?.abort();
      images.forEach((i) => URL.revokeObjectURL(i.url));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Ticks the queued-provisioning copy once a second while a job sits in
  // 'queued'. ProgressPanel only reads queuedElapsedSec in its 'queued'
  // branch, so a stale value after the job moves on is never shown.
  useEffect(() => {
    if (job?.status !== "queued") return;
    const iv = setInterval(() => {
      setQueuedElapsedSec(
        queuedSinceRef.current > 0 ? Math.floor((Date.now() - queuedSinceRef.current) / 1000) : 0,
      );
    }, 1000);
    return () => clearInterval(iv);
  }, [job?.status]);

  // Mirrors `images` for synchronous MAX_IMAGES accounting inside the add
  // helpers (which can't read the just-set state).
  const imagesRef = useRef<DatasetImage[]>([]);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  // --- form-draft auto-persist -------------------------------------------
  // Hydrated from localStorage once on mount (not via useState initialisers —
  // that would desync SSR/CSR and warn on hydration). Applied in a microtask
  // so it's out of the effect's synchronous body (matches the active-job
  // restore effect below). The save effect is gated on draftHydratedRef so it
  // never writes the defaults over a saved draft before this runs.
  const draftHydratedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const d = loadFormDraft();
      if (d) {
        if (typeof d.triggerWord === "string") setTriggerWord(d.triggerWord);
        if (typeof d.loraName === "string") setLoraName(d.loraName);
        if (d.captionCategory && (LORA_CAPTION_CATEGORIES as readonly string[]).includes(d.captionCategory)) {
          setCaptionCategory(d.captionCategory);
        }
        if (typeof d.captionFixed === "string") setCaptionFixed(d.captionFixed);
        if (typeof d.captionVarying === "string") setCaptionVarying(d.captionVarying);
        if (typeof d.captionPromptOverride === "string") setCaptionPromptOverride(d.captionPromptOverride);
        if (typeof d.rawYaml === "string" || typeof d.useRawYaml === "boolean") {
          setPro((p) => ({
            ...p,
            rawYaml: typeof d.rawYaml === "string" ? d.rawYaml : p.rawYaml,
            useRawYaml: typeof d.useRawYaml === "boolean" ? d.useRawYaml : p.useRawYaml,
          }));
        }
        if (typeof d.curationEnabled === "boolean") setCurationEnabled(d.curationEnabled);
      }
      draftHydratedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !draftHydratedRef.current) return;
    const draft: LoraFormDraft = {
      triggerWord,
      loraName,
      captionCategory,
      captionFixed,
      captionVarying,
      captionPromptOverride,
      rawYaml: pro.rawYaml,
      useRawYaml: pro.useRawYaml,
      curationEnabled,
    };
    try {
      const serialized = JSON.stringify(draft);
      // Pristine form -> no key at all (so "フォームを初期化" genuinely clears
      // it, and a first-time visitor never gets a stale entry).
      if (serialized === JSON.stringify(DEFAULT_FORM_DRAFT)) {
        window.localStorage.removeItem(FORM_DRAFT_STORAGE_KEY);
      } else {
        window.localStorage.setItem(FORM_DRAFT_STORAGE_KEY, serialized);
      }
    } catch {
      /* private mode / quota — persistence is best-effort */
    }
  }, [
    triggerWord,
    loraName,
    captionCategory,
    captionFixed,
    captionVarying,
    captionPromptOverride,
    pro.rawYaml,
    pro.useRawYaml,
    curationEnabled,
  ]);

  const addDatasetFiles = useCallback((entries: { file: File; caption?: string }[]) => {
    // Deterministic, filename-derived id (no random UUID) so it's a stable
    // React key across every re-render / curation round-trip; a numeric
    // suffix disambiguates genuinely identical files.
    const used = new Set(imagesRef.current.map((i) => i.id));
    let room = MAX_IMAGES - imagesRef.current.length;
    const newImgs: DatasetImage[] = [];
    const newCaps: Record<string, string> = {};
    const newUserCaptionIds: string[] = [];
    for (const { file, caption } of entries) {
      if (room <= 0) break;
      room--;
      const base = `${file.name}::${file.size}::${file.lastModified}`;
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}::${n}`;
      used.add(id);
      newImgs.push({ id, file, url: URL.createObjectURL(file) });
      if ((caption ?? "").trim()) {
        newCaps[id] = caption!.trim();
        // Brought by the user (.txt / ZIP) — not AI-generated.
        newUserCaptionIds.push(id);
        captionAttemptedRef.current.add(id);
      }
    }
    if (newImgs.length) setImages((prev) => [...prev, ...newImgs]);
    if (Object.keys(newCaps).length) setCaptions((prev) => ({ ...prev, ...newCaps }));
    if (newUserCaptionIds.length) {
      setUserCaptionIds((prev) => {
        const next = new Set(prev);
        newUserCaptionIds.forEach((id) => next.add(id));
        return next;
      });
    }
  }, []);

  const importZip = useCallback(
    async (zip: File) => {
      setZipBusy(true);
      setErrorMessage(null);
      try {
        const entries = await parseDatasetZip(zip, { maxImages: MAX_IMAGES });
        if (!entries.length) {
          setErrorMessage(`ZIP に画像が見つかりませんでした（${zip.name}）。`);
          return;
        }
        addDatasetFiles(entries.map((e) => ({ file: e.file, caption: e.caption })));
        // Captions carried by the ZIP land in `captions` — the dropzone badge
        // and runTraining pick them up automatically (Qwen is then skipped);
        // no mode switch needed.
      } catch (err) {
        setErrorMessage(
          `ZIP の展開に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setZipBusy(false);
      }
    },
    [addDatasetFiles],
  );

  const addImages = useCallback(
    (incoming: FileList | File[]) => {
      const arr = Array.from(incoming);
      const imgs = arr.filter((f) => /^image\/(png|jpe?g|webp)$/.test(f.type));
      const zips = arr.filter((f) => isZipFile(f));
      // Loose <name>.txt dropped alongside <name>.<img> — pair them by base
      // name so a plain "images + .txt" drop routes the same as a ZIP.
      const txts = arr.filter((f) => /\.txt$/i.test(f.name) && !isZipFile(f));
      const stem = (n: string) => n.replace(/\.[^.]+$/, "");

      if (imgs.length) {
        if (txts.length) {
          void (async () => {
            const byStem = new Map<string, string>();
            await Promise.all(
              txts.map(async (t) => {
                try {
                  byStem.set(stem(t.name), (await t.text()).trim());
                } catch {
                  /* unreadable .txt — image just gets auto-captioned */
                }
              }),
            );
            addDatasetFiles(imgs.map((file) => ({ file, caption: byStem.get(stem(file.name)) })));
          })();
        } else {
          addDatasetFiles(imgs.map((file) => ({ file })));
        }
      }
      zips.forEach((z) => void importZip(z));
    },
    [addDatasetFiles, importZip],
  );

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((i) => i.id !== id);
    });
    setCaptions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setCaptionsJa((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    captionAttemptedRef.current.delete(id);
    setUserCaptionIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const totalBytes = useMemo(() => images.reduce((s, i) => s + i.file.size, 0), [images]);

  const nameValid = LORA_NAME_RE.test(loraName.trim());
  // Admin-only: a non-admin toggling pro.useRawYaml (persisted draft, React
  // devtools, …) still resolves to yamlMode === false, so every downstream
  // consumer — canSubmit, trainingConfig, price, effective name/trigger —
  // takes the GUI-slider path and custom_yaml_override is never sent.
  const yamlMode = mode === "pro" && pro.useRawYaml && isAdmin;
  // Live YAML syntax check for the raw-YAML editor — drives the badge below
  // the textarea and gates the submit button. Only meaningful in yamlMode.
  const yamlCheck = useMemo(
    () => (yamlMode ? validateLoraYaml(pro.rawYaml) : null),
    [yamlMode, pro.rawYaml],
  );
  // In raw-YAML mode the YAML's config.name / process[0].trigger_word are
  // authoritative — the form's LoRA-name / trigger fields are disabled and
  // just mirror these values.
  const yamlIdentity = useMemo(
    () => (yamlMode && yamlCheck?.ok ? loraYamlIdentity(yamlCheck.data) : null),
    [yamlMode, yamlCheck],
  );
  const effectiveLoraName = yamlMode ? (yamlIdentity?.name ?? "") : loraName.trim();
  const effectiveTrigger = yamlMode ? (yamlIdentity?.triggerWord ?? "") : triggerWord.trim();
  const yamlNameValid = !yamlMode || LORA_NAME_RE.test(effectiveLoraName);
  // Mirrors the worker's _derive_trigger: explicit trigger, else the first
  // alnum run of the LoRA name. Used to protect the token during translation.
  const curationTrigger = effectiveTrigger || (effectiveLoraName.match(/[A-Za-z0-9]+/)?.[0] ?? "");

  // Heavy-config warning: 1280px + 100+ images → the 3D-VAE latent-cache
  // phase alone can blow past the worker's early-safety-stop.
  const resolutionHas1280 = useMemo(() => {
    if (yamlMode && yamlCheck?.ok) {
      const p0 = (yamlCheck.data as { config?: { process?: Array<{ datasets?: Array<{ resolution?: unknown }> }> } })
        ?.config?.process?.[0];
      const rs = p0?.datasets?.[0]?.resolution;
      return Array.isArray(rs) && rs.some((r) => Number(r) >= 1280);
    }
    return Number(resolution) >= 1280;
  }, [yamlMode, yamlCheck, resolution]);
  const heavyConfigWarn = resolutionHas1280 && images.length > 100;

  const captionSpec: LoraCaptionSpec = useMemo(
    () => ({
      category: captionCategory,
      fixed: captionFixed.trim(),
      varying: captionVarying.trim(),
    }),
    [captionCategory, captionFixed, captionVarying],
  );
  const captionSpecFilled = captionSpecHasInput(captionSpec);
  const captionCategoryMeta = LORA_CAPTION_CATEGORY_META[captionCategory];

  // A stable identity for "what the captions currently reflect": trigger +
  // spec + any manual override. Re-analysis is only needed when this changes.
  const captionSpecKey = useMemo(
    () =>
      JSON.stringify([
        curationTrigger,
        captionPromptOverride.trim(),
        captionSpecFilled ? [captionSpec.category, captionSpec.fixed, captionSpec.varying] : null,
      ]),
    [curationTrigger, captionPromptOverride, captionSpecFilled, captionSpec],
  );
  const captionSpecKeyRef = useRef(captionSpecKey);
  useEffect(() => {
    captionSpecKeyRef.current = captionSpecKey;
  }, [captionSpecKey]);

  // The English instruction to hand the vision API *right now*, with zero
  // network round-trip: a manual override wins, else the deterministic
  // fallback built from the JP fixed/varying spec, else "" (worker default).
  const currentCaptionPrompt = useCallback((): string => {
    const manual = captionPromptOverride.trim();
    if (manual) return manual;
    if (hasUserCaptionsRef.current || !captionSpecFilled) return "";
    return (
      resolvedCaptionPromptRef.current.trim() ||
      buildCaptionFallbackPrompt(captionSpec, curationTrigger)
    );
  }, [captionPromptOverride, captionSpecFilled, captionSpec, curationTrigger]);

  // Escape a user string for use inside a RegExp.
  const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Swap the leading trigger token of one caption from `from` to `to`. Leaves
  // a caption that doesn't start with `from` untouched (so a user caption with
  // no trigger isn't force-prefixed) unless `force` (AI captions always get
  // the current trigger).
  const swapLeadingTrigger = useCallback(
    (text: string, from: string, to: string, force: boolean): string => {
      const t = text.trim();
      if (!t) return text;
      let body = t;
      let had = false;
      // Leading token must BE the trigger — not merely start with it
      // ("cat" must not match "catgirl, …").
      const leadRe = (tok: string) =>
        new RegExp(`^\\s*${reEscape(tok)}(?=$|[\\s,、])\\s*[,、]?\\s*`, "i");
      if (from) {
        const re = leadRe(from);
        if (re.test(body)) {
          body = body.replace(re, "").trim();
          had = true;
        }
      }
      // Already carries the new trigger (e.g. route set it) — normalise spacing.
      if (to) {
        const hasNew = leadRe(to);
        if (hasNew.test(body)) return body.replace(hasNew, `${to}, `).trim();
      }
      if (!to) return had ? body : text;
      if (had) return body ? `${to}, ${body}` : to;
      return force ? `${to}, ${body}` : text;
    },
    [],
  );
  // Alpha follows Rank unless the user explicitly unlinks it. Nullish (a
  // pre-existing `pro` object from before this flag existed, kept across a
  // dev Fast Refresh) counts as linked so the default is genuinely ON.
  const alphaLinked = pro.alphaLinked ?? true;
  // When linked, Alpha is always exactly Rank regardless of what's stored.
  const effectiveAlpha = alphaLinked ? pro.rank : pro.alpha;

  const isCustom = modelChoice === "__custom__";
  const customBlocked = isCustom && isBlockedLoraModel(customModelId);
  const customValid = isCustom && customModelId.trim().length >= 2 && !customBlocked;
  const modelValid = !isCustom || customValid;

  const targetModel = isCustom ? "custom" : modelChoice;
  const pricedArch = isCustom ? baseArchitecture : (loraPresetById(modelChoice)?.arch ?? "");

  // Multi-dimensional dynamic price, live (src/lib/loraPricing.ts):
  //   ceil(0.1 * modelMult * resMult * batchMult * rankMult * steps)
  //  - エキスパート(生YAML): price the live-parsed ai-toolkit config; an
  //    unparseable / step-less YAML shows the worst-case ceiling.
  //  - エキスパート(スライダー) / オート / セミオート: synthesise the
  //    equivalent config from the GUI knobs (batch is always 1 in GUI mode).
  const priceBreakdown = useMemo(() => {
    if (yamlMode) {
      if (yamlCheck?.ok) return loraPriceBreakdown(yamlCheck.data, { archFallback: pricedArch });
      return null; // worst-case shown below
    }
    return loraPriceBreakdown(
      guiLoraPricingConfig({
        arch: pricedArch,
        resolution,
        linearRank: mode === "pro" ? pro.rank : DEFAULT_PRO.rank,
        steps: mode === "pro" ? pro.steps : DEFAULT_LORA_STEPS,
      }),
    );
  }, [yamlMode, yamlCheck, pricedArch, resolution, mode, pro.rank, pro.steps]);
  const requiredCredits =
    priceBreakdown && priceBreakdown.credits > 0
      ? Math.min(LORA_CREDIT_WORST_CASE, priceBreakdown.credits)
      : LORA_CREDIT_WORST_CASE;
  const insufficientCredits = Boolean(user) && !creditsLoading && (credits ?? 0) < requiredCredits;

  // Model dropdown change — also snap the training resolution to the pick's
  // recommended value (FLUX/SDXL → 1024, SD1.5 → 512, else 768).
  const handleModelChange = (value: string) => {
    setModelChoice(value);
    if (value === "__custom__") {
      setResolution(recommendedResolution(baseArchitecture));
    } else {
      const preset = loraPresetById(value);
      if (preset) setResolution(recommendedResolution(preset.arch));
    }
  };

  const canSubmit =
    phase === "form" &&
    images.length >= 1 &&
    totalBytes <= MAX_TOTAL_BYTES &&
    (yamlMode ? yamlNameValid : nameValid) &&
    modelValid &&
    (yamlMode ? pro.rawYaml.trim().length > 20 && yamlCheck?.ok === true : true);

  // Re-fetches the authoritative credits balance from `profiles` and
  // broadcasts it — used right after a server-side refund (e.g. a normal
  // training failure) where the client never learns the refunded amount
  // from the poll response, so it can't just add it to the local balance
  // the way the pending-timeout failover does.
  const refreshCredits = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase.from("profiles").select("credits").eq("id", user.id).single();
    if (!error && typeof data?.credits === "number") {
      broadcastCreditsUpdate(user.id, data.credits);
    }
  }, [user]);

  const startPolling = useCallback(
    (jobId: string) => {
      pollCancelledRef.current = false;
      activeJobIdRef.current = jobId;
      queuedSinceRef.current = Date.now();
      console.log(`[lora] startPolling job=${jobId}`);

      const tick = async () => {
        if (pollCancelledRef.current) return;
        const pollingId = activeJobIdRef.current;
        const elapsed = Math.round((Date.now() - (queuedSinceRef.current || Date.now())) / 1000);
        let next: LoraJobStatus | null = null;
        try {
          next = await pollLoraJob(pollingId);
          console.log(`[lora] tick job=${pollingId} status=${next.status} elapsed=${elapsed}s retryCount=${next.retryCount}`);
          if (pollCancelledRef.current || pollingId !== activeJobIdRef.current) return;
          setJob(next);
        } catch (err) {
          console.error(`[lora] poll FAILED job=${pollingId} elapsed=${elapsed}s:`, err);
        }

        if (next) {
          if (
            next.status === "completed" ||
            next.status === "failed" ||
            next.status === "failed_timeout" ||
            next.status === "cancelled"
          ) {
            // A plain 'failed' (training errored) or 'cancelled' (aborted +
            // refunded internally) auto-refunds server-side, but this poll
            // response carries no refunded amount, so re-fetch the balance.
            if (next.status === "failed" || next.status === "cancelled") void refreshCredits();
            // 'failed' / 'cancelled' keep the key like 'completed' does — the
            // error panel carries the Salvage button, which must survive a
            // page reload. Only 'failed_timeout' (never left the queue, no
            // GPU, nothing on the Volume) is dropped.
            if (next.status === "failed_timeout" && typeof window !== "undefined") {
              localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
            }
            return;
          }
          if (next.status === "processing") {
            queuedSinceRef.current = 0;
          }
        }

        if (!pollCancelledRef.current) pollTimeoutRef.current = setTimeout(tick, JOB_POLL_INTERVAL_MS);
      };
      pollTimeoutRef.current = setTimeout(tick, JOB_POLL_INTERVAL_MS);
    },
    [refreshCredits],
  );

  // Restores an in-flight or just-finished job after the page re-mounts —
  // the job survives server-side (generation_jobs) regardless; only this
  // component's phase/job state was lost. If the saved job has since become
  // unreachable (deleted, belongs to a different account) this just clears
  // the stale key instead of getting stuck.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      let targetId =
        typeof window !== "undefined" ? localStorage.getItem(ACTIVE_JOB_STORAGE_KEY) : null;
      let fromRecent = false;

      // No localStorage pointer — fall back to the user's most recent LoRA
      // job so a reload after the key was cleared can still reach the Salvage
      // panel (failed/cancelled) or re-attach to a still-running job.
      if (!targetId) {
        try {
          const recent = await fetchRecentLoraJob();
          if (cancelled) return;
          if (recent) {
            const inFlight = recent.status === "queued" || recent.status === "processing";
            const terminal = ["failed", "cancelled", "completed"].includes(recent.status);
            const ref = recent.updatedAt || recent.createdAt;
            const ageMs = ref ? Date.now() - new Date(ref).getTime() : Infinity;
            // Live jobs: always re-attach. Terminal jobs: only if recent
            // (<12h) so an old run doesn't greet every visit.
            if (inFlight || (terminal && ageMs < 12 * 60 * 60 * 1000)) {
              targetId = recent.jobId;
              fromRecent = true;
            }
          }
        } catch {
          /* recent lookup is best-effort */
        }
      }
      if (!targetId || cancelled) return;

      const persist = () => {
        if (typeof window !== "undefined") localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, targetId!);
      };
      try {
        const restored = await pollLoraJob(targetId);
        if (cancelled) return;
        if (restored.status === "queued" || restored.status === "processing") {
          persist();
          setJob(restored);
          setPhase("tracking");
          startPolling(targetId);
        } else if (
          restored.status === "completed" ||
          restored.status === "failed" ||
          restored.status === "cancelled"
        ) {
          // Keep it around — the download / Salvage buttons in the completed
          // and failed/cancelled panels are the reason this restore exists.
          persist();
          setJob(restored);
          setPhase("tracking");
        } else if (!fromRecent && typeof window !== "undefined") {
          // failed_timeout (never left the queue — nothing to salvage) or an
          // unreachable job. Drop the stale key.
          localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
        }
      } catch {
        if (!cancelled && !fromRecent && typeof window !== "undefined") {
          localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Uploads `imgs` to Storage and starts the training job. `ownCaptions`, when
  // given and non-empty, is a caption list aligned to `imgs` that the user
  // authored (semi mode edits, a ZIP's .txt files, or curation) — sent as
  // custom_captions + skip_captioning so the worker never loads the 27B VLM.
  const runTraining = async (
    imgs: DatasetImage[],
    ownCaptions: string[] | null,
    captionsFromUser: boolean,
  ) => {
    if (!user) return;
    // Immediate, synchronous lock + phase flip in the same render pass — the
    // form (price card, credit warning) is gone before the next paint.
    setSubmitting(true);
    setPhase("starting");
    setErrorMessage(null);
    setJob(null);
    setUploadProgress({ done: 0, total: imgs.length });

    // Phase 1 — upload every image to Storage first. If even one fails we
    // abort here and NEVER call /api/studio/lora/train (calling it with a
    // partial / empty dataset is what produced the mystery 500s).
    //
    // Skip entirely when the exact same image set was already uploaded this
    // session — re-tuning params / YAML and hitting start again reuses the
    // existing Storage objects (they aren't deleted between runs).
    const datasetSignature =
      `${imgs.length}::` +
      imgs.map((i) => `${i.file.name}:${i.file.size}:${i.file.lastModified}`).join("|");

    let paths: string[];
    const cached = uploadedDatasetRef.current;
    if (cached && cached.signature === datasetSignature && cached.paths.length === imgs.length) {
      paths = cached.paths;
      setUploadProgress({ done: imgs.length, total: imgs.length });
      console.log(`[lora] reusing ${paths.length} already-uploaded images — upload skipped (0s)`);
    } else {
      try {
        const uploaded = await uploadLoraDataset(user.id, imgs.map((i) => i.file), (done, total) =>
          setUploadProgress({ done, total }),
        );
        paths = uploaded.paths;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error("[LoraStudioTab] dataset upload failed:", err);
        setErrorMessage(`画像のアップロードに失敗しました: ${detail}`);
        setPhase("form");
        setSubmitting(false);
        setUploadProgress(null);
        return;
      }
      if (paths.length !== imgs.length) {
        setErrorMessage(
          `画像のアップロードに失敗しました: ${imgs.length} 枚中 ${paths.length} 枚しか完了しませんでした。もう一度お試しください。`,
        );
        setPhase("form");
        setSubmitting(false);
        setUploadProgress(null);
        return;
      }
      // Only cache a fully-successful upload.
      uploadedDatasetRef.current = { signature: datasetSignature, paths };
    }

    // Phase 2 — start the training job with only the storage paths.
    try {
      const captionList = (ownCaptions ?? []).map((c) => (c ?? "").trim());
      const anyCaption = captionList.some((c) => c.length > 0);
      // A caption that's only the trigger word (or blank) is NOT a real
      // caption — the AI pass failed on that image and the worker's VLM must
      // fill it. `captionList` is aligned to `imgs` by construction, so this
      // also enforces "every current image has a caption entry".
      const trig = effectiveTrigger.trim().toLowerCase();
      const isSubstantive = (c: string): boolean => {
        const t = c.trim();
        if (!t) return false;
        if (!trig) return true;
        const rest = t.toLowerCase().startsWith(trig)
          ? t.slice(trig.length).replace(/^[\s,、]+/, "")
          : t;
        return rest.trim().length > 0;
      };
      const allCaptions =
        captionList.length === imgs.length && captionList.every(isSubstantive);
      // "Bring your own" (worker never loads the VLM, blanks become the
      // trigger word) when the user authored the captions (.txt / ZIP /
      // curation edits) — a blank there is intentional. AI captions instead
      // flow as `captions` (not custom_captions) unless every image has a
      // real caption, so the worker's fallback VLM fills only the gaps.
      const bringOwn = captionsFromUser ? anyCaption : allCaptions;

      const trainingConfig = yamlMode
        ? { custom_yaml_override: pro.rawYaml }
        : mode === "pro"
          ? {
              rank: pro.rank,
              alpha: effectiveAlpha,
              learning_rate: pro.learningRate,
              steps: pro.steps,
              optimizer: pro.optimizer,
            }
          : {};

      setUploadProgress({ done: imgs.length, total: imgs.length });
      console.log(`[lora] dataset uploaded (${paths.length} files) — calling /api/studio/lora/train`);
      const startRes = await startLoraTraining({
        storagePaths: paths,
        captions: captionList,
        targetModel,
        customModelId: isCustom ? customModelId.trim() : undefined,
        baseArchitecture: isCustom ? baseArchitecture : undefined,
        trainingConfig,
        resolution,
        // Raw-YAML mode: send the YAML's own name / trigger (the form fields
        // are disabled). The server re-derives these from the YAML too.
        outputLoraName: effectiveLoraName,
        triggerWord: effectiveTrigger,
        customCaptions: bringOwn ? captionList : undefined,
        skipCaptioning: bringOwn || undefined,
        captionPrompt: resolvedCaptionPromptRef.current.trim() || undefined,
        // The structured LoRA-type spec — the server rebuilds caption_prompt
        // from this if the browser couldn't (Gemini down here).
        captionSpec: captionSpecFilled ? captionSpec : undefined,
      });
      const { jobId, remainingCredits } = startRes;
      console.log("[lora] train ->", startRes);
      broadcastCreditsUpdate(user.id, remainingCredits);
      setJob({
        jobId,
        status: "queued",
        errorMessage: null,
        resultPath: null,
        progressPercent: 0,
        progressMessage: "queued",
        retryCount: 0,
        vramUsedGb: null,
        currentStep: null,
        totalSteps: null,
        etaSeconds: null,
        loss: null,
        logs: null,
        checkpoints: [],
        refunded: null,
        customYaml: yamlMode,
        safetyStop: false,
        safetyKind: null,
        queue: null,
      });
      setPhase("tracking");
      if (typeof window !== "undefined") localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, jobId);
      startPolling(jobId);
    } catch (err) {
      const e = err as LoraApiError;
      setErrorMessage(e.message || "LoRA学習の開始に失敗しました。");
      setPhase("form");
      setSubmitting(false);
      setUploadProgress(null);
      if (typeof e.remainingCredits === "number" && user) broadcastCreditsUpdate(user.id, e.remainingCredits);
    }
  };

  const userCaptionCount = useMemo(
    () =>
      images.filter(
        (img) => userCaptionIds.has(img.id) && (captions[img.id] ?? "").trim().length > 0,
      ).length,
    [images, captions, userCaptionIds],
  );
  const aiCaptionedCount = useMemo(
    () =>
      images.filter(
        (img) => !userCaptionIds.has(img.id) && (captions[img.id] ?? "").trim().length > 0,
      ).length,
    [images, captions, userCaptionIds],
  );
  const hasUserCaptions = userCaptionCount > 0;
  useEffect(() => {
    hasUserCaptionsRef.current = hasUserCaptions;
  }, [hasUserCaptions]);

  // --- Real-time trigger-word sync (no re-analysis) --------------------------
  // When the trigger word changes, rewrite the leading token of every existing
  // caption (EN + JA, and any curation pairs) on the spot. Debounced lightly
  // so holding a key doesn't thrash, but effectively instant.
  useEffect(() => {
    if (prevTriggerRef.current === null) {
      prevTriggerRef.current = curationTrigger;
      return;
    }
    const from = prevTriggerRef.current;
    const to = curationTrigger;
    if (from === to) return;
    const handle = setTimeout(() => {
      prevTriggerRef.current = to;
      const remap = (
        map: Record<string, string>,
        isUser: (id: string) => boolean,
      ): Record<string, string> => {
        let changed = false;
        const out: Record<string, string> = {};
        for (const [id, v] of Object.entries(map)) {
          const nv = swapLeadingTrigger(v, from, to, !isUser(id));
          out[id] = nv;
          if (nv !== v) changed = true;
        }
        return changed ? out : map;
      };
      setCaptions((m) => remap(m, (id) => userCaptionIds.has(id)));
      setCaptionsJa((m) => remap(m, (id) => userCaptionIds.has(id)));
      setCurationPairs((prev) => {
        if (!prev.length) return prev;
        let changed = false;
        const next = prev.map((p) => {
          const isUser = userCaptionIds.has(p.id);
          const caption = swapLeadingTrigger(p.caption, from, to, !isUser);
          const captionJa = swapLeadingTrigger(p.captionJa, from, to, !isUser);
          if (caption !== p.caption || captionJa !== p.captionJa) changed = true;
          return { ...p, caption, captionJa };
        });
        return changed ? next : prev;
      });
      // The stored captions now reflect the new trigger — advance the
      // re-analysis guard so "次へ" doesn't re-run the vision pass just for this.
      markCaptionsReflect(captionSpecKeyRef.current);
    }, 200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curationTrigger]);

  // Images that are the AI pass's responsibility (everything the user didn't
  // caption themselves) — the live denominator for the progress badge.
  const aiTargetCount = useMemo(
    () => images.filter((img) => !userCaptionIds.has(img.id)).length,
    [images, userCaptionIds],
  );
  // Any image still waiting on the AI vision pass.
  const pendingCaptionCount = useMemo(
    () =>
      images.filter((img) => !userCaptionIds.has(img.id) && !(captions[img.id] ?? "").trim()).length,
    [images, captions, userCaptionIds],
  );

  // --- AI-vision auto-captioning ----------------------------------------
  // Fires on drop: downscales each new image in the browser and calls
  // /api/studio/lora/caption in batches (see src/lib/loraCaption.ts). The
  // ".txt-bearing ZIP -> use as-is, skip AI" route is preserved (those ids
  // are pre-marked in captionAttemptedRef / userCaptionIdsRef).
  const runVisionCaptions = useCallback(
    async (
      targets: DatasetImage[],
      trigger: string,
      captionPrompt: string,
    ): Promise<{ cap: Record<string, string>; ja: Record<string, string> } | null> => {
      if (targets.length === 0) return null;
      autoCaptionAbortRef.current?.abort();
      const ac = new AbortController();
      autoCaptionAbortRef.current = ac;
      recaptionPromptRef.current = captionPrompt;
      // The captions produced here reflect the current trigger + spec.
      markCaptionsReflect(captionSpecKeyRef.current);
      setAutoCap({ running: true, done: 0, total: targets.length, error: null, note: null, everRan: true });

      // Merge each batch as it lands, dropping any target the user has
      // removed since the pass started (its id is gone from imageIdsRef).
      const mergeLive = (
        entries: { index: number; en: string; ja: string }[],
      ): { cap: Record<string, string>; ja: Record<string, string> } => {
        const live = imageIdsRef.current;
        const cap: Record<string, string> = {};
        const capJa: Record<string, string> = {};
        for (const e of entries) {
          const id = targets[e.index]?.id;
          if (!id || !live.has(id)) continue;
          if (e.en.trim()) cap[id] = e.en.trim();
          if (e.ja.trim()) capJa[id] = e.ja.trim();
        }
        if (Object.keys(cap).length) setCaptions((prev) => ({ ...prev, ...cap }));
        if (Object.keys(capJa).length) setCaptionsJa((prev) => ({ ...prev, ...capJa }));
        return { cap, ja: capJa };
      };

      const merged: { cap: Record<string, string>; ja: Record<string, string> } = { cap: {}, ja: {} };
      let res: Awaited<ReturnType<typeof generateDatasetCaptions>>;
      try {
        res = await generateDatasetCaptions(
          targets.map((t) => t.file),
          {
            triggerWord: trigger,
            captionPrompt: captionPrompt || undefined,
            signal: ac.signal,
            onProgress: (done, total) => setAutoCap((s) => ({ ...s, done, total, note: null })),
            onBatch: (entries) => {
              const m = mergeLive(entries);
              Object.assign(merged.cap, m.cap);
              Object.assign(merged.ja, m.ja);
            },
            onRetry: () =>
              setAutoCap((s) => ({
                ...s,
                note: "混雑のため少し待ってから自動で再試行しています…",
              })),
            isStale: (i) => {
              const id = targets[i]?.id;
              return !id || !imageIdsRef.current.has(id);
            },
          },
        );
      } catch {
        setAutoCap((s) => ({ ...s, running: false, error: "自動解析に失敗しました。" }));
        return null;
      }
      if (ac.signal.aborted) return null;

      // Safety net: fold in anything onBatch missed, still live-filtered.
      const tail = mergeLive(
        targets.map((t, k) => ({ index: k, en: res.captions[k] ?? "", ja: res.captionsJa[k] ?? "" })),
      );
      Object.assign(merged.cap, tail.cap);
      Object.assign(merged.ja, tail.ja);

      // "Missed" counts only images that still exist AND still have no caption.
      const live = imageIdsRef.current;
      const missed = targets.filter(
        (t) => live.has(t.id) && !(merged.cap[t.id] ?? "").trim(),
      ).length;
      // Of those, how many the safety filter genuinely refused (vs. gave up on).
      const safetyMissed = res.safetyRejected
        .map((i) => targets[i]?.id)
        .filter((id): id is string => Boolean(id) && live.has(id)).length;

      setAutoCap((s) => ({
        ...s,
        running: false,
        done: s.total,
        note: null,
        error:
          missed === 0
            ? null
            : safetyMissed >= missed
              ? `${missed} 枚はコンテンツポリシーにより自動解析の対象外です（学習時に自動補完されます）。`
              : safetyMissed > 0
                ? `${missed} 枚は自動解析できませんでした（うち ${safetyMissed} 枚はコンテンツポリシー対象、学習時に自動補完されます）。`
                : `${missed} 枚は自動解析できませんでした（学習時に自動補完されます）。`,
      }));
      return { cap: merged.cap, ja: merged.ja };
    },
    [markCaptionsReflect],
  );

  // Kick the vision pass for images that have no caption yet and haven't been
  // tried. Debounced so a 30-file drop is one pass, and serialised (waits for
  // a running pass) so a second drop mid-run doesn't abort the first.
  useEffect(() => {
    if (!user || phase !== "form" || autoCap.running) return;
    const pending = images.filter(
      (img) =>
        !captionAttemptedRef.current.has(img.id) &&
        !userCaptionIds.has(img.id) &&
        !(captions[img.id] ?? "").trim(),
    );
    if (pending.length === 0) return;
    const t = setTimeout(() => {
      pending.forEach((img) => captionAttemptedRef.current.add(img.id));
      // Feed the already-entered fixed/varying spec straight into the first
      // pass (deterministic prompt — no extra round-trip) so the captions
      // respect the blacklist from the start.
      void runVisionCaptions(pending, curationTrigger, currentCaptionPrompt());
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, captions, userCaptionIds, user, phase, autoCap.running]);

  // Re-run the vision pass over every AI-captioned image with the current
  // trigger word + synthesised instruction (the "🔄 AI再解析" button, and
  // handleStart when the category instruction changed).
  const recaptionAll = useCallback(async () => {
    const targets = images.filter((img) => !userCaptionIds.has(img.id));
    if (targets.length === 0) return null;
    targets.forEach((img) => captionAttemptedRef.current.add(img.id));
    return runVisionCaptions(
      targets,
      curationTrigger,
      resolvedCaptionPromptRef.current.trim() || currentCaptionPrompt(),
    );
  }, [images, userCaptionIds, curationTrigger, runVisionCaptions, currentCaptionPrompt]);

  // Runs on "次へ" / "学習を開始" — turns the selected LoRA type + JP feature
  // notes into the English Qwen instruction (Gemini, with a deterministic
  // fallback) and stashes it in resolvedCaptionPromptRef for runTraining.
  // A manual edit in the textarea wins outright; an empty spec leaves the
  // worker on its built-in default caption instruction.
  const resolveCaptionPrompt = async (ownCaptionsKnown: boolean) => {
    const manual = captionPromptOverride.trim();
    if (manual) {
      resolvedCaptionPromptRef.current = manual;
      setCaptionGen({ state: "done", prompt: manual, fromGemini: false, error: null });
      return;
    }
    if (ownCaptionsKnown || !captionSpecFilled) {
      resolvedCaptionPromptRef.current = "";
      setCaptionGen({ state: "idle", prompt: "", fromGemini: false, error: null });
      return;
    }
    setCaptionGen({ state: "generating", prompt: "", fromGemini: false, error: null });
    try {
      const result = await generateCaptionPrompt(captionSpec, curationTrigger);
      const prompt = result?.captionPrompt ?? "";
      resolvedCaptionPromptRef.current = prompt;
      setCaptionGen({
        state: prompt ? "done" : "error",
        prompt,
        fromGemini: result?.fromGemini ?? false,
        error: prompt ? null : "プロンプトを生成できませんでした。",
      });
    } catch {
      resolvedCaptionPromptRef.current = "";
      setCaptionGen({
        state: "error",
        prompt: "",
        fromGemini: false,
        error: "プロンプト自動生成に失敗しました（既定の指示で続行します）。",
      });
    }
  };

  // Client-side dataset ZIP (image + its caption .txt) — available on every
  // screen that still holds the images in memory (curation is handled inside
  // DatasetCurationUI; this covers the form / launching / in-progress views).
  const downloadDatasetZipLocal = async () => {
    if (datasetZipBusy || images.length === 0) return;
    setDatasetZipBusy(true);
    setErrorMessage(null);
    try {
      const entries = images.map((img) => ({
        file: img.file,
        caption: (captions[img.id] || captionsJa[img.id] || curationTrigger).trim(),
      }));
      const blob = await buildDatasetZip(entries);
      downloadBlob(blob, `dataset_${images.length}img.zip`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "データセット ZIP の作成に失敗しました。");
    } finally {
      setDatasetZipBusy(false);
    }
  };

  const handleStart = async () => {
    if (submitting || phase !== "form") return; // already in flight — ignore re-clicks
    if (!user) {
      setLoginOpen(true);
      return;
    }
    if (insufficientCredits) {
      if (typeof window !== "undefined") window.location.hash = "pricing";
      return;
    }
    if (!canSubmit) return;

    // Let any in-flight AI-vision pass finish so curation / training see the
    // completed captions.
    if (autoCap.running) {
      setErrorMessage("AI キャプション解析の完了をお待ちください…");
      return;
    }
    setErrorMessage(null);
    // Lock NOW — every path below is async; the button and the price/credit
    // cards must not be interactive again until phase leaves "form".
    setSubmitting(true);
    try {
      await runHandleStart();
    } finally {
      // If we're still on the form (an early guard tripped, or curation was
      // cancelled), release the lock; once phase is starting/tracking/curation
      // the early-return render owns the screen and this is a no-op.
      setSubmitting(false);
    }
  };

  const runHandleStart = async () => {

    let cap: Record<string, string> = captions;
    let capJa: Record<string, string> = captionsJa;

    // (1) Images that never went through the vision pass — e.g. the user
    //     clicked before the on-drop debounce fired. Caption them now.
    const neverTried = images.filter(
      (img) =>
        !userCaptionIds.has(img.id) &&
        !(cap[img.id] ?? "").trim() &&
        !captionAttemptedRef.current.has(img.id),
    );
    if (neverTried.length > 0) {
      neverTried.forEach((img) => captionAttemptedRef.current.add(img.id));
      const d = await runVisionCaptions(neverTried, curationTrigger, currentCaptionPrompt());
      if (d) {
        cap = { ...cap, ...d.cap };
        capJa = { ...capJa, ...d.ja };
      }
    }

    // (2) Did the fixed/varying spec (or manual override) actually change since
    //     the captions were last generated? A bare trigger-word edit does NOT
    //     count — that was already swapped in client-side.
    const specChanged = captionSpecKey !== reflectedSpecKey;

    // (3) Synthesise the LoRA-type instruction for the worker's VLM gap-fill,
    //     and — only when the spec changed — re-run the vision pass so the new
    //     blacklist / detail instructions are reflected in the captions.
    if (specChanged) {
      await resolveCaptionPrompt(hasUserCaptions);
    } else if (!resolvedCaptionPromptRef.current.trim()) {
      // Nothing changed — use the deterministic instruction, no round-trip.
      resolvedCaptionPromptRef.current = currentCaptionPrompt();
    }
    const aiCount = images.filter(
      (img) => !userCaptionIds.has(img.id) && (cap[img.id] ?? "").trim(),
    ).length;
    if (!hasUserCaptions && aiCount > 0 && specChanged) {
      const delta = await recaptionAll();
      if (delta) {
        cap = { ...cap, ...delta.cap };
        capJa = { ...capJa, ...delta.ja };
      }
    }

    if (curationEnabled) {
      setCurationPairs(
        images.map((img) => ({
          id: img.id,
          file: img.file,
          url: img.url,
          name: img.file.name,
          caption: cap[img.id] ?? "",
          captionJa: capJa[img.id] ?? "",
          excluded: false,
        })),
      );
      setPhase("curation");
      return;
    }

    const list = images.map((img) => (cap[img.id] ?? "").trim());
    const ownCaptions = list.some((c) => c.length > 0) ? list : null;
    await runTraining(images, ownCaptions, hasUserCaptions);
  };

  // From the curation screen — drop excluded pairs, sync the visible dataset
  // to what's kept, and train on the rest.
  const confirmCuration = async () => {
    const kept = curationPairs.filter((p) => !p.excluded);
    if (!kept.length) return;
    const keptIds = new Set(kept.map((p) => p.id));
    images.forEach((i) => {
      if (!keptIds.has(i.id)) URL.revokeObjectURL(i.url);
    });
    const keptImages: DatasetImage[] = kept.map((p) => ({ id: p.id, file: p.file, url: p.url }));
    imageIdsRef.current = keptIds;
    // Purge every trace of the excluded images so a later re-entry / re-pass
    // can't resurrect their state.
    curationPairs.forEach((p) => {
      if (!keptIds.has(p.id)) captionAttemptedRef.current.delete(p.id);
    });
    setUserCaptionIds((prev) => {
      if ([...prev].every((id) => keptIds.has(id))) return prev;
      return new Set([...prev].filter((id) => keptIds.has(id)));
    });
    setImages(keptImages);
    setCaptions(Object.fromEntries(kept.map((p) => [p.id, p.caption])));
    setCaptionsJa(Object.fromEntries(kept.map((p) => [p.id, p.captionJa])));
    const caps = kept.map((p) => p.caption.trim());
    // A .txt/ZIP dataset stays "bring your own" (blank = intentional). An
    // AI-captioned one keeps its VLM gap-fill even after culling images.
    await runTraining(keptImages, caps.some((c) => c.length > 0) ? caps : null, hasUserCaptions);
  };

  const resetForm = () => {
    pollCancelledRef.current = true;
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    setPhase("form");
    setSubmitting(false);
    setJob(null);
    setErrorMessage(null);
    setUploadProgress(null);
    if (typeof window !== "undefined") localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
  };

  // Wipes the saved draft and returns every form field to its default —
  // the ONLY place FORM_DRAFT_STORAGE_KEY is cleared. Confirmation gated.
  const resetFormDraft = () => {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "入力内容（トリガーワード・生YAML・こだわりテキスト・アップロード画像など）をすべて消去して、新規LoRA作成を最初から始めますか？\nこの操作は取り消せません。",
      );
      if (!ok) return;
      try {
        window.localStorage.removeItem(FORM_DRAFT_STORAGE_KEY);
      } catch {
        /* best-effort */
      }
    }
    autoCaptionAbortRef.current?.abort();
    captionAttemptedRef.current = new Set();
    recaptionPromptRef.current = "";
    prevTriggerRef.current = null;
    lastCaptionSpecKeyRef.current = "";
    setReflectedSpecKey("");
    setUserCaptionIds(new Set());
    setAutoCap({ running: false, done: 0, total: 0, error: null, note: null, everRan: false });
    images.forEach((i) => URL.revokeObjectURL(i.url));
    setImages([]);
    setCaptions({});
    setCaptionsJa({});
    setMode("auto");
    setModelChoice("minimax_h3");
    setCustomModelId("");
    setBaseArchitecture("sdxl");
    setResolution(DEFAULT_LORA_RESOLUTION);
    setTriggerWord("");
    setLoraName("");
    setPro(DEFAULT_PRO);
    setCaptionCategory("person");
    setCaptionFixed("");
    setCaptionVarying("");
    setCaptionPromptOverride("");
    setCaptionPromptOpen(false);
    setCaptionGen({ state: "idle", prompt: "", fromGemini: false, error: null });
    setCurationEnabled(false);
    setCurationPairs([]);
    setErrorMessage(null);
    uploadedDatasetRef.current = null;
    resolvedCaptionPromptRef.current = "";
  };

  // `submitting` folds in so every form control locks the instant "開始" is
  // pressed, through the async prep window before phase flips to "starting".
  const busy = phase !== "form" || submitting;

  // Job in flight — the form (dataset grid, all settings, price card, the
  // "クレジット不足" card) is torn down completely and only the progress
  // panel renders. No form re-render can flash a stale credit warning while
  // a paid job is running (requirement: phase="tracking" full isolation).
  if (phase === "starting" || phase === "tracking") {
    return (
      <div data-source-file="src/components/studio/LoraStudioTab.tsx" className="space-y-6">
        <div className="rounded-2xl border-gradient bg-surface/40 p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
            <Sparkles size={15} className="text-neon-violet" />
            {phase === "starting" ? "学習ジョブを起動中…" : "学習の進行状況"}
          </h3>
          <div className="mt-4 space-y-3">
            {phase === "starting" && (
              <div className="rounded-xl border border-neon-violet/30 bg-neon-violet/5 p-4">
                <div className="flex items-center gap-2 text-sm text-neon-violet">
                  <Loader2 size={15} className="animate-spin" />
                  {uploadProgress && uploadProgress.done < uploadProgress.total
                    ? `画像をアップロード中… ${uploadProgress.done}/${uploadProgress.total}`
                    : "🚀 学習ジョブを起動しています…"}
                </div>
                {uploadProgress && (
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-background/70">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-violet transition-[width] duration-300"
                      style={{
                        width: `${Math.round((uploadProgress.done / Math.max(1, uploadProgress.total)) * 100)}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            )}
            <ProgressPanel job={job} queuedElapsedSec={queuedElapsedSec} onUseLora={onUseLora} />
            {images.length > 0 && job?.status === "processing" && (
              <button
                type="button"
                onClick={downloadDatasetZipLocal}
                disabled={datasetZipBusy}
                title="学習に使用中の画像とキャプション(.txt)を1つのZIPにまとめて保存します。"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {datasetZipBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                📦 データセットDL (画像+txt) ・ {images.length} 枚
              </button>
            )}
            {job &&
              (job.status === "completed" ||
                job.status === "failed" ||
                job.status === "failed_timeout" ||
                job.status === "cancelled") && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="rounded-lg border border-border px-4 py-2 text-xs text-muted transition-colors hover:text-foreground"
                >
                  新しい LoRA を学習する
                </button>
              )}
          </div>
        </div>
        <LoginModal
          open={loginOpen}
          onClose={() => setLoginOpen(false)}
          message="LoRA Studio でキャラクター学習を行うにはログインしてください。"
        />
      </div>
    );
  }

  if (phase === "curation") {
    return (
      <div data-source-file="src/components/studio/LoraStudioTab.tsx" className="space-y-6">
        <DatasetCurationUI
          pairs={curationPairs}
          onChange={setCurationPairs}
          onConfirm={confirmCuration}
          onCancel={() => setPhase("form")}
          requiredCredits={requiredCredits}
          triggerWord={curationTrigger}
          maxImages={MAX_IMAGES}
          maxTotalBytes={MAX_TOTAL_BYTES}
        />
        <LoginModal
          open={loginOpen}
          onClose={() => setLoginOpen(false)}
          message="LoRA Studio でキャラクター学習を行うにはログインしてください。"
        />
      </div>
    );
  }

  return (
    <div data-source-file="src/components/studio/LoraStudioTab.tsx" className="space-y-6">
      {/* Draft persistence — inputs auto-save to localStorage; this button is
          the only way to wipe them. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] text-muted">
          <Check size={12} className="text-green-400" />
          入力内容は自動保存されます（リロードしても復元）
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={resetFormDraft}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[11px] text-muted transition-colors hover:border-red-400/50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw size={12} />
          フォームを初期化して新規LoRAを作成
        </button>
      </div>

      {/* Mode switch */}
      <div className="grid gap-2 sm:grid-cols-2">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            disabled={busy}
            onClick={() => setMode(m.id)}
            className={`rounded-xl border p-3 text-left transition-colors disabled:opacity-50 ${
              mode === m.id
                ? "border-neon-pink/50 bg-neon-pink/10"
                : "border-border bg-surface/40 hover:border-neon-violet/40"
            }`}
          >
            <p className={`text-sm font-semibold ${mode === m.id ? "text-neon-pink" : "text-foreground"}`}>{m.label}</p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">{m.desc}</p>
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr] lg:items-start">
        {/* Left column — dataset + captions */}
        <div className="space-y-4 rounded-2xl border-gradient bg-surface/40 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
              <ImagePlus size={15} className="text-neon-violet" />
              学習データセット
            </h3>
            {images.length > 0 && (
              <button
                type="button"
                onClick={downloadDatasetZipLocal}
                disabled={busy || datasetZipBusy}
                title="現在の画像とキャプション(.txt)を1つのZIPにまとめて保存します。"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {datasetZipBusy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                📦 データセットDL
              </button>
            )}
          </div>
          <ImageDropzone images={images} onAdd={addImages} onRemove={removeImage} disabled={busy} />

          {zipBusy && (
            <p className="flex items-center gap-1.5 text-[11px] text-neon-violet">
              <Loader2 size={12} className="animate-spin" />
              ZIP を展開しています…
            </p>
          )}
          {totalBytes > MAX_TOTAL_BYTES && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-400">
              画像の合計サイズが上限（{(MAX_TOTAL_BYTES / 1024 / 1024).toFixed(0)} MB）を超えています。枚数を減らすか縮小してください。
            </p>
          )}

          {/* Auto-routing badge: reflects the customCaptions / skipCaptioning
              the payload will carry, decided by what was dropped in + the AI
              vision pass result. No vendor names (CLAUDE.md §2). */}
          {images.length > 0 &&
            (autoCap.running && pendingCaptionCount > 0 ? (
              <p className="flex items-center gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/5 px-3 py-2 text-[11px] leading-relaxed text-neon-violet">
                <Loader2 size={13} className="shrink-0 animate-spin" />
                <span>
                  <span className="font-medium">高速AIビジョンが全画像を自動解析中…</span>（
                  {Math.min(aiCaptionedCount, aiTargetCount)}/{aiTargetCount}）
                  {autoCap.note && (
                    <span className="ml-1 text-neon-violet/70">— {autoCap.note}</span>
                  )}
                </span>
              </p>
            ) : hasUserCaptions ? (
              <p className="flex items-start gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-[11px] leading-relaxed text-green-400">
                <span className="shrink-0">📄</span>
                <span>
                  自前キャプション（{userCaptionCount} 件）を検知：
                  <span className="font-medium">AI解析をスキップして高速学習</span>します
                  {userCaptionCount < images.length &&
                    `（キャプション無し ${images.length - userCaptionCount} 枚はトリガーワードのみ）`}
                  。
                </span>
              </p>
            ) : aiCaptionedCount > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-[11px] leading-relaxed text-green-400">
                <span className="flex items-start gap-2">
                  <span className="shrink-0">✨</span>
                  <span>
                    <span className="font-medium">
                      高速AIビジョンが全画像を自動解析しました（最適タグを即時付与）
                    </span>
                    {pendingCaptionCount > 0 &&
                      `。${pendingCaptionCount} 枚は解析できず、学習時に自動補完されます`}
                    。
                  </span>
                </span>
                <button
                  type="button"
                  disabled={busy || autoCap.running}
                  onClick={() => void recaptionAll()}
                  title="現在のトリガーワード・こだわり設定で全画像を解析し直します"
                  className="inline-flex items-center gap-1 rounded-md border border-green-500/40 px-2 py-1 text-[10px] font-medium text-green-400 transition-colors hover:bg-green-500/10 disabled:opacity-50"
                >
                  <RotateCcw size={10} />
                  AI再解析
                </button>
              </div>
            ) : (
              <p className="flex items-start gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/5 px-3 py-2 text-[11px] leading-relaxed text-neon-violet">
                <span className="shrink-0">✨</span>
                <span>
                  <span className="font-medium">高速AIビジョンが全画像を自動解析</span>
                  し、最適なタグを即時付与します（画像＋同名 .txt の ZIP を入れると自前キャプション扱い）。
                </span>
              </p>
            ))}
          {autoCap.error && !autoCap.running && (
            <p className="text-[10px] text-amber-400">⚠️ {autoCap.error}</p>
          )}

          {/* Live confirmation that the trigger word + fixed/varying spec are
              reflected in the current captions (client-side sync, no re-run). */}
          {!autoCap.running && aiCaptionedCount > 0 && curationTrigger && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-green-400">
              <span className="inline-flex items-center gap-1">
                <Check size={10} />
                全キャプション（{aiCaptionedCount} 件）の先頭に「
                <span className="font-mono font-medium">{curationTrigger}</span>
                」を反映済み
              </span>
              {captionSpecFilled && (
                <span className="text-muted">
                  ・固定/変化の特徴指示も反映
                  {captionSpecKey !== reflectedSpecKey && (
                    <span className="text-amber-400">（変更あり — 「次へ」で更新）</span>
                  )}
                </span>
              )}
            </p>
          )}

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-background/40 px-3 py-2">
            <input
              type="checkbox"
              checked={curationEnabled}
              onChange={(e) => setCurationEnabled(e.target.checked)}
              disabled={busy}
              className="mt-0.5 accent-neon-pink"
            />
            <span className="text-[11px] leading-relaxed text-muted">
              <span className="font-medium text-foreground">アップロード後にキュレーション画面で確認・編集する</span>
              <br />
              画像をブラウザ上でプレビューして不要なものを間引き、自動生成されたキャプションを日本語で確認・修正してから学習を開始します。
            </span>
          </label>

          {(aiCaptionedCount > 0 || userCaptionCount > 0) && !curationEnabled && (
            <p className="text-[10px] leading-relaxed text-muted">
              キャプションを1枚ずつ確認・編集したい場合は、上の「キュレーション画面で確認・編集する」を有効にしてください。
            </p>
          )}
        </div>

        {/* Right column — settings */}
        <div className="space-y-4 rounded-2xl border-gradient bg-surface/40 p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
            <Cpu size={15} className="text-neon-violet" />
            学習設定
          </h3>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted">LoRA 名</label>
            <input
              value={yamlMode ? (yamlIdentity?.name ?? "") : loraName}
              onChange={(e) => setLoraName(e.target.value)}
              placeholder={yamlMode ? "生YAML の config.name" : "yukipas_h3"}
              disabled={busy || yamlMode}
              className={`${fieldCls} font-mono ${
                yamlMode
                  ? "opacity-60"
                  : loraName && !nameValid
                    ? "border-red-500/50"
                    : ""
              }`}
            />
            {yamlMode ? (
              <p className="mt-1 text-[10px] text-muted">
                生YAML モードでは YAML内の <code className="text-neon-violet">config.name</code> が LoRA 名になります。
                {!yamlNameValid && (
                  <span className="text-red-400">
                    {" "}
                    YAML に有効な <code>config.name</code> を記述してください。
                  </span>
                )}
              </p>
            ) : (
              loraName &&
              !nameValid && (
                <p className="mt-1 text-[10px] text-red-400">
                  英数字・ハイフン・アンダースコア・ドットのみ（64文字以内）
                </p>
              )
            )}
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted">トリガーワード（任意）</label>
            <input
              value={yamlMode ? (yamlIdentity?.triggerWord ?? "") : triggerWord}
              onChange={(e) => setTriggerWord(e.target.value)}
              placeholder={
                yamlMode ? "生YAML の process[0].trigger_word" : "yukipas（空欄なら LoRA 名から自動）"
              }
              disabled={busy || yamlMode}
              className={`${fieldCls} font-mono ${yamlMode ? "opacity-60" : ""}`}
            />
            {yamlMode && (
              <p className="mt-1 text-[10px] text-muted">
                生YAML モードでは YAML内の{" "}
                <code className="text-neon-violet">process[0].trigger_word</code> が使われます。
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="block text-[11px] font-medium text-muted">ベースモデル</label>
            <select
              value={modelChoice}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={busy}
              className={fieldCls}
            >
              {PRESET_GROUPS.map((g) => (
                <optgroup key={g} label={LORA_PRESET_GROUP_LABELS[g]}>
                  {LORA_PRESETS.filter((p) => p.group === g).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} — {p.note}
                    </option>
                  ))}
                </optgroup>
              ))}
              <optgroup label="⚙️ 上級者向け">
                <option value="__custom__">⚙️ 任意の HuggingFace Repo ID を手動指定...</option>
              </optgroup>
            </select>

            {isCustom && (
              <div className="space-y-2 rounded-lg border border-neon-violet/30 bg-neon-violet/5 p-2.5">
                <div>
                  <label className="mb-1 block text-[10px] text-muted">HuggingFace Model ID</label>
                  <input
                    value={customModelId}
                    onChange={(e) => setCustomModelId(e.target.value)}
                    placeholder="owner/name（または Volume 内パス）"
                    disabled={busy}
                    className={`${fieldCls} font-mono text-xs ${customBlocked ? "border-red-500/50" : ""}`}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] text-muted">ベース系統</label>
                  <select
                    value={baseArchitecture}
                    onChange={(e) => setBaseArchitecture(e.target.value as LoraBaseArchitecture)}
                    disabled={busy}
                    className={fieldCls}
                  >
                    {LORA_BASE_ARCHITECTURES.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>
                {customBlocked ? (
                  <p className="flex items-start gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] leading-snug text-red-400">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    {BLOCKED_LORA_MODEL_MESSAGE}
                  </p>
                ) : (
                  <p className="text-[10px] text-muted">
                    任意のオープンモデル（HF リポジトリ / Volume 内チェックポイント）を指定できます。
                  </p>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted">学習解像度</label>
            <select
              value={resolution}
              onChange={(e) => setResolution(Number(e.target.value) as LoraResolution)}
              disabled={busy}
              className={fieldCls}
            >
              {LORA_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {LORA_RESOLUTION_LABELS[r]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-muted">解像度が高いほど高精細ですが、学習時間と負荷が増えます。</p>
          </div>

          {/* LoRA-type-aware auto-caption spec — category + JP fixed/varying */}
          <div className="rounded-xl border border-neon-violet/30 bg-neon-violet/5">
            <button
              type="button"
              onClick={() => setCaptionPromptOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
            >
              <span className="flex items-center gap-2 text-[11px] font-medium text-neon-violet">
                <Bot size={13} />
                🤖 学習タイプ別 キャプション自動最適化
                <span className="rounded bg-neon-violet/15 px-1.5 py-0.5 text-[9px] font-semibold text-neon-violet">
                  {captionCategoryMeta.icon} {captionCategoryMeta.label}
                </span>
              </span>
              <ChevronDown
                size={14}
                className={`shrink-0 text-muted transition-transform ${captionPromptOpen ? "rotate-180" : ""}`}
              />
            </button>

            {captionPromptOpen && (
              <div className="space-y-3 px-3 pb-3">
                <p className="text-[10px] leading-relaxed text-muted">
                  学習タイプを選び、日本語で「固定したい特徴」と「変化させたい特徴」を入力してください。
                  「次へ」を押すと入力内容をAIが解析し、画像解析エンジン向けの最適な英語キャプション指示を自動生成・反映します
                  （固定したい特徴はキャプションから除外＝トリガーワードに焼き込み、変化させたい特徴のみ描写）。
                </p>

                <div className="flex flex-wrap gap-1.5">
                  {LORA_CAPTION_CATEGORIES.map((c) => {
                    const m = LORA_CAPTION_CATEGORY_META[c];
                    const active = captionCategory === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        disabled={busy}
                        onClick={() => setCaptionCategory(c)}
                        title={m.hint}
                        className={`rounded-lg border px-2.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                          active
                            ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                            : "border-border bg-background/60 text-muted hover:border-neon-violet/40"
                        }`}
                      >
                        {m.icon} {m.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted">{captionCategoryMeta.hint}</p>

                <div>
                  <label className="mb-1 block text-[10px] font-medium text-foreground">
                    🔒 固定したい特徴（学習させる／キャプションに書かない）
                  </label>
                  <textarea
                    value={captionFixed}
                    onChange={(e) => setCaptionFixed(e.target.value)}
                    rows={3}
                    disabled={busy}
                    placeholder={captionCategoryMeta.fixedPlaceholder}
                    className={`${fieldCls} resize-y text-[11px] leading-relaxed`}
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[10px] font-medium text-foreground">
                    🔄 変化させたい特徴（キャプションで描写する）
                  </label>
                  <textarea
                    value={captionVarying}
                    onChange={(e) => setCaptionVarying(e.target.value)}
                    rows={3}
                    disabled={busy}
                    placeholder={captionCategoryMeta.varyingPlaceholder}
                    className={`${fieldCls} resize-y text-[11px] leading-relaxed`}
                  />
                </div>

                {!captionSpecFilled && !captionPromptOverride.trim() && (
                  <p className="text-[10px] text-muted opacity-80">
                    未入力の場合はワーカー標準のキャプション指示で学習します。
                  </p>
                )}

                {captionGen.state === "generating" && (
                  <p className="flex items-center gap-1.5 text-[10px] text-neon-violet">
                    <Loader2 size={11} className="animate-spin" />
                    英語プロンプトを生成中…
                  </p>
                )}
                {captionGen.state === "done" && captionGen.prompt && (
                  <div className="space-y-1 rounded-lg border border-border bg-background/50 p-2">
                    <p className="flex items-center gap-1.5 text-[10px] font-medium text-foreground">
                      <Check size={11} className="text-green-400" />
                      生成済み
                      <span className="rounded bg-neon-violet/15 px-1 py-0.5 text-[9px] text-neon-violet">
                        {captionGen.fromGemini ? "AI 生成" : "簡易生成（オフライン）"}
                      </span>
                    </p>
                    <p className="max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted">
                      {captionGen.prompt}
                    </p>
                  </div>
                )}
                {captionGen.state === "error" && captionGen.error && (
                  <p className="text-[10px] text-amber-400">⚠️ {captionGen.error}</p>
                )}

                <details className="group">
                  <summary className="cursor-pointer text-[10px] text-muted transition-colors hover:text-foreground">
                    詳細: 英語キャプション指示を直接指定する（上級者向け）
                  </summary>
                  <div className="mt-1.5 space-y-1">
                    <textarea
                      value={captionPromptOverride}
                      onChange={(e) => setCaptionPromptOverride(e.target.value)}
                      rows={4}
                      disabled={busy}
                      placeholder="空欄 = 上記から自動生成。ここに英語で書くと自動生成を上書きします。"
                      className={`${fieldCls} resize-y font-mono text-[10px] leading-relaxed`}
                    />
                    {captionPromptOverride.trim() && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setCaptionPromptOverride("")}
                        className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/60 px-2 py-1 text-[10px] text-muted transition-colors hover:text-foreground disabled:opacity-50"
                      >
                        <RotateCcw size={10} />
                        自動生成に戻す
                      </button>
                    )}
                  </div>
                </details>
              </div>
            )}
          </div>

          {mode === "pro" && (
            <div className="space-y-3 rounded-xl border border-neon-pink/30 bg-neon-pink/5 p-3">
              {isAdmin ? (
                <label className="flex items-center gap-2 text-[11px] font-medium text-neon-pink">
                  <input
                    type="checkbox"
                    checked={pro.useRawYaml}
                    onChange={(e) => setPro((p) => ({ ...p, useRawYaml: e.target.checked }))}
                    disabled={busy}
                    className="h-3.5 w-3.5 accent-neon-pink"
                  />
                  生 YAML を直接編集（学習ジョブ設定）
                  <span className="rounded bg-neon-pink/15 px-1 py-0.5 text-[9px] font-semibold text-neon-pink">
                    ADMIN
                  </span>
                </label>
              ) : adminLoading ? (
                <p className="flex items-center gap-1.5 text-[10px] text-muted">
                  <Loader2 size={11} className="animate-spin" />
                  権限を確認中…
                </p>
              ) : (
                <YamlVipLockCard />
              )}

              {yamlMode ? (
                <>
                  <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug font-medium text-amber-400">
                    ⚠️ [Pro Custom YAML] パラメータ不正や非互換オプションによる学習失敗時、消費されたクレジットは返金されません（自己責任）。
                  </p>
                  <textarea
                    value={pro.rawYaml}
                    onChange={(e) => setPro((p) => ({ ...p, rawYaml: e.target.value }))}
                    rows={12}
                    disabled={busy}
                    placeholder={"job: extension\nconfig:\n  name: my_lora\n  process:\n    - type: sd_trainer\n      ..."}
                    className={`${fieldCls} resize-y font-mono text-[11px]`}
                  />
                  {/* Live YAML syntax + schema validation */}
                  {yamlCheck && !yamlCheck.ok ? (
                    yamlCheck.errors && yamlCheck.errors.length > 0 ? (
                      <div className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] font-medium text-red-400">
                        {yamlCheck.errors.map((e, i) => (
                          <p key={i}>{e}</p>
                        ))}
                      </div>
                    ) : (
                      <p className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] font-medium text-red-400">
                        ❌ YAMLエラー
                        {yamlCheck.line != null
                          ? ` [行 ${yamlCheck.line}${yamlCheck.column != null ? `, 列 ${yamlCheck.column}` : ""}]`
                          : ""}
                        : {yamlCheck.message}
                      </p>
                    )
                  ) : yamlCheck && yamlCheck.ok ? (
                    <>
                      <p className="text-[10px] font-medium text-green-400">✅ YAML構文正常（有効な設定）</p>
                      {yamlCheck.warnings.map((w, i) => (
                        <p key={i} className="text-[10px] text-amber-400">
                          ⚠️ {w}
                        </p>
                      ))}
                    </>
                  ) : null}
                  <p className="text-[10px] leading-relaxed text-muted">
                    {priceBreakdown && priceBreakdown.steps > 0
                      ? `${loraPriceMultiplierSummary(priceBreakdown)} → 消費 ${requiredCredits} C`
                      : `steps / パラメータを解析できません → 安全側で上限 ${requiredCredits} C を適用`}
                  </p>
                </>
              ) : (
                <div className="space-y-3">
                  {/* Rank — discrete choices only */}
                  <div>
                    <label className="mb-1 block text-[10px] text-muted">Rank（LoRA の表現力）</label>
                    <div className="flex flex-wrap gap-1.5">
                      {RANK_OPTIONS.map((r) => (
                        <button
                          key={r}
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            setPro((p) => ({
                              ...p,
                              rank: r,
                              alpha: (p.alphaLinked ?? true) ? r : p.alpha,
                            }))
                          }
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                            pro.rank === r
                              ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                              : "border-border bg-background/60 text-muted hover:border-neon-violet/40"
                          }`}
                        >
                          {r}
                          {r === 32 ? " ・推奨" : ""}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Alpha — auto-linked to Rank by default */}
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[10px] text-muted">
                      <span>Alpha（学習の効き）</span>
                      <label className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={alphaLinked}
                          onChange={(e) =>
                            setPro((p) => ({
                              ...p,
                              alphaLinked: e.target.checked,
                              alpha: e.target.checked ? p.rank : p.alpha,
                            }))
                          }
                          disabled={busy}
                          className="h-3 w-3 accent-neon-pink"
                        />
                        Rank に自動連動
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {ALPHA_OPTIONS.map((a) => (
                        <button
                          key={a}
                          type="button"
                          disabled={busy || alphaLinked}
                          onClick={() => setPro((p) => ({ ...p, alpha: a, alphaLinked: false }))}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
                            effectiveAlpha === a
                              ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                              : "border-border bg-background/60 text-muted hover:border-neon-violet/40"
                          }`}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Steps — slider + clamped number input + quick picks */}
                  <div>
                    <label className="mb-1 block text-[10px] text-muted">Steps（学習ステップ数）</label>
                    <div className="flex w-full items-center gap-2">
                      <input
                        type="range"
                        min={STEPS_MIN}
                        max={STEPS_MAX}
                        step={STEPS_STEP}
                        value={pro.steps}
                        onChange={(e) => setPro((p) => ({ ...p, steps: Number(e.target.value) }))}
                        disabled={busy}
                        className="h-1.5 min-w-0 flex-1 accent-neon-pink"
                      />
                      <input
                        type="number"
                        min={STEPS_MIN}
                        max={STEPS_MAX}
                        step={STEPS_STEP}
                        value={pro.steps}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setPro((p) => ({
                            ...p,
                            steps: Number.isFinite(v)
                              ? Math.min(STEPS_MAX, Math.max(STEPS_MIN, Math.round(v)))
                              : p.steps,
                          }));
                        }}
                        disabled={busy}
                        className="w-20 shrink-0 rounded-lg border border-border bg-background px-2 py-2 text-sm tabular-nums outline-none transition-colors focus:border-neon-violet/50"
                      />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {STEPS_QUICK.map((s) => (
                        <button
                          key={s.value}
                          type="button"
                          disabled={busy}
                          onClick={() => setPro((p) => ({ ...p, steps: s.value }))}
                          className={`rounded-lg border px-2.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                            pro.steps === s.value
                              ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                              : "border-border bg-background/60 text-muted hover:border-neon-violet/40"
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Learning Rate — safe presets, free entry only on カスタム */}
                  <div>
                    <label className="mb-1 block text-[10px] text-muted">Learning Rate</label>
                    <select
                      value={pro.lrCustom ? "custom" : String(pro.learningRate)}
                      onChange={(e) => {
                        if (e.target.value === "custom") {
                          setPro((p) => ({ ...p, lrCustom: true }));
                        } else {
                          setPro((p) => ({ ...p, lrCustom: false, learningRate: Number(e.target.value) }));
                        }
                      }}
                      disabled={busy}
                      className={fieldCls}
                    >
                      {LR_PRESETS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                      <option value="custom">カスタム（手動入力）</option>
                    </select>
                    {pro.lrCustom && (
                      <input
                        type="number"
                        step="0.00001"
                        min={0}
                        value={pro.learningRate}
                        onChange={(e) =>
                          setPro((p) => ({ ...p, learningRate: Number(e.target.value) || p.learningRate }))
                        }
                        disabled={busy}
                        placeholder="0.0001"
                        className={`${fieldCls} mt-1.5`}
                      />
                    )}
                  </div>

                  {/* Optimizer */}
                  <div>
                    <label className="mb-1 block text-[10px] text-muted">Optimizer</label>
                    <select
                      value={pro.optimizer}
                      onChange={(e) => setPro((p) => ({ ...p, optimizer: e.target.value }))}
                      disabled={busy}
                      className={fieldCls}
                    >
                      {OPTIMIZERS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Credits — parameter-linked dynamic price. Hidden the instant a
              job is being submitted so a post-charge re-render can't flash a
              stale "insufficient" state over the launching job. */}
          {!submitting && (
            <div className="rounded-lg border border-border bg-background/60 px-3 py-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-neon-pink">
                  <Zap size={13} />
                  {requiredCredits} Credits
                </span>
                <span className="text-muted">保有: {creditsLoading ? "…" : (credits ?? 0)}</span>
              </div>
              {priceBreakdown && priceBreakdown.steps > 0 && (
                <p className="mt-1 text-[10px] leading-relaxed text-muted">
                  {loraPriceMultiplierSummary(priceBreakdown)}
                </p>
              )}
            </div>
          )}
          {insufficientCredits && !submitting && (
            <a
              href="#pricing"
              className="flex items-center justify-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-400"
            >
              <Zap size={13} />
              クレジットが不足しています — チャージする
            </a>
          )}

          {heavyConfigWarn && phase === "form" && !submitting && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-400">
              ⚠️ [警告]
              1280px高解像度かつ100枚超の設定は、準備処理（3D VAEエンコード）に莫大な時間を要し、コンテナが途中で早期安全停止される可能性が極めて高いです。解像度を最大1024pxに下げるか、画像枚数を減らすことを強く推奨します。
            </p>
          )}

          {/* Action — this render only runs for phase === "form" (starting /
              tracking / curation all early-return above). */}
          <div className="space-y-3">
            {errorMessage && (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {errorMessage}
              </p>
            )}
            <button
              type="button"
              onClick={handleStart}
              disabled={
                submitting ||
                (Boolean(user) && !insufficientCredits && !canSubmit) ||
                captionGen.state === "generating" ||
                (Boolean(user) && autoCap.running)
              }
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  🚀 学習ジョブを起動中…
                </>
              ) : !user ? (
                <>
                  <LogIn size={16} />
                  ログインして学習を開始
                </>
              ) : insufficientCredits ? (
                <>
                  <Zap size={16} />
                  クレジットをチャージ
                </>
              ) : autoCap.running ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  AIキャプションを解析中…（完了までお待ちください）
                </>
              ) : captionGen.state === "generating" ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  キャプションプロンプトを生成中…
                </>
              ) : curationEnabled ? (
                <>
                  <Wand2 size={16} />
                  次へ：データセットを確認・編集する
                </>
              ) : (
                <>
                  <Wand2 size={16} />
                  {`🔥 高速 LoRA 学習を開始する (${requiredCredits} C)`}
                </>
              )}
            </button>
            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted">
              <Sparkles size={13} className="mt-0.5 shrink-0 text-neon-violet" />
              独自の高精度パイプラインで自動キャプション ➔
              深度最適化学習を完全自動で実行。完了したLoRAは即座にダウンロードしてご利用いただけます。
            </p>
          </div>
        </div>
      </div>

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        message="LoRA Studio でキャラクター学習を行うにはログインしてください。"
      />
    </div>
  );
}
