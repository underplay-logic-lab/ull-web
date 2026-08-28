"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronDown, Download, Film, Layers, Loader2, LogIn, Settings2, Wand2, Zap } from "lucide-react";
import {
  calculateTotalWorkflowCredits,
  sortFieldsByOrder,
  type PublicCustomWorkflow,
  type WorkflowInputField,
} from "@/lib/customWorkflows";
import { defaultValueFor, type FieldValue } from "@/components/studio/workflow/DynamicField";
import { WorkflowFieldGrid } from "@/components/studio/workflow/WorkflowFieldGrid";
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

// Persisted per-workflow (by slug) form state — File values (images/videos)
// are never included since browsers can't restore an actual File from
// storage; only text/slider/toggle values survive a reload.
type PersistedCustomWorkflowForm = {
  values: Record<string, string | number | boolean>;
  gpuTier: GpuTier;
};

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
  // PersistedCustomWorkflowForm). Debounced so a slider drag doesn't write
  // localStorage on every frame.
  useEffect(() => {
    if (!selectedSlug) return;
    const t = setTimeout(() => {
      const serializableValues: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          serializableValues[key] = value;
        }
      }
      const state: PersistedCustomWorkflowForm = { values: serializableValues, gpuTier };
      saveFormState(selectedSlug, state);
    }, 400);
    return () => clearTimeout(t);
  }, [selectedSlug, values, gpuTier]);

  // Stable so the memoized field components don't all re-render on every edit.
  const handleFieldChange = useCallback((fieldId: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  }, []);

  // Layout: named `sections` (from the builder) split fields into titled
  // bands; `sectionId` wins over the legacy main/advanced flag. Anything
  // without a valid sectionId and not marked "advanced" is the base band.
  const namedSections = useMemo(
    () => selectedWorkflow?.sections ?? [],
    [selectedWorkflow],
  );
  const { baseFields, sectionFieldMap, advancedFields } = useMemo(() => {
    const map = new Map<string, WorkflowInputField[]>();
    const base: WorkflowInputField[] = [];
    const advanced: WorkflowInputField[] = [];
    if (selectedWorkflow) {
      const sectionIds = new Set(namedSections.map((s) => s.id));
      for (const f of selectedWorkflow.input_schema) {
        if (f.sectionId && sectionIds.has(f.sectionId)) {
          const arr = map.get(f.sectionId) ?? [];
          arr.push(f);
          map.set(f.sectionId, arr);
        } else if (f.section === "advanced") {
          advanced.push(f);
        } else {
          base.push(f);
        }
      }
    }
    for (const [k, v] of map) map.set(k, sortFieldsByOrder(v));
    return {
      baseFields: sortFieldsByOrder(base),
      sectionFieldMap: map,
      advancedFields: sortFieldsByOrder(advanced),
    };
  }, [selectedWorkflow, namedSections]);

  // Live total via the shared engine (base / base-override + Σ add-ons +
  // GPU tier) — the server re-derives the same number on generate.
  const ultraAddon = gpuTier === "ultra" ? gpuTierAddon : 0;
  const totalCredits = useMemo(() => {
    if (!selectedWorkflow) return 0;
    return calculateTotalWorkflowCredits({
      creditsCost: selectedWorkflow.credits_cost,
      inputSchema: selectedWorkflow.input_schema,
      values: Object.fromEntries(
        selectedWorkflow.input_schema.map((f) => [f.id, values[f.id] ?? defaultValueFor(f)]),
      ),
      gpuTierAddon: ultraAddon,
    });
  }, [selectedWorkflow, values, ultraAddon]);
  // For the button's "（基本X + オプションY）" breakdown only.
  const extraCredits = Math.max(0, totalCredits - (selectedWorkflow?.credits_cost ?? 0) - ultraAddon);

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
              <div className="flex flex-wrap items-center gap-2">
                <Layers size={16} className="shrink-0 text-neon-violet" />
                <span className="font-medium text-foreground">{workflow.title}</span>
                {workflow.gpu_badge_label && workflow.gpu_badge_label.trim() && (
                  <span className="rounded-full border border-neon-pink/40 bg-neon-pink/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-neon-pink">
                    {workflow.gpu_badge_label}
                  </span>
                )}
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
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-bold text-foreground">{selectedWorkflow.title}</h3>
          {selectedWorkflow.gpu_badge_label && selectedWorkflow.gpu_badge_label.trim() && (
            <span className="rounded-full border border-neon-pink/40 bg-neon-pink/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-neon-pink">
              {selectedWorkflow.gpu_badge_label}
            </span>
          )}
        </div>
        {selectedWorkflow.description && (
          <p className="mt-1 text-sm text-muted">{selectedWorkflow.description}</p>
        )}
      </div>

      <div className="flex flex-col gap-5">
        {namedSections.length > 0 && baseFields.length > 0 ? (
          <div className="rounded-xl border border-border/70 bg-surface/20 p-4">
            <p className="mb-3 text-xs font-semibold text-neon-violet">基本設定</p>
            <WorkflowFieldGrid fields={baseFields} values={values} onChange={handleFieldChange} />
          </div>
        ) : (
          <WorkflowFieldGrid fields={baseFields} values={values} onChange={handleFieldChange} />
        )}

        {namedSections.map((section) => {
          const sf = sectionFieldMap.get(section.id) ?? [];
          if (sf.length === 0) return null;
          return (
            <div key={section.id} className="rounded-xl border border-border/70 bg-surface/20 p-4">
              <p className="text-xs font-semibold text-neon-violet">{section.label}</p>
              {section.description && (
                <p className="mb-3 mt-0.5 text-[11px] leading-relaxed text-muted">{section.description}</p>
              )}
              <div className={section.description ? "" : "mt-3"}>
                <WorkflowFieldGrid fields={sf} values={values} onChange={handleFieldChange} />
              </div>
            </div>
          );
        })}

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
              <div className="border-t border-border p-4">
                <WorkflowFieldGrid
                  fields={advancedFields}
                  values={values}
                  onChange={handleFieldChange}
                />
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
