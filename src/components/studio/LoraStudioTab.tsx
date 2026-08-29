"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clapperboard,
  Cpu,
  ImagePlus,
  Loader2,
  LogIn,
  Sparkles,
  Trash2,
  Wand2,
  Zap,
} from "lucide-react";
import { LoginModal } from "@/components/LoginModal";
import { QueueStatusPanel } from "@/components/studio/QueueStatusPanel";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import {
  startLoraTraining,
  pollLoraJob,
  uploadLoraDataset,
  type LoraJobStatus,
  type LoraApiError,
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

const LORA_COST = 150;
const JOB_POLL_INTERVAL_MS = 3000;
const MAX_IMAGES = 200;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024; // 120 MB of raw image bytes

type Mode = "auto" | "semi" | "pro";

const MODES: { id: Mode; label: string; desc: string }[] = [
  { id: "auto", label: "⚡ 完全オート", desc: "画像・トリガー・モデルだけで一撃開始" },
  { id: "semi", label: "🛠️ セミオート", desc: "キャプションを確認・微調整してから学習" },
  { id: "pro", label: "🔬 エキスパート", desc: "Rank / LR / Steps や生 YAML を直接編集" },
];

const PRESET_GROUPS: LoraPresetGroup[] = ["video", "photo", "anime"];

const OPTIMIZERS = ["adamw8bit", "adamw", "prodigy", "adafactor", "lion8bit"];
const LORA_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

type DatasetImage = { id: string; file: File; url: string };

type ProConfig = {
  rank: number;
  alpha: number;
  learningRate: number;
  steps: number;
  optimizer: string;
  useRawYaml: boolean;
  rawYaml: string;
};

const DEFAULT_PRO: ProConfig = {
  rank: 32,
  alpha: 32,
  learningRate: 1e-4,
  steps: 2000,
  optimizer: "adamw8bit",
  useRawYaml: false,
  rawYaml: "",
};

type Phase = "form" | "starting" | "tracking";

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
        <p className="text-sm font-medium text-foreground">画像をドラッグ＆ドロップ / クリックで選択</p>
        <p className="text-[11px] text-muted">PNG・JPG・WEBP、複数可（推奨 15〜40 枚）</p>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
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
              <div key={img.id} className="group relative aspect-square overflow-hidden rounded-lg border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={img.file.name} className="h-full w-full object-cover" />
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

function ProgressPanel({
  job,
  onUseLora,
}: {
  job: LoraJobStatus | null;
  onUseLora?: (loraFilename: string) => void;
}) {
  if (!job) return null;

  if (job.status === "queued") {
    return (
      <div className="flex justify-center">
        <QueueStatusPanel phase="queued" queue={job.queue} />
      </div>
    );
  }

  if (job.status === "processing") {
    const pct = job.progressPercent ?? null;
    if (pct == null) {
      return (
        <div className="flex justify-center">
          <QueueStatusPanel phase="processing" queue={job.queue} />
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-neon-violet/30 bg-neon-violet/5 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-neon-violet">
          <Loader2 size={15} className="animate-spin" />
          深度最適化学習中… {pct}%
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-background/70">
          <div
            className="h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-violet transition-[width] duration-700"
            style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted">{job.progressMessage ?? "処理中…"}</p>
      </div>
    );
  }

  if (job.status === "completed") {
    const filename = job.resultPath ? job.resultPath.split("/").pop() ?? "" : "";
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
      </div>
    );
  }

  // failed
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-red-400">
        <AlertTriangle size={15} />
        学習に失敗しました
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-red-400/90">
        {job.errorMessage || "不明なエラーが発生しました。"}
        <br />
        消費したクレジット（{LORA_COST}）は自動的に返金されました。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function LoraStudioTab({ onUseLora }: { onUseLora?: (loraFilename: string) => void }) {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);

  const [mode, setMode] = useState<Mode>("auto");
  const [images, setImages] = useState<DatasetImage[]>([]);
  const [captions, setCaptions] = useState<Record<string, string>>({});
  // "__custom__" is the last option in the single model dropdown; anything
  // else is a preset id.
  const [modelChoice, setModelChoice] = useState<string>("minimax_h3");
  const [customModelId, setCustomModelId] = useState("");
  const [baseArchitecture, setBaseArchitecture] = useState<LoraBaseArchitecture>("sdxl");
  const [resolution, setResolution] = useState<LoraResolution>(DEFAULT_LORA_RESOLUTION);
  const [triggerWord, setTriggerWord] = useState("");
  const [loraName, setLoraName] = useState("");
  const [pro, setPro] = useState<ProConfig>(DEFAULT_PRO);

  const [phase, setPhase] = useState<Phase>("form");
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [job, setJob] = useState<LoraJobStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

  const pollCancelledRef = useRef(false);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      pollCancelledRef.current = true;
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
      images.forEach((i) => URL.revokeObjectURL(i.url));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const addImages = useCallback((incoming: FileList | File[]) => {
    const list = Array.from(incoming).filter((f) => /^image\/(png|jpe?g|webp)$/.test(f.type));
    setImages((prev) => {
      const next = [...prev];
      for (const file of list) {
        if (next.length >= MAX_IMAGES) break;
        next.push({ id: `${file.name}-${file.size}-${crypto.randomUUID()}`, file, url: URL.createObjectURL(file) });
      }
      return next;
    });
  }, []);

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
  }, []);

  const totalBytes = useMemo(() => images.reduce((s, i) => s + i.file.size, 0), [images]);
  const insufficientCredits = Boolean(user) && !creditsLoading && (credits ?? 0) < LORA_COST;

  const nameValid = LORA_NAME_RE.test(loraName.trim());
  const yamlMode = mode === "pro" && pro.useRawYaml;

  const isCustom = modelChoice === "__custom__";
  const customBlocked = isCustom && isBlockedLoraModel(customModelId);
  const customValid = isCustom && customModelId.trim().length >= 2 && !customBlocked;
  const modelValid = !isCustom || customValid;

  const targetModel = isCustom ? "custom" : modelChoice;

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
    nameValid &&
    modelValid &&
    (yamlMode ? pro.rawYaml.trim().length > 20 : true);

  const startPolling = useCallback((jobId: string) => {
    pollCancelledRef.current = false;
    const tick = async () => {
      if (pollCancelledRef.current) return;
      try {
        const next = await pollLoraJob(jobId);
        if (pollCancelledRef.current) return;
        setJob(next);
        if (next.status === "completed" || next.status === "failed") return;
      } catch (err) {
        console.error("[LoraStudioTab] poll failed:", err);
      }
      if (!pollCancelledRef.current) pollTimeoutRef.current = setTimeout(tick, JOB_POLL_INTERVAL_MS);
    };
    pollTimeoutRef.current = setTimeout(tick, JOB_POLL_INTERVAL_MS);
  }, []);

  const handleStart = async () => {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    if (insufficientCredits) {
      if (typeof window !== "undefined") window.location.hash = "pricing";
      return;
    }
    if (!canSubmit) return;

    setPhase("starting");
    setErrorMessage(null);
    setJob(null);
    setUploadProgress({ done: 0, total: images.length });

    try {
      // Upload straight to Supabase Storage — the /api/studio/lora/train
      // request then carries only the object paths (a few KB), so Vercel's
      // 4.5 MB body cap is never in play regardless of dataset size.
      const { paths } = await uploadLoraDataset(user.id, images.map((i) => i.file), (done, total) =>
        setUploadProgress({ done, total }),
      );
      const captionList =
        mode === "semi" ? images.map((img) => (captions[img.id] ?? "").trim()) : [];

      const trainingConfig = yamlMode
        ? { custom_yaml_override: pro.rawYaml }
        : mode === "pro"
          ? {
              rank: pro.rank,
              alpha: pro.alpha,
              learning_rate: pro.learningRate,
              steps: pro.steps,
              optimizer: pro.optimizer,
            }
          : {};

      const { jobId, remainingCredits } = await startLoraTraining({
        storagePaths: paths,
        captions: captionList,
        targetModel,
        customModelId: isCustom ? customModelId.trim() : undefined,
        baseArchitecture: isCustom ? baseArchitecture : undefined,
        trainingConfig,
        resolution,
        outputLoraName: loraName.trim(),
        triggerWord: triggerWord.trim(),
      });
      broadcastCreditsUpdate(user.id, remainingCredits);
      setJob({
        jobId,
        status: "queued",
        errorMessage: null,
        resultPath: null,
        progressPercent: 0,
        progressMessage: "queued",
        queue: null,
      });
      setPhase("tracking");
      startPolling(jobId);
    } catch (err) {
      const e = err as LoraApiError;
      setErrorMessage(e.message || "LoRA学習の開始に失敗しました。");
      setPhase("form");
      setUploadProgress(null);
      if (typeof e.remainingCredits === "number" && user) broadcastCreditsUpdate(user.id, e.remainingCredits);
    }
  };

  const resetForm = () => {
    pollCancelledRef.current = true;
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    setPhase("form");
    setJob(null);
    setErrorMessage(null);
    setUploadProgress(null);
  };

  const busy = phase !== "form";

  return (
    <div data-source-file="src/components/studio/LoraStudioTab.tsx" className="space-y-6">
      {/* Mode switch */}
      <div className="grid gap-2 sm:grid-cols-3">
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

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        {/* Left column — dataset + captions */}
        <div className="space-y-4 rounded-2xl border-gradient bg-surface/40 p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
            <ImagePlus size={15} className="text-neon-violet" />
            学習データセット
          </h3>
          <ImageDropzone images={images} onAdd={addImages} onRemove={removeImage} disabled={busy} />

          {mode === "semi" && images.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] text-muted">
                各画像のキャプションを微調整できます。<span className="text-neon-violet">空欄の画像は自動でタグ付け</span>されます（構図タグと部位タグは分離されます）。
              </p>
              <div className="grid max-h-80 gap-2 overflow-y-auto pr-1">
                {images.map((img) => (
                  <div key={img.id} className="flex gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.url} alt="" className="h-14 w-14 shrink-0 rounded-md border border-border object-cover" />
                    <textarea
                      value={captions[img.id] ?? ""}
                      onChange={(e) => setCaptions((prev) => ({ ...prev, [img.id]: e.target.value }))}
                      placeholder="(空欄 = 自動キャプション)"
                      rows={2}
                      disabled={busy}
                      className={`${fieldCls} resize-none font-mono text-xs`}
                    />
                  </div>
                ))}
              </div>
            </div>
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
              value={loraName}
              onChange={(e) => setLoraName(e.target.value)}
              placeholder="yukipas_h3"
              disabled={busy}
              className={`${fieldCls} font-mono ${loraName && !nameValid ? "border-red-500/50" : ""}`}
            />
            {loraName && !nameValid && (
              <p className="mt-1 text-[10px] text-red-400">英数字・ハイフン・アンダースコア・ドットのみ（64文字以内）</p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted">トリガーワード（任意）</label>
            <input
              value={triggerWord}
              onChange={(e) => setTriggerWord(e.target.value)}
              placeholder="yukipas（空欄なら LoRA 名から自動）"
              disabled={busy}
              className={`${fieldCls} font-mono`}
            />
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

          {mode === "pro" && (
            <div className="space-y-3 rounded-xl border border-neon-pink/30 bg-neon-pink/5 p-3">
              <label className="flex items-center gap-2 text-[11px] font-medium text-neon-pink">
                <input
                  type="checkbox"
                  checked={pro.useRawYaml}
                  onChange={(e) => setPro((p) => ({ ...p, useRawYaml: e.target.checked }))}
                  disabled={busy}
                  className="h-3.5 w-3.5 accent-neon-pink"
                />
                生 YAML を直接編集（学習ジョブ設定）
              </label>

              {pro.useRawYaml ? (
                <textarea
                  value={pro.rawYaml}
                  onChange={(e) => setPro((p) => ({ ...p, rawYaml: e.target.value }))}
                  rows={12}
                  disabled={busy}
                  placeholder={"job: extension\nconfig:\n  name: my_lora\n  process:\n    - type: sd_trainer\n      ..."}
                  className={`${fieldCls} resize-y font-mono text-[11px]`}
                />
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["rank", "Rank", 1, 256, 1],
                      ["alpha", "Alpha", 1, 256, 1],
                      ["steps", "Steps", 200, 6000, 50],
                    ] as const
                  ).map(([key, label, min, max, step]) => (
                    <div key={key}>
                      <label className="mb-1 block text-[10px] text-muted">{label}</label>
                      <input
                        type="number"
                        min={min}
                        max={max}
                        step={step}
                        value={pro[key]}
                        onChange={(e) => setPro((p) => ({ ...p, [key]: Number(e.target.value) || p[key] }))}
                        disabled={busy}
                        className={fieldCls}
                      />
                    </div>
                  ))}
                  <div>
                    <label className="mb-1 block text-[10px] text-muted">Learning Rate</label>
                    <input
                      type="number"
                      step="0.00001"
                      value={pro.learningRate}
                      onChange={(e) => setPro((p) => ({ ...p, learningRate: Number(e.target.value) || p.learningRate }))}
                      disabled={busy}
                      className={fieldCls}
                    />
                  </div>
                  <div className="col-span-2">
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

          {/* Credits */}
          <div className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2 text-xs">
            <span className="flex items-center gap-1.5 text-neon-pink">
              <Zap size={13} />
              {LORA_COST} Credits
            </span>
            <span className="text-muted">
              保有: {creditsLoading ? "…" : (credits ?? 0)}
            </span>
          </div>
          {insufficientCredits && (
            <a
              href="#pricing"
              className="flex items-center justify-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-400"
            >
              <Zap size={13} />
              クレジットが不足しています — チャージする
            </a>
          )}
        </div>
      </div>

      {/* Action / tracking */}
      {phase === "form" ? (
        <div className="space-y-3">
          {errorMessage && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {errorMessage}
            </p>
          )}
          <button
            type="button"
            onClick={handleStart}
            disabled={Boolean(user) && !insufficientCredits && !canSubmit}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {!user ? (
              <>
                <LogIn size={16} />
                ログインして学習を開始
              </>
            ) : insufficientCredits ? (
              <>
                <Zap size={16} />
                クレジットをチャージ
              </>
            ) : (
              <>
                <Wand2 size={16} />
                {`🔥 高速 LoRA 学習を開始する (${LORA_COST} C)`}
              </>
            )}
          </button>
          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted">
            <Sparkles size={13} className="mt-0.5 shrink-0 text-neon-violet" />
            独自の超高速パイプラインで自動キャプション →
            深度最適化学習（所要 約10〜20分）。処理中にページを離れても学習はバックグラウンドで継続し、後からいつでも結果を確認できます。
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {phase === "starting" && (
            <div className="rounded-xl border border-neon-violet/30 bg-neon-violet/5 p-4">
              <div className="flex items-center gap-2 text-sm text-neon-violet">
                <Loader2 size={15} className="animate-spin" />
                {uploadProgress && uploadProgress.done < uploadProgress.total
                  ? `画像をアップロード中… ${uploadProgress.done}/${uploadProgress.total}`
                  : "学習ジョブを起動しています…"}
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
          <ProgressPanel job={job} onUseLora={onUseLora} />
          {job && (job.status === "completed" || job.status === "failed") && (
            <button
              type="button"
              onClick={resetForm}
              className="rounded-lg border border-border px-4 py-2 text-xs text-muted transition-colors hover:text-foreground"
            >
              新しい LoRA を学習する
            </button>
          )}
        </div>
      )}

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        message="LoRA Studio でキャラクター学習を行うにはログインしてください。"
      />
    </div>
  );
}
