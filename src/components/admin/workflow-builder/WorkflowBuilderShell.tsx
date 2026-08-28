"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Eye, Loader2, Monitor, Save, Smartphone, Zap } from "lucide-react";
import {
  DEFAULT_WORKFLOW_GPU_TIER,
  SYSTEM_FIELD_GPU_TIER,
  WORKFLOW_FIELD_TIERS,
  WORKFLOW_FIELD_TIER_LABELS,
  WORKFLOW_GPU_TIERS,
  makeGpuTierField,
  workflowCreditsBreakdown,
  type StudioCustomWorkflow,
  type WorkflowGpuTier,
  type WorkflowInputField,
  type WorkflowSection,
} from "@/lib/customWorkflows";
import { parseWorkflowNodes, type WorkflowNodeInfo } from "@/lib/workflowGraph";
import { buildModelSizeIndex, estimateWorkflowModelVram } from "@/lib/modelVram";
import { defaultValueFor, type FieldValue } from "@/components/studio/workflow/DynamicField";
import { fieldFromNodeInput, makeFieldId, renumberOrder } from "@/components/admin/workflow-builder/builder";
import { NodeTreePane } from "@/components/admin/workflow-builder/panes/NodeTreePane";
import { LiveCanvasPane, type PreviewMode } from "@/components/admin/workflow-builder/panes/LiveCanvasPane";
import { ParameterInspectorPane } from "@/components/admin/workflow-builder/panes/ParameterInspectorPane";

