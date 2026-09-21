"use client";

// LoraStudioTab.tsx から切り出した、モジュールレベルの定数・型・ヘルパー関数・
// 独立したプレゼンテーショナルコンポーネント群。メインの LoraStudioTab
// コンポーネント本体（巨大な状態を持つ単一関数）はリスクが高いため分割せず
// LoraStudioTab.tsx に残し、ここでは props だけで完結する部分のみを扱う。

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clapperboard,
  ClipboardCopy,
  Download,
  ImagePlus,
  Loader2,
  Lock,
  MessageCircle,
  RotateCcw,
  Scissors,
  Sparkles,
  Trash2,
} from "lucide-react";
import { ToastStack, type ToastData } from "@/components/Toast";
import { QueueStatusPanel } from "@/components/studio/QueueStatusPanel";
import { VramBadge } from "@/components/studio/VramBadge";
import {
  downloadLoraCheckpoint,
  downloadLoraSelectionZip,
  downloadLoraJobBundle,
  probeLoraJobArtifact,
  getLoraCheckpointDownloadUrl,
  salvageLoraJob,
  type LoraJobStatus,
  type LoraSalvageResult,
} from "@/lib/loraApi";
import {
  DEFAULT_LORA_RESOLUTION,
  type LoraBaseArchitecture,
  type LoraPresetGroup,
  type LoraResolution,
} from "@/lib/loraModels";
import { LORA_MAX_STEPS } from "@/lib/loraCredits";
import {
  type LoraCaptionCategory,
  type LoraSubject,
  type CaptionMode,
} from "@/lib/loraCaptionSpec";
import { SMART_CROP_KIND_LABEL, type SmartCropKind } from "@/lib/smartCrop";

export const JOB_POLL_INTERVAL_MS = 3000;
// Consecutive transient poll failures (5xx / network) tolerated before the
// monitor shows the "connection lost" fallback card. Each retry in between
// waits an exponentially longer backoff. Reaching this no longer STOPS the
// loop — it drops to a slow keep-alive tick (POLL_KEEPALIVE_MS) that
// self-heals the screen the moment the API / network is back.
export const MAX_RETRY_COUNT = 6;
// Slow keep-alive cadence once the fast retries are spent and the degraded
// card is up. The job keeps running server-side; this tick is what catches
// its completion without the user having to click anything.
export const POLL_KEEPALIVE_MS = 15_000;
// 2026-09-15: 200→500に引き上げ。この上限はModal worker側のCPU前処理
// （Smart Ingest、無料CPUコンテナ・timeout=45分）の許容枚数として決まる —
// 実機ベンチ（16枚×46MB≒Storage側の実上限に近いworst caseサイズ、
// 4並列ThreadPoolExecutor）で 38.5秒/16枚 を実測。この実測レートで外挿すると
// 200枚≒8分・500枚≒20分・1000枚≒40分で、以前の200という値は45分予算に対して
// 実測の1/5程度しか使っていない過度に保守的な仮値だった（CLAUDE.md §0）。
// 500枚なら worst case でも20分＝予算の半分以下に収まる安全マージンを確保。
export const MAX_IMAGES = 500;
// Raw upload budget. The worker's Smart Ingest stage downscales / re-encodes
// every image on a free CPU container before the GPU starts, and AI-vision
// captioning only ever sees ~640px browser thumbnails — so a large raw
// dataset (4K crops, phone shots) is fine to accept here.
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB total
// 2026-09-15: lora_datasetsバケットのfile_size_limitが実は50MBのままで、
// ここが96MBと案内していても実際は50MB超で413エラーになっていたのを発見
// （supabase/migrations/20260872000000で150MBに引き上げ済み）。96MBという
// このアプリ側の上限自体は妥当なので変更しない。
export const MAX_FILE_BYTES = 96 * 1024 * 1024; // 96 MB per image (a ~6K PNG)

// Survives a page reload mid-job (dev server restart, browser refresh,
// accidental navigation) — job/phase state otherwise lives only in this
// component's useState and is gone the instant the page re-mounts, even
// though the job itself keeps running (or already finished) server-side.
// A finished job's checkpoint download buttons disappearing this way is
// what this exists to prevent.
export const ACTIVE_JOB_STORAGE_KEY = "lora_studio_active_job";
// Legacy / alternative keys other builds may have written — cleared on reset
// too so a stale pointer from any of them can't strand the user.
export const LEGACY_ACTIVE_JOB_KEYS = ["active_lora_job_id", "ull_active_job", "lora_studio_active_job_id"];
export const DISMISSED_JOBS_STORAGE_KEY = "lora_studio_dismissed_jobs";

// How recently a `completed` job must have finished for the mount-restore
// fallback (fetchRecentLoraJob, used only when the localStorage pointer was
// lost) to still surface its "🏆 直前の学習が完了しています" download banner.
// A long H3 / video run legitimately takes 5h+, so a user who trains
// overnight and reopens the Studio the next day must still land on the
// banner — 12h was too tight for exactly that case. Artifacts live 14 days
// (CLAUDE.md §3); 7 days keeps the banner reachable well within that without
// resurfacing ancient jobs on every visit.
export const RECENT_COMPLETED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Auto-saved draft of the whole form — text inputs (trigger word, raw YAML,
// the Japanese "固定/変化させたい特徴" notes) AND the expert / model settings
// (base model, resolution, Rank, Alpha, Steps, LR, optimizer, mode). Written
// on every change, restored on mount / re-mount / reload, so a browser crash,
// an accidental reload, a dev-server restart, or switching back to the form
// after a failed run never drops a hand-tuned config. Cleared only by the
// explicit "フォームを初期化" button, never automatically.
export const FORM_DRAFT_STORAGE_KEY = "lora_studio_form_draft_v1";

// AI-vision captions cached by file identity ("name::size::lastModified"), so a
// mid-run browser crash / reload doesn't lose the captions already earned — the
// same files dropped back in rehydrate instantly and only the incomplete ones
// are re-analyzed. Written through on every batch that lands; pruned to the
// most recent CAPTION_CACHE_MAX entries so it can't grow unbounded.
const CAPTION_CACHE_STORAGE_KEY = "lora_studio_captions_v1";
const CAPTION_CACHE_MAX = 1000;
type CaptionCacheEntry = { en: string; ja: string; at: number };

export function loadCaptionCache(): Record<string, CaptionCacheEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CAPTION_CACHE_STORAGE_KEY);
    const obj = raw ? (JSON.parse(raw) as unknown) : null;
    return obj && typeof obj === "object" ? (obj as Record<string, CaptionCacheEntry>) : {};
  } catch {
    return {};
  }
}

