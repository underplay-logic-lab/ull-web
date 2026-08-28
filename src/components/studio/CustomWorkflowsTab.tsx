"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, Film, Layers, Loader2, LogIn, Wand2, Zap } from "lucide-react";
import { calculateTotalWorkflowCredits, type PublicCustomWorkflow } from "@/lib/customWorkflows";
import { defaultValueFor, type FieldValue } from "@/components/studio/workflow/DynamicField";
import { WorkflowFieldLayout } from "@/components/studio/workflow/WorkflowFieldLayout";
import { generateCustomWorkflow } from "@/lib/customWorkflowApi";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { LoginModal } from "@/components/LoginModal";
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
};

export function CustomWorkflowsTab() {
  const { user } = useSupabaseUser();
  const { credits, tier, loading: creditsLoading } = useProfileCredits(user);
  const userTier = user ? (tier ?? "free") : "free";

  const [workflows, setWorkflows] = useState<PublicCustomWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
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
  }, []);

  const selectedWorkflow = useMemo(
    () => workflows.find((w) => w.slug === selectedSlug) ?? null,
    [workflows, selectedSlug],
  );

  const selectWorkflow = (workflow: PublicCustomWorkflow) => {
    setSelectedSlug(workflow.slug);
    setNotice(null);
    setStatus("idle");
    setResultUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    setResultKind(null);
    setDownloadFilename(null);
    setErrorMessage(null);

    const saved = loadFormState<PersistedCustomWorkflowForm>(workflow.slug);
    setValues(
      Object.fromEntries(
        workflow.input_schema.map((f) => [
          f.id,
          saved?.values && f.id in saved.values ? saved.values[f.id] : defaultValueFor(f),
        ]),
      ),
    );
  };

  // Auto-save text/slider/toggle inputs per workflow slug — File values are
  // excluded (see PersistedCustomWorkflowForm). Debounced so a slider drag
  // doesn't write localStorage on every frame.
  useEffect(() => {
    if (!selectedSlug) return;
    const t = setTimeout(() => {
      const serializableValues: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          serializableValues[key] = value;
        }
      }
      saveFormState(selectedSlug, { values: serializableValues } satisfies PersistedCustomWorkflowForm);
    }, 400);
    return () => clearTimeout(t);
  }, [selectedSlug, values]);

  // Stable so the memoized field components don't all re-render on every edit.
  const handleFieldChange = useCallback((fieldId: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  }, []);

  const handleLockedInteract = useCallback(() => {
    setNotice("この項目は上位プラン限定です。プランをアップグレードするとご利用いただけます。");
    // Studio lives on "/", so a hash change scrolls to the Pricing section.
    if (typeof window !== "undefined") window.location.hash = "pricing";
  }, []);

  // Live total via the shared engine (base / base-override + Σ add-ons).
  const totalCredits = useMemo(() => {
    if (!selectedWorkflow) return 0;
    return calculateTotalWorkflowCredits({
      creditsCost: selectedWorkflow.credits_cost,
      inputSchema: selectedWorkflow.input_schema,
      values: Object.fromEntries(
        selectedWorkflow.input_schema.map((f) => [f.id, values[f.id] ?? defaultValueFor(f)]),
      ),
    });
  }, [selectedWorkflow, values]);
  const extraCredits = Math.max(0, totalCredits - (selectedWorkflow?.credits_cost ?? 0));

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
      const result = await generateCustomWorkflow({ slug: selectedWorkflow.slug, values });
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
        <WorkflowFieldLayout
          fields={selectedWorkflow.input_schema}
          sections={selectedWorkflow.sections ?? []}
          values={values}
          userTier={userTier}
          onChange={handleFieldChange}
          onLockedInteract={handleLockedInteract}
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
              <Wand2 size={16} />⚡ {totalCredits} クレジットで生成
              {extraCredits > 0 && (
                <span className="font-mono text-xs opacity-80">
                  （基本{selectedWorkflow.credits_cost} + オプション{extraCredits}）
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
              生成中...
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