export function WorkflowBuilderShell({ workflowId }: { workflowId: string }) {
  const [workflow, setWorkflow] = useState<StudioCustomWorkflow | null>(null);
  const [fields, setFields] = useState<WorkflowInputField[]>([]);
  const [sections, setSections] = useState<WorkflowSection[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [creditsCost, setCreditsCost] = useState(0);
  const [gpuTier, setGpuTier] = useState<WorkflowGpuTier>(DEFAULT_WORKFLOW_GPU_TIER);
  const [gpuFallbackList, setGpuFallbackList] = useState<WorkflowGpuTier[]>([]);
  const [badgeLabel, setBadgeLabel] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("desktop");
  const [previewTier, setPreviewTier] = useState<string>("master");
  const [previewValues, setPreviewValues] = useState<Record<string, FieldValue>>({});

  const [volumeFiles, setVolumeFiles] = useState<{ path: string; size_bytes: number }[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/custom-workflows");
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました。");
        const row = (data.workflows as StudioCustomWorkflow[]).find((w) => w.id === workflowId);
        if (!row) throw new Error("指定されたワークフローが見つかりません。");
        setWorkflow(row);
        setFields(renumberOrder(row.input_schema ?? []));
        setSections(row.sections ?? []);
        setIsActive(row.is_active);
        setCreditsCost(row.credits_cost);
        setGpuTier(row.default_gpu_tier ?? DEFAULT_WORKFLOW_GPU_TIER);
        setGpuFallbackList(
          Array.isArray(row.gpu_fallback_list)
            ? (row.gpu_fallback_list as WorkflowGpuTier[])
            : [],
        );
        setBadgeLabel(row.gpu_badge_label ?? "");
      } catch (err) {
        setError(err instanceof Error ? err.message : "取得に失敗しました。");
      } finally {
        setLoading(false);
      }
    })();
  }, [workflowId]);

  // Best-effort Volume file listing — feeds the model-size / VRAM estimate
  // that drives the OOM ⚠️ badges on the GPU fallback chain. A failure just
  // leaves the estimate at zero (no badges), never blocks the builder.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/modal/storage");
        const data = await res.json().catch(() => null);
        if (!cancelled && res.ok && Array.isArray(data?.files)) {
          setVolumeFiles(data.files as { path: string; size_bytes: number }[]);
        }
      } catch {
        // ignore — estimate degrades to "unknown"
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const nodes: WorkflowNodeInfo[] = useMemo(
    () => (workflow ? parseWorkflowNodes(JSON.stringify(workflow.workflow_json)) : []),
    [workflow],
  );

  const requiredVramGb = useMemo(() => {
    if (!workflow) return 0;
    const index = buildModelSizeIndex(volumeFiles);
    return estimateWorkflowModelVram(JSON.stringify(workflow.workflow_json), index).requiredVramGb;
  }, [workflow, volumeFiles]);

  // previewValues holds only admin overrides; every read falls back to
  // defaultValueFor(field), so there's no seeding effect to keep in sync.
  const exposedKeys = useMemo(
    () => new Set(fields.map((f) => `${f.node_id}:${f.field}`)),
    [fields],
  );

  const selectedField = useMemo(
    () => fields.find((f) => f.id === selectedId) ?? null,
    [fields, selectedId],
  );

  const credits = useMemo(
    () =>
      workflowCreditsBreakdown({
        creditsCost,
        inputSchema: fields,
        values: Object.fromEntries(fields.map((f) => [f.id, previewValues[f.id] ?? defaultValueFor(f)])),
      }),
    [creditsCost, fields, previewValues],
  );

  const touch = useCallback(() => {
    setDirty(true);
    setNotice(null);
  }, []);

  const hasGpuTierField = useMemo(
    () => fields.some((f) => f.id === SYSTEM_FIELD_GPU_TIER),
    [fields],
  );

  const addGpuTierField = useCallback(() => {
    setFields((prev) => {
      if (prev.some((f) => f.id === SYSTEM_FIELD_GPU_TIER)) return prev;
      const next = renumberOrder([...prev, makeGpuTierField()]);
      setSelectedId(SYSTEM_FIELD_GPU_TIER);
      return next;
    });
    touch();
  }, [touch]);

  const handleExpose = useCallback(
    (node: WorkflowNodeInfo, fieldName: string) => {
      setFields((prev) => {
        const ids = new Set(prev.map((f) => f.id));
        const created = fieldFromNodeInput(node, fieldName, ids);
        const next = renumberOrder([...prev, created]);
        setSelectedId(created.id);
        return next;
      });
      touch();
    },
    [touch],
  );

  const patchField = useCallback(
    (id: string, patch: Partial<WorkflowInputField>) => {
      setFields((prev) => {
        // If the id itself is being edited, keep selection in sync.
        if (patch.id && patch.id !== id) {
          const taken = new Set(prev.filter((f) => f.id !== id).map((f) => f.id));
          const safeId = taken.has(patch.id) ? makeFieldId(patch.id, taken) : patch.id;
          setSelectedId(safeId);
          return prev.map((f) => (f.id === id ? { ...f, ...patch, id: safeId } : f));
        }
        return prev.map((f) => (f.id === id ? { ...f, ...patch } : f));
      });
      touch();
    },
    [touch],
  );

  const removeField = useCallback(
    (id: string) => {
      setFields((prev) => renumberOrder(prev.filter((f) => f.id !== id)));
      setSelectedId((cur) => (cur === id ? null : cur));
      touch();
    },
    [touch],
  );

  const reorder = useCallback(
    (activeId: string, overId: string, targetSectionId: string | undefined) => {
      setFields((prev) => {
        if (overId === activeId) {
          return renumberOrder(
            prev.map((f) => (f.id === activeId ? { ...f, sectionId: targetSectionId } : f)),
          );
        }
        const arr = [...prev];
        const from = arr.findIndex((f) => f.id === activeId);
        if (from < 0) return prev;
        const [moved] = arr.splice(from, 1);
        const to = arr.findIndex((f) => f.id === overId);
        arr.splice(to < 0 ? arr.length : to, 0, { ...moved, sectionId: targetSectionId });
        return renumberOrder(arr);
      });
      touch();
    },
    [touch],
  );

  const addSection = useCallback(() => {
    const label = window.prompt("セクション名を入力", `セクション ${sections.length + 1}`);
    if (label === null) return;
    const trimmed = label.trim() || `セクション ${sections.length + 1}`;
    setSections((prev) => {
      const ids = new Set(prev.map((s) => s.id));
      const id = makeFieldId(`section_${prev.length + 1}`, ids);
      return [...prev, { id, label: trimmed }];
    });
    touch();
  }, [sections.length, touch]);

  const removeSection = useCallback(
    (id: string) => {
      setSections((prev) => prev.filter((s) => s.id !== id));
      setFields((prev) =>
        renumberOrder(prev.map((f) => (f.sectionId === id ? { ...f, sectionId: undefined } : f))),
      );
      touch();
    },
    [touch],
  );

  const patchSection = useCallback(
    (id: string, patch: Partial<WorkflowSection>) => {
      setSections((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
      touch();
    },
    [touch],
  );

  const handleSave = async () => {
    if (!workflow) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/custom-workflows/${workflow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_schema: fields,
          sections,
          is_active: isActive,
          credits_cost: creditsCost,
          default_gpu_tier: gpuTier,
          gpu_fallback_list: gpuFallbackList,
          gpu_badge_label: badgeLabel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "保存に失敗しました。");
      setWorkflow(data.workflow as StudioCustomWorkflow);
      setDirty(false);
      setNotice("保存しました。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-[calc(100dvh-4rem)] items-center justify-center gap-2 text-sm text-muted">
        <Loader2 size={18} className="animate-spin" />
        読み込み中...
      </div>
    );
  }

  if (error && !workflow) {
    return (
      <div className="flex h-[calc(100dvh-4rem)] flex-col items-center justify-center gap-3 text-sm">
        <p className="text-red-400">{error}</p>
        <Link href="/admin" className="text-xs text-muted underline hover:text-foreground">
          管理画面へ戻る
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col">
      {/* Toolbar */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface/60 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/admin"
            className="flex items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
          >
            <ArrowLeft size={14} />
            管理画面
          </Link>
          <span className="truncate text-sm font-bold text-foreground">
            🎨 {workflow?.title}
            <span className="ml-2 font-mono text-[11px] text-muted">{workflow?.slug}</span>
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            バッジ
            <input
              value={badgeLabel}
              onChange={(e) => {
                setBadgeLabel(e.target.value.slice(0, 60));
                touch();
              }}
              placeholder="⚡ Logic Core V2（空欄で非表示）"
              className="w-44 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-neon-violet/50"
            />
          </label>

          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            実行GPU
            <select
              value={gpuTier}
              onChange={(e) => {
                setGpuTier(e.target.value as WorkflowGpuTier);
                touch();
              }}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-neon-violet/50"
            >
              {WORKFLOW_GPU_TIERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}（{t.vram}）
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            基本
            <input
              type="number"
              value={creditsCost}
              onChange={(e) => {
                setCreditsCost(Math.max(0, Number(e.target.value) || 0));
                touch();
              }}
              className="w-16 rounded-md border border-border bg-background px-2 py-1 text-center text-xs outline-none focus:border-neon-violet/50"
            />
            C
          </label>

          <span className="flex items-center gap-1.5 rounded-full border border-neon-pink/40 bg-neon-pink/10 px-3 py-1 font-mono text-xs font-semibold text-neon-pink">
            <Zap size={13} />
            {credits.total} Credits
            <span className="font-normal text-neon-pink/70">
              （基本 {credits.base} + アドオン {credits.addons}
              {credits.multiplier !== 1 ? ` × ${credits.multiplier}` : ""}）
            </span>
          </span>

          <div className="flex overflow-hidden rounded-full border border-border">
            <button
              type="button"
              onClick={() => setPreviewMode("desktop")}
              className={`px-2.5 py-1.5 ${previewMode === "desktop" ? "bg-neon-violet/15 text-neon-violet" : "text-muted"}`}
              title="編集（PC幅）"
            >
              <Monitor size={13} />
            </button>
            <button
              type="button"
              onClick={() => setPreviewMode("mobile")}
              className={`px-2.5 py-1.5 ${previewMode === "mobile" ? "bg-neon-violet/15 text-neon-violet" : "text-muted"}`}
              title="編集（モバイル幅）"
            >
              <Smartphone size={13} />
            </button>
            <button
              type="button"
              onClick={() => setPreviewMode("preview")}
              className={`px-2.5 py-1.5 text-[10px] font-semibold ${previewMode === "preview" ? "bg-neon-pink/15 text-neon-pink" : "text-muted"}`}
              title="ユーザー画面と完全一致プレビュー"
            >
              <Eye size={13} />
            </button>
          </div>

          {previewMode === "preview" && (
            <label className="flex items-center gap-1 text-[11px] text-muted">
              会員
              <select
                value={previewTier}
                onChange={(e) => setPreviewTier(e.target.value)}
                className="rounded-md border border-border bg-background px-1.5 py-1 text-xs outline-none"
              >
                {WORKFLOW_FIELD_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {WORKFLOW_FIELD_TIER_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => {
                setIsActive(e.target.checked);
                touch();
              }}
              className="h-3.5 w-3.5 accent-neon-pink"
            />
            公開
          </label>

          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-4 py-1.5 text-xs font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {dirty ? "保存" : "保存済み"}
          </button>
        </div>
      </header>

      {(error || notice) && (
        <div
          className={`shrink-0 px-4 py-1.5 text-[11px] ${
            error ? "bg-red-500/10 text-red-400" : "bg-neon-violet/10 text-neon-violet"
          }`}
        >
          {error ?? notice}
        </div>
      )}

      {/* 3-pane workstation: 25 / 45 / 30 */}
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "25% 45% 30%" }}>
        <NodeTreePane
          nodes={nodes}
          exposedKeys={exposedKeys}
          onExpose={handleExpose}
          hasGpuTierField={hasGpuTierField}
          onAddGpuTierField={addGpuTierField}
        />
        <LiveCanvasPane
          fields={fields}
          sections={sections}
          selectedId={selectedId}
          previewMode={previewMode}
          previewTier={previewTier}
          previewValues={previewValues}
          onSelect={setSelectedId}
          onReorder={reorder}
          onFieldPatch={patchField}
          onAddSection={addSection}
          onRemoveSection={removeSection}
          onSectionPatch={patchSection}
          onPreviewValue={(id, v) => setPreviewValues((prev) => ({ ...prev, [id]: v }))}
        />
        <ParameterInspectorPane
          field={selectedField}
          sections={sections}
          gpuFallbackList={gpuFallbackList}
          requiredVramGb={requiredVramGb}
          onChange={(patch) => selectedField && patchField(selectedField.id, patch)}
          onGpuFallbackChange={(next) => {
            setGpuFallbackList(next);
            touch();
          }}
          onRemove={() => selectedField && removeField(selectedField.id)}
        />
      </div>
    </div>
  );
}