export function persistCaptionCache(entries: { key: string; en: string; ja: string }[]): void {
  if (typeof window === "undefined" || entries.length === 0) return;
  try {
    const cache = loadCaptionCache();
    const now = Date.now();
    for (const e of entries) {
      if (!e.en.trim() && !e.ja.trim()) continue;
      cache[e.key] = { en: e.en, ja: e.ja, at: now };
    }
    const keys = Object.keys(cache);
    if (keys.length > CAPTION_CACHE_MAX) {
      keys
        .sort((a, b) => (cache[a]?.at ?? 0) - (cache[b]?.at ?? 0))
        .slice(0, keys.length - CAPTION_CACHE_MAX)
        .forEach((k) => delete cache[k]);
    }
    window.localStorage.setItem(CAPTION_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* quota / disabled storage — captions still live in React state */
  }
}

// Wipe the whole AI-caption draft cache. Used when the user starts a fresh
// dataset and chooses NOT to carry the previous run's captions — otherwise a
// re-dropped file (same name::size::lastModified) silently rehydrates a stale,
// possibly wrong-format caption ("zombie draft").
export function clearCaptionCache(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CAPTION_CACHE_STORAGE_KEY);
  } catch {
    /* no-op */
  }
}

export type LoraFormDraft = {
  triggerWord: string;
  // 複数被写体（2026-09-15）。primaryDescriptionはtriggerWord本人の判別用
  // 説明（extraSubjectsが1件以上ある時だけ意味を持つ）。primaryFixedTagsは
  // 性別/人数タグの固定値（例: "1girl, solo"）、空ならAI判定に任せる。
  primaryDescription: string;
  primaryFixedTags: string;
  extraSubjects: LoraSubject[];
  loraName: string;
  captionCategory: LoraCaptionCategory;
  captionFixed: string;
  captionVarying: string;
  captionPromptOverride: string;
  // Caption FORMAT preference: 'auto' lets the base model decide (dense prose
  // vs. comma tags), 'dense' / 'tags' pin it. See resolveCaptionMode().
  captionMode: CaptionMode;
  curationEnabled: boolean;
  // Expert / model settings — persisted so a reload, a component re-mount, or
  // a switch back to the form after a failed run never drops a hand-tuned
  // Rank / Steps / LR / resolution / base model.
  mode: Mode;
  modelChoice: string;
  customModelId: string;
  baseArchitecture: LoraBaseArchitecture;
  resolution: LoraResolution;
  pro: ProConfig;
};

// Single constructor so the persisted object, the default, and the pristine-
// check comparison always share an identical key order (the "is this the
// untouched form?" test below is a JSON string compare).
export function buildFormDraft(v: {
  triggerWord: string;
  primaryDescription: string;
  primaryFixedTags: string;
  extraSubjects: LoraSubject[];
  loraName: string;
  captionCategory: LoraCaptionCategory;
  captionFixed: string;
  captionVarying: string;
  captionPromptOverride: string;
  captionMode: CaptionMode;
  curationEnabled: boolean;
  mode: Mode;
  modelChoice: string;
  customModelId: string;
  baseArchitecture: LoraBaseArchitecture;
  resolution: LoraResolution;
  pro: ProConfig;
}): LoraFormDraft {
  return {
    triggerWord: v.triggerWord,
    primaryDescription: v.primaryDescription,
    primaryFixedTags: v.primaryFixedTags,
    extraSubjects: v.extraSubjects,
    loraName: v.loraName,
    captionCategory: v.captionCategory,
    captionFixed: v.captionFixed,
    captionVarying: v.captionVarying,
    captionPromptOverride: v.captionPromptOverride,
    captionMode: v.captionMode,
    curationEnabled: v.curationEnabled,
    mode: v.mode,
    modelChoice: v.modelChoice,
    customModelId: v.customModelId,
    baseArchitecture: v.baseArchitecture,
    resolution: v.resolution,
    pro: {
      rank: v.pro.rank,
      alpha: v.pro.alpha,
      alphaLinked: v.pro.alphaLinked,
      learningRate: v.pro.learningRate,
      lrCustom: v.pro.lrCustom,
      steps: v.pro.steps,
      optimizer: v.pro.optimizer,
      useRawYaml: v.pro.useRawYaml,
      rawYaml: v.pro.rawYaml,
    },
  };
}

// `DEFAULT_FORM_DRAFT` is defined further down, right after `DEFAULT_PRO`
// (it needs that value), near the `Phase` type.

// Older stored drafts (pre-expert-settings) kept rawYaml / useRawYaml at the
// top level instead of nested under `pro` — still honoured on read.
export type LegacyFormDraft = Partial<LoraFormDraft> & { rawYaml?: unknown; useRawYaml?: unknown };

export function loadFormDraft(): LegacyFormDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(FORM_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as LegacyFormDraft) : null;
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
export type Mode = "auto" | "pro";

