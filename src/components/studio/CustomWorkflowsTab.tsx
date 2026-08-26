"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  Download,
  Film,
  ImagePlus,
  Layers,
  Loader2,
  LogIn,
  RefreshCw,
  Settings2,
  Trash2,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import {
  fieldAppliesCreditsAdd,
  sortFieldsByOrder,
  type PublicCustomWorkflow,
  type WorkflowInputField,
} from "@/lib/customWorkflows";
import { WAN_ANIMATE_GPU_ULTRA_ADDON } from "@/lib/data";
import { GPU_TIER_ADDON_PRICING_KEY, type GpuTier } from "@/lib/gpuTier";
import { generateCustomWorkflow } from "@/lib/customWorkflowApi";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { LoginModal } from "@/components/LoginModal";
import { GpuTierSelector } from "@/components/studio/GpuTierSelector";
import { GpuWarmStokeWidget } from "@/components/studio/GpuWarmStokeWidget";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useElapsedTimer, formatElapsedSeconds } from "@/hooks/useElapsedTimer";

type Status = "idle" | "loading" | "done" | "error";

type FieldValue = string | number | boolean | File | null;

// Persisted per-workflow (by slug) form state — File values (images/videos)
// are never included since browsers can't restore an actual File from
// storage; only text/slider/toggle values survive a reload.
type PersistedCustomWorkflowForm = {
  values: Record<string, string | number | boolean>;
  gpuTier: GpuTier;
};

function defaultValueFor(field: WorkflowInputField): FieldValue {
  if (field.type === "image" || field.type === "video") return null;
  if (field.type === "toggle") return typeof field.default === "boolean" ? field.default : false;
  if (field.type === "slider") {
    if (typeof field.default === "number") return field.default;
    return field.min ?? 0;
  }
  return typeof field.default === "string" ? field.default : "";
}

function ImageDropzone({
  file,
  onFileSelected,
  onClear,
}: {
  file: File | null;
  onFileSelected: (file: File) => void;
  onClear: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFiles = (files: FileList | null) => {
    const picked = files?.[0];
    if (picked) onFileSelected(picked);
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
        className={`relative flex min-h-[160px] cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-dashed p-4 text-center transition-colors ${
          isDragging ? "border-neon-pink/70 bg-neon-pink/10" : "border-border bg-background hover:border-neon-violet/40"
        }`}
      >
        {previewUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt={file?.name ?? "アップロード画像"} className="absolute inset-0 h-full w-full object-cover" />
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
            <ImagePlus size={24} className="text-muted" />
            <p className="text-xs text-muted">ドラッグ＆ドロップ、またはクリックして選択</p>
          </>
        )}
      </div>
    </div>
  );
}

const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm";

function VideoDropzone({
  file,
  onFileSelected,
  onClear,
}: {
  file: File | null;
  onFileSelected: (file: File) => void;
  onClear: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFiles = (files: FileList | null) => {
    const picked = files?.[0];
    if (picked) onFileSelected(picked);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept={VIDEO_ACCEPT}
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {file && previewUrl ? (
        <div className="rounded-xl border border-border bg-background p-2">
          {/* Immediate inline playback preview of the selected video. */}
          <video controls src={previewUrl} className="max-h-56 w-full rounded-lg bg-black" />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{file.name}</span>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
              >
                <RefreshCw size={11} />
                選び直す
              </button>
              <button
                type="button"
                onClick={onClear}
                className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-red-400/50 hover:text-red-400"
              >
                <Trash2 size={11} />
                削除
              </button>
            </div>
          </div>
        </div>
      ) : (
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
          className={`flex min-h-[160px] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-center transition-colors ${
            isDragging ? "border-neon-pink/70 bg-neon-pink/10" : "border-border bg-background hover:border-neon-violet/40"
          }`}
        >
          <Film size={24} className="text-muted" />
          <p className="text-xs text-muted">ドラッグ＆ドロップ、またはクリックして選択</p>
          <p className="text-[10px] text-muted/70">MP4 / MOV / WebM</p>
        </div>
      )}
    </div>
  );
}

function DynamicField({
  field,
  value,
  onChange,
}: {
  field: WorkflowInputField;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
}) {
  if (field.type === "image") {
    return (
      <ImageDropzone
        file={value instanceof File ? value : null}
        onFileSelected={onChange}
        onClear={() => onChange(null)}
      />
    );
  }

  if (field.type === "video") {
    return (
      <VideoDropzone
        file={value instanceof File ? value : null}
        onFileSelected={onChange}
        onClear={() => onChange(null)}
      />
    );
  }

  if (field.type === "slider") {
    const min = field.min ?? 0;
    const max = field.max ?? 1;
    const step = field.step ?? 0.01;
    const numeric = typeof value === "number" ? value : min;
    return (
      <div>
        <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
          <span>{min}</span>
          <span className="font-mono text-foreground">{numeric}</span>
          <span>{max}</span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={numeric}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full accent-neon-pink"
        />
      </div>
    );
  }

  if (field.type === "toggle") {
    const checked = value === true;
    return (
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
          checked ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink" : "border-border bg-background text-muted"
        }`}
      >
        <span className={`h-2 w-2 rounded-full ${checked ? "bg-neon-pink" : "bg-muted"}`} />
        {checked ? "ON" : "OFF"}
      </button>
    );
  }

  return (
    <textarea
      rows={3}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      className="w-full resize-none rounded-lg border border-border bg-background px-4 py-3 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
    />
  );
}

function FieldRow({
  field,
  value,
  applied,
  onChange,
}: {
  field: WorkflowInputField;
  value: FieldValue;
  applied: boolean;
  onChange: (value: FieldValue) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <label className="text-xs font-medium text-muted">{field.label}</label>
        {Boolean(field.credits_add) && (
          <span
            className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ${
              applied ? "bg-neon-pink/20 text-neon-pink" : "bg-border text-muted"
            }`}
          >
            +{field.credits_add}C
          </span>
        )}
      </div>
      <DynamicField field={field} value={value} onChange={onChange} />
    </div>
  );
}