export const MODES: { id: Mode; label: string; desc: string }[] = [
  { id: "auto", label: "⚡ オート (Auto)", desc: "画像を入れるだけ。キャプションは自動検知（同名 .txt があれば優先）" },
  { id: "pro", label: "🔬 エキスパート (Pro)", desc: "Rank / LR / Steps スライダーや生 YAML を直接編集" },
];

export const PRESET_GROUPS: LoraPresetGroup[] = ["video", "photo", "anime"];

// 2026-09-20: 並び順を変更。8bit 系（adamw8bit / lion8bit）は bitsandbytes の
// int8 量子化オプティマイザで、VRAM を節約する代わりに CLAUDE.md §1 の量子化
// 禁止方針に抵触する。上級者が明示的に選べるよう**選択肢としては残す**が、
// 先頭（＝ドロップダウンで最初に目に入る位置）から末尾へ移し、既定
// （DEFAULT_PRO.optimizer）は prodigy のままとする。
export const OPTIMIZERS = ["prodigy", "adamw", "adafactor", "adamw8bit", "lion8bit"];
export const LORA_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Safe, discrete hyperparameter choices — no free-form number entry (a
// stray keystroke on Rank/LR used to silently wreck a paid run).
export const RANK_OPTIONS = [8, 16, 32, 64, 128] as const;
export const ALPHA_OPTIONS = [8, 16, 32, 64, 128] as const;
export const STEPS_MIN = 200;
export const STEPS_MAX = LORA_MAX_STEPS;
export const STEPS_STEP = 50;
export const STEPS_QUICK: { value: number; label: string }[] = [
  { value: 500, label: "500 (軽量テスト)" },
  { value: 1000, label: "1000 (標準)" },
  { value: 2000, label: "2000 (高密度/受託推奨)" },
  // 2026-09-20: スライダー上限を 5,000 → 20,000 に引き上げた（LORA_MAX_STEPS
  // のコメント参照）のに合わせて、大規模データセット向けの目安を1つ足す。
  // 上限そのものはクイック選択に出さない（推奨値ではなく壁なので）。
  { value: 5000, label: "5000 (大規模データセット)" },
];
export const LR_PRESETS: { value: number; label: string }[] = [
  { value: 0.0001, label: "0.0001 (1e-4) ・ 推奨/標準" },
  { value: 0.0002, label: "0.0002 (2e-4) ・ 強め" },
  { value: 0.00005, label: "0.00005 (5e-5) ・ 微調整" },
];

// Auto-caption prompt is now built from the selected LoRA type (人物 / 衣装 /
// 物体 / 背景 / 画風) plus the user's Japanese notes on which features to lock
// in vs. let vary — see src/lib/loraCaptionSpec.ts. On "次へ" the browser calls
// /api/studio/lora/caption-prompt (Gemini) to synthesise the English
// instruction handed to the worker's Qwen captioner as `caption_prompt`.

// cropKind: スマートクロップが生成した画像だけに付く（元アップロード画像は
// undefined）。再度スマートクロップを実行する対象から除外する判定にも使う。
// repeats: この画像を何回学習するか（kohya のフォルダ名規約 "10_name" と同じ
// 意味）。未設定＝1。特定の被写体だけ厚く焼きたいときに使う。
// ⚠️ 総ステップ数は固定なので**消費クレジットは変わらない**。変わるのは
// データセットの構成比だけ。
export type DatasetImage = {
  id: string;
  file: File;
  url: string;
  cropKind?: SmartCropKind;
  repeats?: number;
};

// 両ワーカー（modal_lora_worker.py / modal_sdxl_lora_worker.py）の
// MAX_IMAGE_REPEATS と同じ値に保つこと。
export const MAX_IMAGE_REPEATS = 50;
// ワンクリックで選べる倍率。実務で使うのはこのあたり。
export const REPEAT_PRESETS = [1, 2, 3, 5, 10] as const;

export type ProConfig = {
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

// 2026-09-14: 既定オプティマイザを adamw8bit（量子化・VRAM節約用）から
// prodigy（フル精度・学習率フリー）へ変更（ホスト判断）。CLAUDE.md §1の
// 「量子化は原則不使用」に反していた上、B300では節約する理由が無い。
// learningRate はここでは AdamW 系選択時の見た目の初期値としてのみ残す
// （prodigy選択時はUIごと非表示・サーバー側でも強制的に無視される —
// modal_lora_worker.py の _build_config 参照）。
export const DEFAULT_PRO: ProConfig = {
  rank: 32,
  alpha: 32,
  alphaLinked: true,
  learningRate: 1e-4,
  lrCustom: false,
  steps: 2000,
  optimizer: "prodigy",
  useRawYaml: false,
  rawYaml: "",
};

export const DEFAULT_FORM_DRAFT: LoraFormDraft = buildFormDraft({
  triggerWord: "",
  primaryDescription: "",
  primaryFixedTags: "",
  extraSubjects: [],
  loraName: "",
  captionCategory: "character",
  captionFixed: "",
  captionVarying: "",
  captionPromptOverride: "",
  captionMode: "auto",
  curationEnabled: false,
  mode: "auto",
  modelChoice: "minimax_h3",
  customModelId: "",
  baseArchitecture: "sdxl",
  resolution: DEFAULT_LORA_RESOLUTION,
  pro: DEFAULT_PRO,
});

export type Phase = "form" | "curation" | "starting" | "tracking";

export const fieldCls =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50";

// Quick-select helper buttons above the checkpoint list (全選択 / 後半のみ / 全解除).
export const quickSelectBtnCls =
  "rounded-md border border-border px-2 py-0.5 text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground";

// ---------------------------------------------------------------------------

export function ImageDropzone({
  images,
  onAdd,
  onRemove,
  disabled,
  captionState,
  recaptioningIds,
  onRecaption,
  smartCropCandidateCount,
  smartCropBusy,
  smartCropProgress,
  onSmartCrop,
  onSetRepeats,
}: {
  images: DatasetImage[];
  onAdd: (files: FileList | File[]) => void;
  onRemove: (id: string) => void;
  disabled: boolean;
  // "ok" (captioned) | "error" (retries exhausted) | "pending" (not yet done).
  captionState?: (id: string) => "ok" | "error" | "pending";
  recaptioningIds?: Set<string>;
  // スマートクロップ未実施の元画像の枚数（0なら実行対象なし）。
  smartCropCandidateCount?: number;
  smartCropBusy?: boolean;
  smartCropProgress?: { done: number; total: number } | null;
  onSmartCrop?: () => void;
  onRecaption?: (id: string) => void;
  // 画像ごとの学習回数の一括設定（未指定なら重み付け UI を出さない）。
  onSetRepeats?: (ids: string[], repeats: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const totalBytes = images.reduce((s, i) => s + i.file.size, 0);
  // 学習回数の一括設定用の選択状態。1枚ずつ触るには枚数が多すぎるので、
  // 「選んでまとめて設定」を基本操作にする（shift+クリックで範囲選択）。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClickedRef = useRef<string | null>(null);
  const weighted = images.filter((i) => (i.repeats ?? 1) !== 1).length;

  const toggleSelect = (id: string, shiftKey: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const anchor = lastClickedRef.current;
      if (shiftKey && anchor && anchor !== id) {
        const ids = images.map((i) => i.id);
        const a = ids.indexOf(anchor);
        const b = ids.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let k = lo; k <= hi; k++) next.add(ids[k]);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastClickedRef.current = id;
  };

  const applyRepeats = (n: number) => {
    if (!onSetRepeats || selected.size === 0) return;
    onSetRepeats([...selected], n);
    setSelected(new Set());
  };

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
          {/* 画像ごとの学習回数（kohya の "10_name" フォルダ相当）。枚数が多い
              ので「選んでまとめて設定」を基本操作にする。shift+クリックで範囲選択。 */}
          {onSetRepeats && !disabled && (
            <div className="mt-2 rounded-lg border border-border bg-background/60 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
                <span className="font-medium text-foreground">学習回数の重み付け</span>
                {selected.size > 0 ? (
                  <>
                    <span className="text-neon-violet">{selected.size} 枚を選択中 →</span>
                    {REPEAT_PRESETS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => applyRepeats(n)}
                        className={quickSelectBtnCls}
                      >
                        ×{n}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        const raw = window.prompt(`学習回数（1〜${MAX_IMAGE_REPEATS}）`, "4");
                        const n = Number(raw);
                        if (Number.isFinite(n)) applyRepeats(Math.min(MAX_IMAGE_REPEATS, Math.max(1, Math.round(n))));
                      }}
                      className={quickSelectBtnCls}
                    >
                      カスタム
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelected(new Set())}
                      className="text-muted transition-colors hover:text-foreground"
                    >
                      選択解除
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-muted">
                      画像をクリックで選択（shift+クリックで範囲）→ 倍率を指定
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelected(new Set(images.map((i) => i.id)))}
                      className={quickSelectBtnCls}
                    >
                      全選択
                    </button>
                    {weighted > 0 && (
                      <button
                        type="button"
                        onClick={() => onSetRepeats(images.map((i) => i.id), 1)}
                        className={quickSelectBtnCls}
                      >
                        すべて ×1 に戻す
                      </button>
                    )}
                  </>
                )}
              </div>
              {weighted > 0 && (
                <p className="mt-1.5 text-[10px] text-muted">
                  {weighted} 枚に重み付けあり。<strong className="text-foreground">消費クレジットは変わりません</strong>
                  （総ステップ数は固定で、変わるのはデータセットの構成比だけ）。
                </p>
              )}
            </div>
          )}
          {onSmartCrop && (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={onSmartCrop}
                disabled={disabled || smartCropBusy || !smartCropCandidateCount}
                title="骨格・顔の座標から「顔クローズアップ / 上半身 / 全身」の3枚を自動で切り出し、データセットに追加します。"
                className="inline-flex items-center gap-1.5 rounded-lg border border-neon-violet/40 bg-neon-violet/5 px-2.5 py-1 text-[11px] font-medium text-neon-violet transition-colors hover:bg-neon-violet/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {smartCropBusy ? <Loader2 size={12} className="animate-spin" /> : <Scissors size={12} />}
                ✂️ スマートクロップ
                {smartCropCandidateCount ? `（元画像 ${smartCropCandidateCount} 枚）` : ""}
              </button>
              {smartCropBusy && smartCropProgress && (
                <span className="text-[11px] text-muted">
                  {smartCropProgress.done}/{smartCropProgress.total} 枚 処理中…
                </span>
              )}
            </div>
          )}
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {images.map((img) => {
              const st = captionState?.(img.id) ?? "ok";
              const recapping = recaptioningIds?.has(img.id) ?? false;
              const reps = img.repeats ?? 1;
              const isSelected = selected.has(img.id);
              const selectable = !!onSetRepeats && !disabled;
              return (
                <div
                  key={img.id}
                  onClick={selectable ? (e) => toggleSelect(img.id, e.shiftKey) : undefined}
                  className={`group relative flex aspect-square items-center justify-center overflow-hidden rounded-lg border bg-neutral-900 ${
                    selectable ? "cursor-pointer" : ""
                  } ${
                    isSelected
                      ? "border-neon-violet ring-2 ring-neon-violet/60"
                      : st === "error"
                        ? "border-red-500/60"
                        : "border-border"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.url}
                    alt={img.file.name}
                    className="h-full w-full object-contain"
                  />
                  {recapping && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <Loader2 size={16} className="animate-spin text-white" />
                    </div>
                  )}
                  {!disabled && !recapping && st === "error" && onRecaption && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRecaption(img.id);
                      }}
                      title="この画像を再解析"
                      className="absolute inset-x-1 bottom-1 inline-flex items-center justify-center gap-1 rounded-md bg-red-500/80 px-1 py-0.5 text-[9px] font-semibold text-white transition-opacity hover:bg-red-500"
                    >
                      <RotateCcw size={9} /> 再解析
                    </button>
                  )}
                  {!disabled && !recapping && st === "pending" && (
                    <span className="absolute left-1 top-1 rounded bg-amber-500/80 px-1 py-0.5 text-[8px] font-medium text-white">
                      未解析
                    </span>
                  )}
                  {reps !== 1 && (
                    <span
                      className="absolute bottom-1 left-1 rounded bg-neon-pink/90 px-1 py-0.5 text-[9px] font-bold text-white"
                      title={`この画像は ${reps} 回学習されます`}
                    >
                      ×{reps}
                    </span>
                  )}
                  {img.cropKind && (
                    <span className="absolute bottom-1 right-1 rounded bg-neon-violet/85 px-1 py-0.5 text-[8px] font-medium text-white">
                      ✂️ {SMART_CROP_KIND_LABEL[img.cropKind]}
                    </span>
                  )}
                  {!disabled && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(img.id);
                      }}
                      className="absolute right-1 top-1 rounded-md bg-black/70 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label="削除"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

// 2026-09-15: 性別/人数タグ（1girl/1boy/1man/1woman、+solo+性別語 自動付与）を
// AI任せにせず固定するピッカー。keep_tokens=4（trigger+3タグ）の運用に合わせ、
// プリセット4種は選ぶだけで`"{value}, solo, female|male"`になる。単独写りの
// 画像ならsoloは基本的に常に正しいので自動で付ける。プリセットに無い組み合わせ
// （性別を跨ぐ・トークン数を変えたい等）は「カスタム」で自由入力。
const GENDER_TAG_PRESETS = ["1girl", "1boy", "1man", "1woman"] as const;
const GENDER_TAG_SEX_WORD: Record<(typeof GENDER_TAG_PRESETS)[number], "female" | "male"> = {
  "1girl": "female",
  "1woman": "female",
  "1boy": "male",
  "1man": "male",
};

function presetKeyFromFixedTags(v: string): (typeof GENDER_TAG_PRESETS)[number] | "custom" | "" {
  const t = v.trim();
  if (!t) return "";
  const hit = GENDER_TAG_PRESETS.find((p) => t.toLowerCase() === `${p}, solo, ${GENDER_TAG_SEX_WORD[p]}`);
  return hit ?? "custom";
}

export function GenderTagPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const preset = presetKeyFromFixedTags(value);
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <span className="shrink-0 text-[10px] text-muted">性別/人数タグ:</span>
      <select
        value={preset}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") onChange("");
          else if (v === "custom") onChange(value.trim() || "1girl, solo, female");
          else onChange(`${v}, solo, ${GENDER_TAG_SEX_WORD[v as (typeof GENDER_TAG_PRESETS)[number]]}`);
        }}
        disabled={disabled}
        className="rounded-md border border-border bg-background/70 px-1.5 py-1 text-[11px] text-foreground outline-none focus:border-neon-violet/50 disabled:opacity-50"
      >
        <option value="">（AIに判定させる・非推奨）</option>
        {GENDER_TAG_PRESETS.map((p) => (
          <option key={p} value={p}>
            {p} (+solo, {GENDER_TAG_SEX_WORD[p]})
          </option>
        ))}
        <option value="custom">カスタム入力</option>
      </select>
      {preset === "custom" && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="1girl, solo, female"
          disabled={disabled}
          className="min-w-0 flex-1 rounded-md border border-border bg-background/70 px-1.5 py-1 font-mono text-[11px] text-foreground outline-none focus:border-neon-violet/50 disabled:opacity-50"
        />
      )}
    </div>
  );
}

// Shown to non-admins in place of the raw-YAML editor. The editor itself is a
// support / bespoke-contract feature — an unchecked YAML paste is the fastest
// way for a normal user to burn credits on a crashing run — so it's gated to
// admins and everyone else gets this consultation prompt. (No physical GPU
// model / vendor names here — CLAUDE.md §2.)
export function YamlVipLockCard() {
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

// The worker prefixes every Live-Terminal line with its container wall clock
// ("HH:MM:SS  <message>" — time.strftime on a UTC Modal container). Shift ONLY
// that leading stamp to JST (Asia/Tokyo is a fixed UTC+9, no DST) for display;
// the message body — text, numbers, step progress, error strings — is left
// byte-for-byte untouched. Modulo-24 arithmetic is exact for a bare wall-clock
// time (no date is shown, so a midnight rollover is a non-issue). A line with
// no leading stamp is returned unchanged.
const LOG_UTC_TS_RE = /^(\d{2}):(\d{2}):(\d{2})(?=\s)/;

function toJstLogLine(line: string): string {
  return line.replace(LOG_UTC_TS_RE, (_full, h: string, m: string, s: string) => {
    const jstHour = (Number(h) + 9) % 24;
    return `${String(jstHour).padStart(2, "0")}:${m}:${s}`;
  });
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
              {toJstLogLine(l)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProgressPanel({
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
  // Bundle-download busy flag ("final" / "dataset") — a single heavy op, so it
  // stays serialised. The per-row ⬇️ buttons do NOT use this (see
  // `ckptDownloading` below): each click fires its own signed download
  // immediately with no shared lock / queue.
  const [downloadingCkpt, setDownloadingCkpt] = useState<string | null>(null);
  const [copyingCkpt, setCopyingCkpt] = useState<string | null>(null);
  // Filenames whose per-row ⬇️ signed-URL round-trip (~1s) is in flight — for a
  // per-button spinner + a same-file double-tap guard ONLY. Never a global
  // lock: other rows stay clickable, and clicks are never dropped.
  const [ckptDownloading, setCkptDownloading] = useState<Set<string>>(() => new Set());
  const [ckptError, setCkptError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastData[]>([]);
  // Server-confirmed existence of each artefact — only consulted for a job
  // that ended in error (`failed` / `failed_timeout`). Tagged with the jobId
  // it belongs to; a null field = not yet checked, so the button stays hidden
  // until the probe actually comes back.
  const [artifactProbe, setArtifactProbe] = useState<{
    jobId: string | null;
    final: boolean | null;
    dataset: boolean | null;
  }>({ jobId: null, final: null, dataset: null });

  // "一括ダウンロード" state. 1 file selected -> its own .safetensors download;
  // 2+ -> the server bundles them into a single uncompressed (ZIP_STORED) zip
  // and the browser pulls that as ONE stream (dodges the same-origin
  // concurrent-connection cap that hung a multi-file dispatch). Tagged with
  // the job id (like `artifactProbe`) so a stale "✅ 開始しました" never carries
  // onto another job's panel.
  // `bundle` -> the 2+ file path, whose "preparing" window is the ~30-60s the
  // worker spends writing a multi-GB ZIP_STORED file before the browser sees a
  // single byte (single-file "preparing" is just the ~1s URL-sign round-trip).
  const [bulkDl, setBulkDl] = useState<{
    jobId: string;
    state: "idle" | "preparing" | "done";
    bundle: boolean;
  }>({ jobId: "", state: "idle", bundle: false });

  // Which checkpoints are ticked for the "選択したチェックポイントを保存"
  // button. Tagged with jobId; when it doesn't match the current job the
  // selection defaults to 全選択 (resolved in the completed branch below).
  const [ckptSel, setCkptSel] = useState<{ jobId: string; selected: Set<string> }>({
    jobId: "",
    selected: new Set<string>(),
  });

  const pushToast = (message: string) =>
    setToasts((prev) => [...prev, { id: Date.now() + Math.random(), message }]);
  const dismissToast = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const probeJobId = job?.jobId ?? null;
  const probeStatus = job?.status ?? null;
  useEffect(() => {
    // A `completed` job shows its downloads unconditionally; only the error
    // states need a real filesystem check before offering anything.
    if (!probeJobId || (probeStatus !== "failed" && probeStatus !== "failed_timeout")) {
      return;
    }
    let alive = true;
    void (async () => {
      const [final, dataset] = await Promise.all([
        probeLoraJobArtifact(probeJobId, "final").catch(() => false),
        probeLoraJobArtifact(probeJobId, "dataset").catch(() => false),
      ]);
      if (alive) setArtifactProbe({ jobId: probeJobId, final, dataset });
    })();
    return () => {
      alive = false;
    };
  }, [probeJobId, probeStatus]);

  if (!job) return null;

  // Probe results only apply to the job they were fetched for.
  const probe =
    artifactProbe.jobId === job.jobId
      ? artifactProbe
      : { final: null, dataset: null };
  // Same guard for the bulk-download state.
  const bulk =
    bulkDl.jobId === job.jobId ? bulkDl : { state: "idle" as const, bundle: false };

  // Per-row ⬇️. Fires immediately, every click — no concurrency limit, no
  // pending queue, no shared disable. `ckptDownloading` only tracks this
  // file's own ~1s signing round-trip for its spinner / double-tap guard.
  const handleCkptDownload = (filename: string) => {
    setCkptError(null);
    setCkptDownloading((s) => {
      const n = new Set(s);
      n.add(filename);
      return n;
    });
    void downloadLoraCheckpoint(job.jobId, filename)
      .catch((err) =>
        setCkptError(err instanceof Error ? err.message : "ダウンロードに失敗しました。"),
      )
      .finally(() =>
        setCkptDownloading((s) => {
          const n = new Set(s);
          n.delete(filename);
          return n;
        }),
      );
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

  // 一括ダウンロード. One file -> its own .safetensors. Two or more -> the
  // server stitches them into a single uncompressed (ZIP_STORED) zip and the
  // browser pulls that as ONE stream — a multi-file client-side dispatch hits
  // the same-origin concurrent-connection cap and wedges after ~2. Both paths
  // await only the URL-signing round-trip (+ the server's fast Store-mode zip
  // build) then hand off to the browser's own download manager.
  const handleSelectionDownload = async (files: string[]) => {
    if (files.length === 0 || bulk.state === "preparing") return;
    const isBundle = files.length > 1;

    setCkptError(null);
    setBulkDl({ jobId: job.jobId, state: "preparing", bundle: isBundle });
    try {
      if (!isBundle) {
        await downloadLoraCheckpoint(job.jobId, files[0]);
        setBulkDl({ jobId: job.jobId, state: "done", bundle: false });
        return;
      }
      // The signed URL is minted in ~1s, but the browser then blocks on the
      // worker writing a multi-GB ZIP_STORED bundle (~30-60s) before the
      // download actually begins. Hold the "まとめています" copy across that
      // window instead of flashing "開始しました" a minute early — we can't
      // observe the cross-origin response, so approximate with a timer.
      await downloadLoraSelectionZip(job.jobId, files);
      window.setTimeout(() => {
        setBulkDl((prev) =>
          prev.jobId === job.jobId && prev.state === "preparing" && prev.bundle
            ? { jobId: job.jobId, state: "done", bundle: true }
            : prev,
        );
      }, 45_000);
    } catch (err) {
      setBulkDl({ jobId: job.jobId, state: "idle", bundle: false });
      setCkptError(err instanceof Error ? err.message : "ダウンロードの開始に失敗しました。");
    }
  };

  // All three primary buttons resolve the ACTUAL file server-side (recursive
  // Volume search, on-demand zip) and only fire the iframe once the API has
  // confirmed the file exists — a genuine miss becomes a visible toast, never
  // a silent iframe 404. No salvage round-trip.
  const handleBundleDownload = async (want: "dataset" | "final") => {
    setDownloadingCkpt(want);
    setCkptError(null);
    try {
      await downloadLoraJobBundle(job.jobId, want);
      pushToast("ダウンロードを開始しました");
    } catch (err) {
      setCkptError(err instanceof Error ? err.message : "ダウンロードに失敗しました。");
    } finally {
      setDownloadingCkpt(null);
    }
  };

  // The primary downloads block. Each button is gated independently:
  //  - completed          → all three exist, show everything.
  //  - failed / _timeout  → only what the server-side probe actually found
  //                         (a Step-0 init crash produces nothing, so the
  //                         whole block collapses to null).
  // Only the bundle (完成版 / データセット) ops serialise each other — a per-row
  // ⬇️ or URLコピー must never gate these.
  const dlBusy = downloadingCkpt !== null;
  const renderArtifactDownloads = (show: { final: boolean; dataset: boolean }) => {
    if (!show.final && !show.dataset) return null;
    return (
      <div className="space-y-2 rounded-lg border border-neon-violet/40 bg-background/50 p-3">
        <p className="text-[11px] font-semibold text-foreground">📥 成果物ダウンロード</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {show.final && (
            <button
              type="button"
              onClick={() => handleBundleDownload("final")}
              disabled={dlBusy}
              title="完成版（無ければ最新の中間チェックポイント）を .safetensors で取得します。"
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-2.5 text-xs font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {downloadingCkpt === "final" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              🏆 完成版LoRA DL (.safetensors)
            </button>
          )}
          {show.dataset && (
            <button
              type="button"
              onClick={() => handleBundleDownload("dataset")}
              disabled={dlBusy}
              title="学習に使用した画像とキャプション(.txt)を1つのZIPにまとめて取得します。"
              className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-neon-violet/40 bg-neon-violet/10 px-3 py-2.5 text-xs font-semibold text-neon-violet transition-all hover:bg-neon-violet/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {downloadingCkpt === "dataset" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              📦 キャプション付きデータセットDL (ZIP)
            </button>
          )}
        </div>
        {ckptError && <p className="text-[10px] text-red-400">{ckptError}</p>}
        <p className="text-[10px] leading-relaxed text-muted opacity-70">
          未生成のファイルはクリック時にクラウド上で復元してから取得します（GPU課金なし）。
        </p>
      </div>
    );
  };

  if (job.status === "failed_timeout") {
    return (
      <div className="space-y-3">
        {renderArtifactDownloads({
          final: probe.final === true,
          dataset: probe.dataset === true,
        })}
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-400">
            <AlertTriangle size={15} />
            自動返金しました
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-amber-300/90">
            クラウド混雑のため自動返金しました。時間をおいて再試行してください。
          </p>
        </div>
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
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
    // The dispatcher fires the CPU pre-cache + GPU spawn asynchronously and
    // returns instantly; while a big base model (WAN 2.1 14B, …) downloads
    // the job sits in "queued" with a 🧊 progress_message. Surface it, and
    // stop the generic copy from reading as "stuck" after a minute.
    const elapsed = queuedElapsedSec ?? 0;
    const serverMsg = job.progressMessage && job.progressMessage !== "queued" ? job.progressMessage : null;
    const provisioningMessage =
      serverMsg ??
      (elapsed < 15
        ? "専用ハイエンドGPUノードをプロビジョニング中…"
        : elapsed < 90
          ? "コンテナ初期化 & モデル環境ロード中…"
          : "ベースモデルを準備しています…（初回は数分かかります・このままお待ちください）");
    return (
      <div className="flex flex-col items-center gap-1">
        <QueueStatusPanel phase="queued" queue={job.queue} />
        <span className="max-w-[26rem] text-center text-[11px] leading-relaxed text-neon-violet/80">
          {provisioningMessage}
        </span>
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
      : msg.startsWith("🖼️")
        ? "超高精細データセット最適化中…"
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

        {/* Completed jobs don't get the single 完成版 button — final (Step 3000)
            is already in the checkpoint list below (selection DL + per-row ⬇️).
            Only the dataset ZIP belongs up here. */}
        <div className="mt-3">{renderArtifactDownloads({ final: false, dataset: true })}</div>

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
        </div>
        {ckptError && !checkpoints.length && (
          <p className="mt-1.5 text-[10px] text-red-400">{ckptError}</p>
        )}

        {checkpoints.length > 0 &&
          (() => {
            const allNames = checkpoints.map((c) => c.filename);
            // Default = 全選択 until the user touches the selection for THIS job.
            const selectedNames =
              ckptSel.jobId === job.jobId ? ckptSel.selected : new Set(allNames);
            const isSel = (name: string) => selectedNames.has(name);
            const selectedFiles = checkpoints
              .filter((c) => isSel(c.filename))
              .map((c) => c.filename);
            const selectedCount = selectedFiles.length;
            const commit = (names: Iterable<string>) => {
              setCkptSel({ jobId: job.jobId, selected: new Set(names) });
              // Clear a previous run's "✅ 開始しました" once the selection changes.
              if (bulk.state !== "idle") {
                setBulkDl({ jobId: job.jobId, state: "idle", bundle: false });
              }
            };
            const toggle = (name: string) => {
              const next = new Set(selectedNames);
              if (next.has(name)) next.delete(name);
              else next.add(name);
              commit(next);
            };
            // 後半のみ: Step 2000+ if any, otherwise the top 50% by step.
            const laterHalf = () => {
              const strong = checkpoints.filter((c) => c.step >= 2000);
              if (strong.length > 0) return strong.map((c) => c.filename);
              const sorted = [...checkpoints].sort((a, b) => a.step - b.step);
              return sorted.slice(Math.floor(sorted.length / 2)).map((c) => c.filename);
            };
            return (
              <div className="mt-4 border-t border-green-500/20 pt-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] font-medium text-foreground">
                    中間チェックポイント（過学習を避けて最適なステップを選択）
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => commit(allNames)} className={quickSelectBtnCls}>
                      全選択
                    </button>
                    <button type="button" onClick={() => commit(laterHalf())} className={quickSelectBtnCls}>
                      後半のみ (2000+)
                    </button>
                    <button type="button" onClick={() => commit([])} className={quickSelectBtnCls}>
                      全解除
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleSelectionDownload(selectedFiles)}
                  disabled={selectedCount === 0 || bulk.state === "preparing"}
                  title="チェックを入れたチェックポイントをまとめて1つのファイルとしてダウンロードします（解凍不要・そのまま取り込み可）。"
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-4 py-3 text-sm font-bold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {bulk.state === "preparing" ? (
                    <>
                      <Loader2 size={15} className="animate-spin" />
                      {bulk.bundle
                        ? "📦 サーバーでファイルをまとめています…（約30〜60秒）"
                        : "📦 ダウンロードを準備中…"}
                    </>
                  ) : bulk.state === "done" ? (
                    <>
                      <Check size={15} />
                      ✅ ダウンロードを開始しました（ブラウザの進行状況を確認してください）
                    </>
                  ) : (
                    <>
                      <Download size={15} />⚡ 選択したチェックポイントを一括ダウンロード ({selectedCount} 件)
                    </>
                  )}
                </button>
                <p className="mt-1.5 text-[10px] leading-relaxed text-muted opacity-70">
                  まず 1 個だけ各行の「⬇️」でテスト取得し、良ければ必要な数件をチェックして一括ダウンロードできます。2
                  件以上は自動で 1
                  つのファイルにまとめて配信されます。
                  <br />
                  ※複数ファイルのまとめ処理（数GB）を行うため、ブラウザのダウンロードが実際に開始されるまで30〜60秒ほど準備時間がかかります。
                </p>

                <div className="mt-2 flex flex-col gap-1.5">
                  {checkpoints.map((c) => (
                    <div
                      key={c.filename}
                      className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-xs ${
                        c.isFinal ? "border-neon-pink/40 bg-neon-pink/5" : "border-border bg-background/40"
                      }`}
                    >
                      <label className="flex cursor-pointer items-center gap-2 font-mono text-[11px] text-muted">
                        <input
                          type="checkbox"
                          checked={isSel(c.filename)}
                          onChange={() => toggle(c.filename)}
                          className="h-3.5 w-3.5 shrink-0 accent-neon-violet"
                        />
                        <span className={c.isFinal ? "font-semibold text-neon-pink" : "text-foreground"}>
                          {c.isFinal ? "最終版" : `Step ${c.step}`}
                        </span>
                        <span className="opacity-60">{formatMb(c.sizeBytes)}</span>
                      </label>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleCkptDownload(c.filename)}
                          disabled={ckptDownloading.has(c.filename)}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {ckptDownloading.has(c.filename) ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <Download size={11} />
                          )}
                          ⬇️ ダウンロード
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCkptCopyUrl(c.filename)}
                          disabled={copyingCkpt === c.filename}
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
            );
          })()}

        {checkpoints.length === 0 && (
          <p className="mt-3 text-[10px] leading-relaxed text-muted">
            中間チェックポイントの一覧が表示されていない場合は、上の「🏆 完成版LoRA
            DL」から最新の重みを取得できます。
          </p>
        )}

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
  const hasCaptionArchive = (job.checkpoints ?? []).some((c) => c.isCaptionArchive);
  // A Step-0 init crash leaves nothing behind — offer 完成版 ONLY when the
  // file is really there (client-side signal or server probe), and the
  // dataset ZIP only when captions actually got parsed & persisted. The
  // per-step checkpoints (partialCkpts) render as their own list below.
  const artifactShow = {
    final: probe.final === true,
    dataset: hasCaptionArchive || probe.dataset === true,
  };
  const hasPartialCkpts = partialCkpts.length > 0;
  const probingArtifacts = probe.final === null && probe.dataset === null;
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
          ? `設定負荷に対してクレジットが不足したため、原価割れを避けて安全停止し、全額返金されました。解像度・ステップ数・バッチを下げるか、投入クレジットを増やしてください。${
              hasPartialCkpts ? "中断時点までの中間チェックポイントはダウンロードできます。" : ""
            }`
          : job.refunded === true
            ? "消費したクレジットは全額返金されました。"
            : job.refunded === false
              ? "生YAML（カスタム設定）モードのため、消費したクレジットは返金されません。"
              : "返金状況を確認中です。"}
      </p>

      {(() => {
        const block = renderArtifactDownloads(artifactShow);
        if (block) return <div className="mt-3">{block}</div>;
        if (probingArtifacts) {
          return (
            <p className="mt-3 flex items-center gap-1.5 text-[10px] text-muted">
              <Loader2 size={11} className="animate-spin" />
              復旧可能な成果物を確認中…
            </p>
          );
        }
        return null;
      })()}

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
                    disabled={ckptDownloading.has(c.filename)}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {ckptDownloading.has(c.filename) ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Download size={11} />
                    )}
                    ⬇️ ダウンロード
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCkptCopyUrl(c.filename)}
                    disabled={copyingCkpt === c.filename}
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