export function CustomWorkflowsTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);

  const [workflows, setWorkflows] = useState<PublicCustomWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pricing, setPricing] = useState<Record<string, number>>({});
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [gpuTier, setGpuTier] = useState<GpuTier>("standard");
  const [loginOpen, setLoginOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [status, setStatus] = useState<Status>("idle");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultKind, setResultKind] = useState<"image" | "video" | null>(null);
  const [downloadFilename, setDownloadFilename] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const elapsedMs = useElapsedTimer(status === "loading");

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/studio/custom-workflows");
        const data = await res.json();
        if (res.ok) {
          setWorkflows(data.workflows as PublicCustomWorkflow[]);
        } else {
          console.error("[CustomWorkflowsTab] failed to load workflows:", data?.error);
        }
      } catch (err) {
        console.error("[CustomWorkflowsTab] failed to load workflows:", err);
      } finally {
        setLoading(false);
      }
    })();

    (async () => {
      try {
        const res = await fetch("/api/studio/pricing");
        const data = await res.json();
        if (res.ok) {
          setPricing(data.pricing as Record<string, number>);
        } else {
          console.error("[CustomWorkflowsTab] failed to load pricing:", data?.error);
        }
      } catch (err) {
        console.error("[CustomWorkflowsTab] failed to load pricing:", err);
      }
    })();
  }, []);

  const gpuTierAddon = pricing[GPU_TIER_ADDON_PRICING_KEY] ?? WAN_ANIMATE_GPU_ULTRA_ADDON;

  const selectedWorkflow = useMemo(
    () => workflows.find((w) => w.slug === selectedSlug) ?? null,
    [workflows, selectedSlug],
  );

  const [advancedOpen, setAdvancedOpen] = useState(false);

  const selectWorkflow = (workflow: PublicCustomWorkflow) => {
    setSelectedSlug(workflow.slug);
    setNotice(null);
    setAdvancedOpen(false);
    setStatus("idle");
    setResultUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    setResultKind(null);
    setDownloadFilename(null);
    setErrorMessage(null);

    const saved = loadFormState<PersistedCustomWorkflowForm>(workflow.slug);
    setGpuTier(saved?.gpuTier === "ultra" ? "ultra" : "standard");
    setValues(
      Object.fromEntries(
        workflow.input_schema.map((f) => [
          f.id,
          saved?.values && f.id in saved.values ? saved.values[f.id] : defaultValueFor(f),
        ]),
      ),
    );
  };

  // Auto-save text/slider/toggle inputs + GPU tier per workflow slug —
  // image/video File values are intentionally excluded (see
  // PersistedCustomWorkflowForm).
  useEffect(() => {
    if (!selectedSlug) return;
    const serializableValues: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        serializableValues[key] = value;
      }
    }
    const state: PersistedCustomWorkflowForm = { values: serializableValues, gpuTier };
    saveFormState(selectedSlug, state);
  }, [selectedSlug, values, gpuTier]);

  const mainFields = useMemo(
    () =>
      selectedWorkflow
        ? sortFieldsByOrder(selectedWorkflow.input_schema.filter((f) => (f.section ?? "main") === "main"))
        : [],
    [selectedWorkflow],
  );
  const advancedFields = useMemo(
    () =>
      selectedWorkflow
        ? sortFieldsByOrder(selectedWorkflow.input_schema.filter((f) => f.section === "advanced"))
        : [],
    [selectedWorkflow],
  );

  // Base credits_cost plus every field's credits_add whose current value
  // counts as "selected" per fieldAppliesCreditsAdd() — recalculated live
  // as the user changes any option.
  const extraCredits = useMemo(() => {
    if (!selectedWorkflow) return 0;
    return selectedWorkflow.input_schema.reduce((sum, field) => {
      const value = values[field.id] ?? defaultValueFor(field);
      return sum + (fieldAppliesCreditsAdd(field, value) ? (field.credits_add ?? 0) : 0);
    }, 0);
  }, [selectedWorkflow, values]);
  const totalCredits = (selectedWorkflow?.credits_cost ?? 0) + extraCredits + (gpuTier === "ultra" ? gpuTierAddon : 0);

  const insufficientCredits =
    Boolean(user) && !creditsLoading && selectedWorkflow !== null && (credits ?? 0) < totalCredits;

  const missingRequiredFile = useMemo(() => {
    if (!selectedWorkflow) return false;
    return selectedWorkflow.input_schema.some(
      (f) => (f.type === "image" || f.type === "video") && !(values[f.id] instanceof File),
    );
  }, [selectedWorkflow, values]);

  const handleGenerate = async () => {
    if (!selectedWorkflow || status === "loading") return;
    if (!user) {
      setLoginOpen(true);
      return;
    }
    if (insufficientCredits) {
      setNotice("クレジットが不足しています。チャージしてから再度お試しください。");
      return;
    }

    setNotice(null);
    setStatus("loading");
    setErrorMessage(null);
    setResultUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });

    try {
      const result = await generateCustomWorkflow({
        slug: selectedWorkflow.slug,
        gpuTier,
        values,
      });
      setResultUrl(result.resultUrl);
      setResultKind(result.outputKind);
      setDownloadFilename(`custom_workflow_${Date.now()}.${result.outputKind === "video" ? "mp4" : "png"}`);
      setStatus("done");
      broadcastCreditsUpdate(user.id, result.remainingCredits);
    } catch (err) {
      console.error("[CustomWorkflowsTab] generation failed:", err);
      setErrorMessage(err instanceof Error ? err.message : "生成に失敗しました。");
      setStatus("error");

      const remainingCredits = (err as { remainingCredits?: number })?.remainingCredits;
      if (typeof remainingCredits === "number") {
        broadcastCreditsUpdate(user.id, remainingCredits);
      }
    }
  };

  if (loading) {
    return (
      <div
        data-source-file="src/components/studio/CustomWorkflowsTab.tsx"
        className="flex items-center justify-center gap-2 rounded-2xl border-gradient bg-surface/40 py-20 text-sm text-muted"
      >
        <Loader2 size={18} className="animate-spin" />
        読み込み中...
      </div>
    );
  }

  if (workflows.length === 0) {
    return (
      <div
        data-source-file="src/components/studio/CustomWorkflowsTab.tsx"
        className="flex flex-col items-center justify-center gap-3 rounded-2xl border-gradient bg-surface/40 px-6 py-20 text-center"
      >
        <Layers size={32} className="text-muted opacity-50" />
        <p className="text-sm font-medium text-foreground">特化ワークフローは近日公開予定です</p>
        <p className="max-w-md text-xs leading-relaxed text-muted">
          管理者が専用ワークフローを登録すると、ここに動的なUIとして表示されます。
        </p>
      </div>
    );
  }

  if (!selectedWorkflow) {
    return (
      <div
        data-source-file="src/components/studio/CustomWorkflowsTab.tsx"
        className="rounded-2xl border-gradient bg-surface/40 p-6 sm:p-8"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workflows.map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              onClick={() => selectWorkflow(workflow)}
              className="flex flex-col gap-2 rounded-xl border border-border bg-background p-4 text-left transition-colors hover:border-neon-violet/50"
            >
              <div className="flex items-center gap-2">
                <Layers size={16} className="shrink-0 text-neon-violet" />
                <span className="font-medium text-foreground">{workflow.title}</span>
              </div>
              {workflow.description && (
                <p className="line-clamp-2 text-xs leading-relaxed text-muted">{workflow.description}</p>
              )}
              <div className="mt-auto flex items-center justify-between pt-2">
                <span className="rounded-full bg-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                  {workflow.category}
                </span>
                <span className="font-mono text-[11px] text-neon-pink">{workflow.credits_cost} credits</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      data-source-file="src/components/studio/CustomWorkflowsTab.tsx"
      className="rounded-2xl border-gradient bg-surface/40 p-6 sm:p-8"
    >
      <button
        type="button"
        onClick={() => setSelectedSlug(null)}
        className="mb-6 flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft size={14} />
        ワークフロー一覧に戻る
      </button>

      <div className="mb-6">
        <h3 className="text-lg font-bold text-foreground">{selectedWorkflow.title}</h3>
        {selectedWorkflow.description && (
          <p className="mt-1 text-sm text-muted">{selectedWorkflow.description}</p>
        )}
      </div>

      <div className="flex flex-col gap-5">
        {mainFields.map((field) => (
          <FieldRow
            key={field.id}
            field={field}
            value={values[field.id] ?? defaultValueFor(field)}
            applied={fieldAppliesCreditsAdd(field, values[field.id] ?? defaultValueFor(field))}
            onChange={(value) => setValues((prev) => ({ ...prev, [field.id]: value }))}
          />
        ))}

        {advancedFields.length > 0 && (
          <div className="rounded-xl border border-border">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-xs font-medium text-muted transition-colors hover:text-foreground"
            >
              <span className="flex items-center gap-1.5">
                <Settings2 size={14} />
                詳細設定
              </span>
              <ChevronDown
                size={14}
                className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`}
              />
            </button>
            {advancedOpen && (
              <div className="flex flex-col gap-5 border-t border-border p-4">
                {advancedFields.map((field) => (
                  <FieldRow
                    key={field.id}
                    field={field}
                    value={values[field.id] ?? defaultValueFor(field)}
                    applied={fieldAppliesCreditsAdd(field, values[field.id] ?? defaultValueFor(field))}
                    onChange={(value) => setValues((prev) => ({ ...prev, [field.id]: value }))}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <GpuTierSelector
          value={gpuTier}
          onChange={setGpuTier}
          baseCost={selectedWorkflow.credits_cost + extraCredits}
          addonCost={gpuTierAddon}
        />

        <GpuWarmStokeWidget />

        <button
          type="button"
          onClick={handleGenerate}
          disabled={missingRequiredFile || status === "loading"}
          className={`flex items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-sm font-semibold text-white transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
            insufficientCredits
              ? "bg-amber-600/80 hover:opacity-90"
              : "bg-gradient-to-r from-neon-pink to-neon-violet hover:opacity-90 glow-pink"
          }`}
        >
          {status === "loading" ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              生成中... {formatElapsedSeconds(elapsedMs)}s
            </>
          ) : !user ? (
            <>
              <LogIn size={16} />
              ログインして生成
            </>
          ) : (
            <>
              <Wand2 size={16} />
              {totalCredits} クレジットで生成
              {(extraCredits > 0 || gpuTier === "ultra") && (
                <span className="font-mono text-xs opacity-80">
                  （基本{selectedWorkflow.credits_cost}
                  {extraCredits > 0 && ` + オプション${extraCredits}`}
                  {gpuTier === "ultra" && ` + ULTRA${gpuTierAddon}`}）
                </span>
              )}
            </>
          )}
        </button>

        {notice && (
          <p className="-mt-2 rounded-lg border border-neon-violet/30 bg-neon-violet/10 px-3 py-2 text-xs leading-relaxed text-neon-violet">
            {notice}
          </p>
        )}

        {status === "error" && errorMessage && (
          <p className="-mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {errorMessage}
          </p>
        )}

        {status === "done" && resultUrl && (
          <div className="flex flex-col gap-3">
            <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-background">
              {resultKind === "video" ? (
                <video src={resultUrl} controls autoPlay loop playsInline className="h-full w-full object-contain" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={resultUrl} alt="生成結果" className="h-full w-full object-contain" />
              )}
            </div>
            <p className="text-center font-mono text-xs text-muted">
              ⚡ 生成完了（所要時間: {formatElapsedSeconds(elapsedMs)}秒）
            </p>
            <a
              href={resultUrl}
              download={downloadFilename ?? `custom_workflow.${resultKind === "video" ? "mp4" : "png"}`}
              className="flex items-center justify-center gap-2 rounded-xl border border-border bg-surface/60 px-6 py-3 text-sm font-medium text-foreground transition-colors hover:border-neon-pink/50 hover:bg-surface-hover"
            >
              <Download size={16} />
              Download
            </a>
          </div>
        )}

        {status === "loading" && (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-background py-10 text-xs text-muted">
            <div className="flex items-center gap-2">
              <Film size={16} className="opacity-40" />
              <Zap size={12} className="text-neon-pink" />
              生成中... GPU: {gpuTier === "ultra" ? "NVIDIA B300 (ULTRA)" : "NVIDIA L40S (Standard)"}
            </div>
            <span className="font-mono text-[11px] font-medium text-neon-pink">
              ⏳ {formatElapsedSeconds(elapsedMs)}s
            </span>
          </div>
        )}
      </div>

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        message="特化ワークフローを利用するにはログインしてください。"
      />
    </div>
  );
}
