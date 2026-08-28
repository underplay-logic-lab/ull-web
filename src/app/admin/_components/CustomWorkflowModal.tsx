"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Clipboard, Download, Loader2, Plus, Trash2, UploadCloud, X, Zap } from "lucide-react";
import { ToastStack, type ToastData } from "@/components/Toast";
import { downloadJson } from "@/lib/downloadJson";
import {
  WORKFLOW_INPUT_FIELD_TYPES,
  WORKFLOW_INPUT_FIELD_SECTIONS,
  isValidWorkflowJson,
  type WorkflowInputField,
  type WorkflowInputFieldType,
  type WorkflowInputFieldSection,
} from "@/lib/customWorkflows";
import {
  parseWorkflowNodes,
  isLinkValue,
  bypassNode,
  restoreBypass,
  updateNodeInputValue,
  buildInferredPatch,
  type BypassSnapshotEntry,
} from "@/lib/workflowGraph";
import {
  categorizeVolumeFiles,
  inferModelCategoryFromFieldName,
  listAllModelFiles,
  MODEL_FILE_CATEGORIES,
  type ModelFileCategory,
} from "@/lib/modelFileCategories";
import type { StudioCustomWorkflow, VolumeFile } from "./types";

const FIELD_TYPE_LABEL: Record<WorkflowInputFieldType, string> = {
  text: "テキスト",
  image: "画像",
  video: "動画",
  slider: "スライダー",
  toggle: "トグル",
  select: "セレクト（UIビルダーで選択肢を設定）",
};

const FIELD_SECTION_LABEL: Record<WorkflowInputFieldSection, string> = {
  main: "通常表示",
  advanced: "詳細設定（アコーディオン）",
};

// Builder-only props (layout / dynamic pricing / height) the modal doesn't
// edit — carried through verbatim so editing a builder-authored workflow in
// this modal doesn't strip them.
const CARRIED_KEYS = [
  "colSpan",
  "row",
  "sectionId",
  "minTier",
  "options",
  "credits_baseline",
  "credits_per_unit",
  "rows",
  "heightPreset",
] as const;

type CarriedProps = Partial<Pick<WorkflowInputField, (typeof CARRIED_KEYS)[number]>>;

function pickCarried(field: WorkflowInputField): CarriedProps {
  const out: CarriedProps = {};
  for (const k of CARRIED_KEYS) {
    if (field[k] !== undefined) (out as Record<string, unknown>)[k] = field[k];
  }
  return out;
}

type FieldDraft = {
  key: string;
  id: string;
  label: string;
  type: WorkflowInputFieldType;
  node_id: string;
  field: string;
  defaultValue: string;
  min: string;
  max: string;
  step: string;
  order: string;
  section: WorkflowInputFieldSection;
  creditsAdd: string;
  carried: CarriedProps;
};

let draftKeySeq = 0;
function nextDraftKey() {
  draftKeySeq += 1;
  return `draft-${draftKeySeq}`;
}

function fieldToDraft(field: WorkflowInputField): FieldDraft {
  return {
    key: nextDraftKey(),
    id: field.id,
    label: field.label,
    type: field.type,
    node_id: field.node_id,
    field: field.field,
    defaultValue: field.default === undefined ? "" : String(field.default),
    min: field.min === undefined ? "" : String(field.min),
    max: field.max === undefined ? "" : String(field.max),
    step: field.step === undefined ? "" : String(field.step),
    order: field.order === undefined ? "" : String(field.order),
    section: field.section ?? "main",
    creditsAdd: field.credits_add === undefined ? "" : String(field.credits_add),
    carried: pickCarried(field),
  };
}

function emptyDraft(order: number): FieldDraft {
  return {
    key: nextDraftKey(),
    id: "",
    label: "",
    type: "text",
    node_id: "",
    field: "",
    defaultValue: "",
    min: "",
    max: "",
    step: "",
    order: String(order),
    section: "main",
    creditsAdd: "",
    carried: {},
  };
}

// A model/VAE/CLIP/LoRA filename field. Uses a real <select> rather than an
// <input list>+<datalist> combo — datalist's "click/type to see suggestions"
// affordance renders with no visible dropdown arrow in several browsers, so
// admins had no way to tell a file list was even available (this is what
// the "選択肢に出てこない" bug report actually was: the category matching
// and Volume fetch were both working — the suggestions were just invisible
// until you knew to start typing). The ✏️ button always lets an admin drop
// back to manual entry, and 📂 switches back to picking. When `options` is
// empty, this renders as a plain input from the start — never blocks typing
// an arbitrary path.
function ModelFileCombobox({
  value,
  onChange,
  options,
  allOptions,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  allOptions: string[];
  placeholder?: string;
  className: string;
}) {
  // No effect needed to keep this in sync with option availability: render
  // falls back to the manual input below whenever activeOptions is empty
  // regardless of this flag, and defaults to select-mode (false) so the
  // picker activates on its own the moment the Volume fetch resolves.
  const [manualMode, setManualMode] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Defensive against every phase of the Volume fetch this depends on
  // (CustomWorkflowModal.tsx's useEffect: not-yet-fired, in flight, failed,
  // or resolved) — none of those states should ever hand this component
  // something it can't safely render.
  const safeOptions = options ?? [];
  const safeAllOptions = allOptions ?? [];
  const safeValue = value ?? "";
  const activeOptions = showAll ? safeAllOptions : safeOptions;
  const canPick = safeOptions.length > 0 || safeAllOptions.length > 0;

  if (manualMode || activeOptions.length === 0) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          value={safeValue}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={className}
        />
        {canPick && (
          <button
            type="button"
            onClick={() => setManualMode(false)}
            className="shrink-0 rounded-md border border-border px-2 py-1.5 text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
            title="Volume内のファイルから選択"
          >
            📂
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {/* `value` (not gated behind activeOptions.includes(value)) so the
            currently configured filename is preselected the moment it
            appears — either as a real <option> once activeOptions includes
            it, or via the "未検出" fallback <option> below. Gating this on
            activeOptions.includes(value) (as a previous revision did) forced
            the select back to the disabled placeholder even when that
            fallback option existed, which is exactly the "初期選択されない"
            bug: the currently-set model never appeared selected until the
            admin manually reselected it. */}
        <select
          value={safeValue}
          onChange={(e) => onChange(e.target.value)}
          className={className}
        >
          <option value="" disabled>
            {`選択してください（${activeOptions.length}件）`}
          </option>
          {activeOptions.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
          {safeValue && !activeOptions.includes(safeValue) && (
            <option value={safeValue}>{`${safeValue}（未検出）`}</option>
          )}
        </select>
        <button
          type="button"
          onClick={() => setManualMode(true)}
          className="shrink-0 rounded-md border border-border px-2 py-1.5 text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
          title="手動入力に切り替え"
        >
          ✏️
        </button>
      </div>
      {safeAllOptions.length > safeOptions.length && (
        <label className="flex items-center gap-1 text-[9px] text-muted">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            className="h-3 w-3 accent-neon-pink"
          />
          {`全モデル一覧から選択（カテゴリ判定を無視して${safeAllOptions.length}件から選ぶ）`}
        </label>
      )}
    </div>
  );
}

function draftToField(draft: FieldDraft): WorkflowInputField {
  const base = {
    // Builder-authored layout / pricing / height props first, so the modal's
    // own fields below still win where they overlap (id, label, order, …).
    ...draft.carried,
    id: draft.id.trim(),
    label: draft.label.trim(),
    type: draft.type,
    node_id: draft.node_id.trim(),
    field: draft.field.trim(),
    order: draft.order.trim() ? Number(draft.order) : undefined,
    section: draft.section,
    credits_add: draft.creditsAdd.trim() ? Number(draft.creditsAdd) : undefined,
  };

  if (draft.type === "slider") {
    return {
      ...base,
      default: draft.defaultValue.trim() ? Number(draft.defaultValue) : undefined,
      min: draft.min.trim() ? Number(draft.min) : undefined,
      max: draft.max.trim() ? Number(draft.max) : undefined,
      step: draft.step.trim() ? Number(draft.step) : undefined,
    };
  }
  if (draft.type === "toggle") {
    return { ...base, default: draft.defaultValue === "true" };
  }
  if (draft.type === "text") {
    return { ...base, default: draft.defaultValue };
  }
  return base;
}

type FormValues = {
  title: string;
  slug: string;
  category: string;
  description: string;
  creditsCost: string;
  priority: string;
  isActive: boolean;
  workflowJsonText: string;
  disableSmartMemory: boolean;
  cpuVae: boolean;
  gpuOnly: boolean;
  usePytorchCrossAttention: boolean;
  highVram: boolean;
  extraArgs: string;
  outputNodeId: string;
};

function toFormValues(workflow: StudioCustomWorkflow | null): FormValues {
  if (!workflow) {
    return {
      title: "",
      slug: "",
      category: "image",
      description: "",
      creditsCost: "15",
      priority: "0",
      isActive: true,
      workflowJsonText: "",
      disableSmartMemory: false,
      cpuVae: false,
      gpuOnly: false,
      usePytorchCrossAttention: false,
      highVram: false,
      extraArgs: "",
      outputNodeId: "",
    };
  }
  return {
    title: workflow.title,
    slug: workflow.slug,
    category: workflow.category,
    description: workflow.description ?? "",
    creditsCost: String(workflow.credits_cost),
    priority: String(workflow.priority),
    isActive: workflow.is_active,
    workflowJsonText: JSON.stringify(workflow.workflow_json, null, 2),
    // ?? false guards every boolean here against a row predating its
    // migration (column not yet added, or added but this row was read via
    // a stale schema cache) — without it, `undefined` reaches the
    // checkbox's `checked` prop and React logs "changing an uncontrolled
    // input to be controlled".
    disableSmartMemory: workflow.disable_smart_memory ?? false,
    cpuVae: workflow.cpu_vae ?? false,
    gpuOnly: workflow.gpu_only ?? false,
    usePytorchCrossAttention: workflow.use_pytorch_cross_attention ?? false,
    highVram: workflow.high_vram ?? false,
    extraArgs: workflow.extra_args ?? "",
    outputNodeId: workflow.output_node_id ?? "",
  };
}

// class_types that typically produce the final downloadable output —
// used to suggest candidates for the "最終出力ノード" picker. Mirrors the
// key set _run_workflow already scans for in scripts/modal_wan_animate.py
// (SaveVideo/SaveImage/PreviewImage plus the common VideoHelperSuite node).
const OUTPUT_NODE_CLASS_TYPES = new Set([
  "SaveVideo",
  "SaveImage",
  "PreviewImage",
  "VHS_VideoCombine",
]);

type CustomWorkflowModalProps = {
  workflow: StudioCustomWorkflow | null;
  onClose: () => void;
  onSaved: (workflow: StudioCustomWorkflow) => void;
};

export function CustomWorkflowModal({ workflow, onClose, onSaved }: CustomWorkflowModalProps) {
  const isEdit = workflow !== null;
  const [values, setValues] = useState<FormValues>(() => toFormValues(workflow));
  const [fields, setFields] = useState<FieldDraft[]>(() => (workflow ? workflow.input_schema.map(fieldToDraft) : []));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [execConfigOpen, setExecConfigOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const dismissToast = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const handleCopyJson = async () => {
    let text = values.workflowJsonText;
    try {
      text = JSON.stringify(JSON.parse(values.workflowJsonText), null, 2);
    } catch {
      // Not (yet) valid JSON — copy the raw textarea contents as-is rather
      // than blocking the copy on validity.
    }
    try {
      await navigator.clipboard.writeText(text);
      setToasts((prev) => [...prev, { id: Date.now(), message: "ワークフローJSONをコピーしました" }]);
    } catch (err) {
      setToasts((prev) => [
        ...prev,
        { id: Date.now(), message: `コピーに失敗しました: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    }
  };

  const handleDownloadJson = () => {
    const filename = `${values.slug.trim() || "workflow"}_api.json`;
    downloadJson(values.workflowJsonText, filename);
    setToasts((prev) => [...prev, { id: Date.now(), message: `${filename} をダウンロードしました` }]);
  };

  const parsedNodes = useMemo(() => parseWorkflowNodes(values.workflowJsonText), [values.workflowJsonText]);
  const outputNodeCandidates = useMemo(
    () => parsedNodes.filter((n) => OUTPUT_NODE_CLASS_TYPES.has(n.classType)),
    [parsedNodes],
  );

  // Best-effort Volume file listing for the model/VAE/CLIP/LoRA combo
  // boxes below — fetched once on open. A failure (or an empty Volume)
  // just leaves every combo box's options empty, which degrades to a
  // plain manual-entry input rather than breaking the form.
  const [volumeFiles, setVolumeFiles] = useState<VolumeFile[]>([]);
  const [volumeFilesError, setVolumeFilesError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/modal/storage");
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          console.error("[Storage Model List] fetch failed:", res.status, data?.error);
          if (!cancelled) setVolumeFilesError(data?.error ?? `取得に失敗しました（${res.status}）`);
          return;
        }
        if (!cancelled && Array.isArray(data?.files)) {
          console.log("[Storage Model List] fetched", data.files.length, "files:", data.files);
          setVolumeFiles(data.files as VolumeFile[]);
        }
      } catch (err) {
        console.error("[Storage Model List] fetch threw:", err);
        if (!cancelled) setVolumeFilesError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const fileCategories = useMemo(() => categorizeVolumeFiles(volumeFiles), [volumeFiles]);
  const allModelFiles = useMemo(() => listAllModelFiles(volumeFiles), [volumeFiles]);

  useEffect(() => {
    console.log("[Storage Model List] categorized:", {
      total: volumeFiles.length,
      allModelFiles: allModelFiles.length,
      ...Object.fromEntries(MODEL_FILE_CATEGORIES.map((c) => [c, fileCategories[c].length])),
    });
  }, [volumeFiles, fileCategories, allModelFiles]);

  // Every string-valued node input across the parsed workflow whose field
  // name looks like a model/VAE/CLIP/LoRA filename (see
  // inferModelCategoryFromFieldName) — these edit workflow_json directly,
  // independent of input_schema.
  const modelInputRows = useMemo(() => {
    const rows: {
      key: string;
      nodeId: string;
      nodeTitle: string;
      classType: string;
      fieldName: string;
      category: ModelFileCategory;
      value: string;
    }[] = [];
    for (const node of parsedNodes) {
      for (const [fieldName, rawValue] of Object.entries(node.inputs)) {
        if (typeof rawValue !== "string") continue;
        const category = inferModelCategoryFromFieldName(fieldName);
        if (!category) continue;
        rows.push({
          key: `${node.nodeId}:${fieldName}`,
          nodeId: node.nodeId,
          nodeTitle: node.title,
          classType: node.classType,
          fieldName,
          category,
          value: rawValue,
        });
      }
    }
    return rows;
  }, [parsedNodes]);

  const handleModelInputChange = (nodeId: string, fieldName: string, newValue: string) => {
    setValues((v) => ({
      ...v,
      workflowJsonText: updateNodeInputValue(v.workflowJsonText, nodeId, fieldName, newValue),
    }));
  };

  // nodeId -> the downstream rewiring bypassNode() made, so toggling back
  // off can restore it exactly. A node's presence as a key here is what
  // "currently bypassed" means — purely client-side editing-session state,
  // not persisted (saving just persists whatever workflow_json currently
  // reads, rewired or not).
  const [bypassSnapshots, setBypassSnapshots] = useState<Record<string, BypassSnapshotEntry[]>>({});

  const handleToggleBypass = (nodeId: string) => {
    const existingSnapshot = bypassSnapshots[nodeId];
    if (existingSnapshot) {
      setValues((v) => ({ ...v, workflowJsonText: restoreBypass(v.workflowJsonText, existingSnapshot) }));
      setBypassSnapshots((prev) => {
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
      return;
    }

    const result = bypassNode(values.workflowJsonText, nodeId);
    if (!result) {
      setError("このノードにはバイパス可能な配線（上流ノードからの接続）が見つかりませんでした。");
      return;
    }
    setValues((v) => ({ ...v, workflowJsonText: result.text }));
    setBypassSnapshots((prev) => ({ ...prev, [nodeId]: result.snapshot }));
  };

  const handleFileUpload = async (file: File) => {
    try {
      const text = await file.text();
      JSON.parse(text);
      setValues((v) => ({ ...v, workflowJsonText: text }));
      setError(null);
    } catch {
      setError("アップロードされたファイルは有効なJSONではありません。");
    }
  };

  const addField = () => setFields((prev) => [...prev, emptyDraft(prev.length)]);
  const removeField = (key: string) => setFields((prev) => prev.filter((f) => f.key !== key));
  const updateField = (key: string, patch: Partial<FieldDraft>) =>
    setFields((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const handleNodeIdChange = (key: string, nodeId: string) => {
    const draft = fields.find((f) => f.key === key);
    if (!draft) return;
    const node = parsedNodes.find((n) => n.nodeId === nodeId);
    const firstFieldName = node ? Object.keys(node.inputs)[0] ?? "" : "";
    const inferred = firstFieldName ? buildInferredPatch(node, firstFieldName, draft) : {};
    updateField(key, { node_id: nodeId, field: firstFieldName, ...inferred });
  };

  const handleFieldChange = (key: string, fieldName: string) => {
    const draft = fields.find((f) => f.key === key);
    if (!draft) return;
    const node = parsedNodes.find((n) => n.nodeId === draft.node_id);
    updateField(key, buildInferredPatch(node, fieldName, draft));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!values.title.trim() || !values.slug.trim()) {
      setError("タイトルとslugは必須です。");
      return;
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(values.slug.trim())) {
      setError("slugは英小文字・数字・ハイフンのみで入力してください（例: manga-face-inpaint）。");
      return;
    }

    let workflowJson: Record<string, unknown>;
    try {
      workflowJson = JSON.parse(values.workflowJsonText || "null");
    } catch {
      setError("workflow_json が有効なJSONではありません。");
      return;
    }
    if (!isValidWorkflowJson(workflowJson)) {
      setError("workflow_json はComfyUI API形式のJSONオブジェクトを貼り付けてください。");
      return;
    }

    for (const f of fields) {
      if (!f.id.trim() || !f.label.trim() || !f.node_id.trim() || !f.field.trim()) {
        setError("入力パラメータはパラメータ名・ラベル・node_id・fieldをすべて入力してください。");
        return;
      }
    }
    const ids = fields.map((f) => f.id.trim());
    if (new Set(ids).size !== ids.length) {
      setError("入力パラメータのパラメータ名（id）が重複しています。");
      return;
    }

    const creditsCost = Number(values.creditsCost);
    const priority = Number(values.priority);
    if (!Number.isFinite(creditsCost) || !Number.isFinite(priority)) {
      setError("消費クレジットと優先度は数値で入力してください。");
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        title: values.title.trim(),
        slug: values.slug.trim(),
        category: values.category.trim() || "image",
        description: values.description.trim() || null,
        credits_cost: creditsCost,
        priority,
        is_active: values.isActive,
        disable_smart_memory: values.disableSmartMemory,
        cpu_vae: values.cpuVae,
        gpu_only: values.gpuOnly,
        use_pytorch_cross_attention: values.usePytorchCrossAttention,
        high_vram: values.highVram,
        extra_args: values.extraArgs.trim(),
        output_node_id: values.outputNodeId.trim(),
        workflow_json: workflowJson,
        input_schema: fields.map(draftToField),
      };

      const res = await fetch(
        isEdit ? `/api/admin/custom-workflows/${workflow!.id}` : "/api/admin/custom-workflows",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error ?? "保存に失敗しました。");
      }

      onSaved(data.workflow as StudioCustomWorkflow);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  };

  if (typeof document === "undefined") return null;

  return (
    <>
      {createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 py-8 backdrop-blur-sm"
          onClick={onClose}
        >
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border-gradient bg-surface p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-foreground">
            {isEdit ? "特化ワークフローを編集" : "特化ワークフローを新規追加"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-muted transition-colors hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-6">
          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-neon-violet">基本情報</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">タイトル</label>
                <input
                  value={values.title}
                  onChange={(e) => setValues((v) => ({ ...v, title: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                  placeholder="例: 漫画顔インペイント"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">slug</label>
                <input
                  value={values.slug}
                  onChange={(e) => setValues((v) => ({ ...v, slug: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm font-mono outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                  placeholder="manga-face-inpaint"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">カテゴリ</label>
                <input
                  value={values.category}
                  onChange={(e) => setValues((v) => ({ ...v, category: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                  placeholder="image / video / inpaint..."
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">消費クレジット</label>
                <input
                  type="number"
                  value={values.creditsCost}
                  onChange={(e) => setValues((v) => ({ ...v, creditsCost: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">優先度</label>
                <input
                  type="number"
                  value={values.priority}
                  onChange={(e) => setValues((v) => ({ ...v, priority: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">説明（任意）</label>
              <textarea
                rows={2}
                value={values.description}
                onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))}
                className="w-full resize-none rounded-lg border border-border bg-background px-3.5 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                placeholder="Studioのワークフロー選択カードに表示される説明文"
              />
            </div>

            <label className="flex items-center gap-2 text-xs font-medium text-muted">
              <input
                type="checkbox"
                checked={values.isActive}
                onChange={(e) => setValues((v) => ({ ...v, isActive: e.target.checked }))}
                className="h-4 w-4 rounded border-border bg-background accent-neon-pink"
              />
              有効（Studioに公開する）
            </label>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-neon-violet">
                workflow_json（ComfyUI API形式）
              </h4>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyJson}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
                >
                  <Clipboard size={13} />
                  📋 JSONをコピー
                </button>
                <button
                  type="button"
                  onClick={handleDownloadJson}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
                >
                  <Download size={13} />
                  📥 JSONをダウンロード
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileUpload(file);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
                >
                  <UploadCloud size={13} />
                  ファイルから読み込み
                </button>
              </div>
            </div>
            <textarea
              rows={8}
              value={values.workflowJsonText}
              onChange={(e) => setValues((v) => ({ ...v, workflowJsonText: e.target.value }))}
              className="w-full resize-y rounded-lg border border-border bg-background px-3.5 py-2 font-mono text-xs outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
              placeholder='{ "6": { "inputs": { "text": "..." }, "class_type": "CLIPTextEncode" }, ... }'
              spellCheck={false}
            />

            <div className="mt-3">
              <label className="mb-1.5 block text-xs font-medium text-muted">
                🎯 最終出力ノード（未指定時は自動検出）
              </label>
              <select
                value={values.outputNodeId}
                onChange={(e) => setValues((v) => ({ ...v, outputNodeId: e.target.value }))}
                className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm font-mono outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
              >
                <option value="">自動検出</option>
                {outputNodeCandidates.map((n) => (
                  <option key={n.nodeId} value={n.nodeId}>
                    {`[${n.nodeId}] ${n.title} (${n.classType})`}
                  </option>
                ))}
                {values.outputNodeId && !outputNodeCandidates.some((n) => n.nodeId === values.outputNodeId) && (
                  <option value={values.outputNodeId}>{`[${values.outputNodeId}] (未検出)`}</option>
                )}
              </select>
              <p className="mt-1 text-[10px] text-muted">
                SaveVideo / SaveImage / PreviewImage / VHS_VideoCombine を自動検出します。複数の出力ノードがあるワークフローで、生成結果として返す出力を明示的に固定したい場合に指定してください。
              </p>
            </div>

            {modelInputRows.length > 0 && (
              <div className="mt-3 space-y-2 rounded-lg border border-border bg-background/60 p-3">
                <p className="text-[10px] font-medium text-muted">
                  🗂️ モデル / VAE / CLIP / LoRA ファイル（Modal Volume: ull-wan-models）
                </p>
                {modelInputRows.map((row) => (
                  <div key={row.key} className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:items-center">
                    <label
                      className="truncate text-[10px] text-muted"
                      title={`[${row.nodeId}] ${row.nodeTitle} (${row.classType})`}
                    >
                      <span className="font-mono">{row.fieldName}</span>{" "}
                      <span className="text-neon-violet">({row.category})</span>
                      <br />
                      <span className="opacity-70">{`[${row.nodeId}] ${row.nodeTitle}`}</span>
                    </label>
                    <ModelFileCombobox
                      value={row.value}
                      onChange={(val) => handleModelInputChange(row.nodeId, row.fieldName, val)}
                      options={fileCategories[row.category]}
                      allOptions={allModelFiles}
                      className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono outline-none focus:border-neon-violet/50"
                    />
                  </div>
                ))}
                {volumeFilesError ? (
                  <p className="text-[10px] text-red-400">
                    {`Modal Volumeのファイル一覧の取得に失敗しました: ${volumeFilesError}（上の欄にはそのままファイル名を手入力できます）`}
                  </p>
                ) : (
                  volumeFiles.length === 0 && (
                    <p className="text-[10px] text-muted">
                      Modal Volumeのファイル一覧を取得中、または空です。上の欄にはそのままファイル名を手入力できます。
                    </p>
                  )
                )}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-neon-violet">
              ノード一覧（バイパス）
            </h4>
            <p className="text-[10px] text-muted">
              LoRAやパッチノード（EasyCache / SageAttention等）を挟んだまま試行錯誤したい時に、配線を手作業で書き換えずワンクリックで前後を直結できます。バイパス解除でいつでも元に戻せます。
            </p>
            {parsedNodes.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-xs text-muted">
                workflow_json を入力するとノード一覧が表示されます。
              </p>
            ) : (
              <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-background/60 p-2">
                {parsedNodes.map((node) => {
                  const isBypassed = Boolean(bypassSnapshots[node.nodeId]);
                  const canBypass = isBypassed || Object.values(node.inputs).some(isLinkValue);
                  return (
                    <div
                      key={node.nodeId}
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5"
                    >
                      <span
                        className="truncate text-[11px] text-foreground"
                        title={`[${node.nodeId}] ${node.title} (${node.classType})`}
                      >
                        <span className="font-mono">[{node.nodeId}]</span> {node.title}{" "}
                        <span className="text-muted">({node.classType})</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => handleToggleBypass(node.nodeId)}
                        disabled={!canBypass}
                        title={
                          canBypass
                            ? undefined
                            : "上流ノードからの配線（リンク値の入力）が見つからないためバイパスできません"
                        }
                        className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          isBypassed
                            ? "border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                            : "border-border text-muted hover:border-red-400/40 hover:text-red-400"
                        }`}
                      >
                        {isBypassed ? "↩️ バイパス解除" : "🚫 バイパス"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-border">
            <button
              type="button"
              onClick={() => setExecConfigOpen((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-wide text-neon-violet transition-colors hover:text-foreground"
            >
              <span className="flex items-center gap-1.5">
                <Zap size={14} />
                ComfyUI 実行引数・最適化設定
              </span>
              <ChevronDown size={14} className={`transition-transform ${execConfigOpen ? "rotate-180" : ""}`} />
            </button>
            {execConfigOpen && (
              <div className="flex flex-col gap-3 border-t border-border p-4">
                <label className="flex items-start gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={Boolean(values.disableSmartMemory)}
                    onChange={(e) => setValues((v) => ({ ...v, disableSmartMemory: e.target.checked }))}
                    className="mt-0.5 h-4 w-4 rounded border-border bg-background accent-neon-pink"
                  />
                  <span>
                    <span className="font-medium text-foreground">VRAM即時解放</span>{" "}
                    <span className="font-mono text-[10px]">(--disable-smart-memory)</span>
                    <br />
                    ノード完了後にRAMへ強制オフロードします。
                  </span>
                </label>
                <label className="flex items-start gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={Boolean(values.cpuVae)}
                    onChange={(e) => setValues((v) => ({ ...v, cpuVae: e.target.checked }))}
                    className="mt-0.5 h-4 w-4 rounded border-border bg-background accent-neon-pink"
                  />
                  <span>
                    <span className="font-medium text-foreground">VAEをCPUで実行</span>{" "}
                    <span className="font-mono text-[10px]">(--cpu-vae)</span>
                    <br />
                    高解像度・長尺動画のVAEデコードOOMを防ぎます。
                  </span>
                </label>
                <label className="flex items-start gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={Boolean(values.gpuOnly)}
                    onChange={(e) => setValues((v) => ({ ...v, gpuOnly: e.target.checked }))}
                    className="mt-0.5 h-4 w-4 rounded border-border bg-background accent-neon-pink"
                  />
                  <span>
                    <span className="font-medium text-foreground">GPU完全常駐</span>{" "}
                    <span className="font-mono text-[10px]">(--gpu-only)</span>
                    <br />
                    全モデルをVRAMに留め最高速化します（B300等、VRAMに余裕のあるティア向け）。
                  </span>
                </label>
                <label className="flex items-start gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={Boolean(values.usePytorchCrossAttention)}
                    onChange={(e) => setValues((v) => ({ ...v, usePytorchCrossAttention: e.target.checked }))}
                    className="mt-0.5 h-4 w-4 rounded border-border bg-background accent-neon-pink"
                  />
                  <span>
                    <span className="font-medium text-foreground">高速アテンション（PyTorch SDPA）</span>{" "}
                    <span className="font-mono text-[10px]">(--use-pytorch-cross-attention)</span>
                    <br />
                    PyTorch内蔵のFlashAttention相当バックエンドで高速化します。追加パッケージ不要・ビルド不要で安全に使えます（別途の
                    flash-attn パッケージはこの環境のPython/CUDA構成と互換のあるビルド済みwheelが存在しないため非採用）。
                  </span>
                </label>
                <label className="flex items-start gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={Boolean(values.highVram)}
                    onChange={(e) => setValues((v) => ({ ...v, highVram: e.target.checked }))}
                    className="mt-0.5 h-4 w-4 rounded border-border bg-background accent-neon-pink"
                  />
                  <span>
                    <span className="font-medium text-foreground">高VRAM常駐</span>{" "}
                    <span className="font-mono text-[10px]">(--highvram)</span>
                    <br />
                    モデルをロード後も常にVRAMへ常駐させ、ノード間のオフロードを避けて高速化します（VRAMに余裕のあるティア向け）。
                  </span>
                </label>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted">
                    追加引数 <span className="font-mono text-[10px]">(extra_args)</span>
                  </label>
                  <input
                    value={values.extraArgs}
                    onChange={(e) => setValues((v) => ({ ...v, extraArgs: e.target.value }))}
                    placeholder="--preview-method none --deterministic"
                    className="w-full rounded-lg border border-border bg-background px-3.5 py-2 font-mono text-xs outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                  />
                </div>
                <p className="text-[10px] text-muted">
                  これらの設定はComfyUIプロセスの起動時にのみ反映されるフラグです。前回と異なる設定のワークフローが実行されると、Modal側でComfyUIプロセスが自動的に再起動されます（数秒〜のコールドスタートが発生します）。
                </p>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-neon-violet">
                入力パラメータ (input_schema)
              </h4>
              <button
                type="button"
                onClick={addField}
                className="flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
              >
                <Plus size={13} />
                パラメータ追加
              </button>
            </div>

            {fields.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
                パラメータが未設定です。「パラメータ追加」から公開する入力項目を定義してください。
              </p>
            ) : (
              <div className="space-y-3">
                {fields.map((f) => {
                  const selectedNode = parsedNodes.find((n) => n.nodeId === f.node_id);
                  const fieldOptions = selectedNode ? Object.keys(selectedNode.inputs) : [];
                  const defaultValueCategory = inferModelCategoryFromFieldName(f.field);
                  const defaultValueOptions = defaultValueCategory ? fileCategories[defaultValueCategory] : [];
                  return (
                  <div key={f.key} className="rounded-xl border border-border bg-background/60 p-3">
                    <div className="grid gap-2 sm:grid-cols-5">
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-muted">パラメータ名 (id)</label>
                        <input
                          value={f.id}
                          onChange={(e) => updateField(f.key, { id: e.target.value })}
                          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono outline-none focus:border-neon-violet/50"
                          placeholder="prompt"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-muted">ラベル</label>
                        <input
                          value={f.label}
                          onChange={(e) => updateField(f.key, { label: e.target.value })}
                          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-neon-violet/50"
                          placeholder="プロンプト"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-muted">タイプ</label>
                        <select
                          value={f.type}
                          onChange={(e) =>
                            updateField(f.key, { type: e.target.value as WorkflowInputFieldType })
                          }
                          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-neon-violet/50"
                        >
                          {WORKFLOW_INPUT_FIELD_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {FIELD_TYPE_LABEL[t]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-muted">node_id</label>
                        {parsedNodes.length > 0 ? (
                          <select
                            value={f.node_id}
                            onChange={(e) => handleNodeIdChange(f.key, e.target.value)}
                            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono outline-none focus:border-neon-violet/50"
                          >
                            <option value="">選択してください</option>
                            {parsedNodes.map((n) => (
                              <option key={n.nodeId} value={n.nodeId}>
                                {`[${n.nodeId}] ${n.title} (${n.classType})`}
                              </option>
                            ))}
                            {f.node_id && !selectedNode && (
                              <option value={f.node_id}>{`[${f.node_id}] (未検出)`}</option>
                            )}
                          </select>
                        ) : (
                          <input
                            value={f.node_id}
                            onChange={(e) => updateField(f.key, { node_id: e.target.value })}
                            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono outline-none focus:border-neon-violet/50"
                            placeholder="workflow_json入力後に選択可"
                          />
                        )}
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-muted">field</label>
                        {fieldOptions.length > 0 ? (
                          <select
                            value={f.field}
                            onChange={(e) => handleFieldChange(f.key, e.target.value)}
                            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono outline-none focus:border-neon-violet/50"
                          >
                            <option value="">選択してください</option>
                            {fieldOptions.map((key) => (
                              <option key={key} value={key}>
                                {key}
                              </option>
                            ))}
                            {f.field && !fieldOptions.includes(f.field) && (
                              <option value={f.field}>{`${f.field} (未検出)`}</option>
                            )}
                          </select>
                        ) : (
                          <input
                            value={f.field}
                            onChange={(e) => updateField(f.key, { field: e.target.value })}
                            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono outline-none focus:border-neon-violet/50"
                            placeholder="node_id選択後に選択可"
                          />
                        )}
                      </div>
                    </div>

                    <div className="mt-2 grid gap-2 sm:grid-cols-5">
                      {f.type === "text" && (
                        <div className="sm:col-span-2">
                          <label className="mb-1 block text-[10px] font-medium text-muted">
                            初期値
                            {defaultValueCategory && (
                              <span className="ml-1 font-mono text-[9px] text-neon-violet">
                                ({defaultValueCategory})
                              </span>
                            )}
                          </label>
                          {defaultValueCategory ? (
                            <ModelFileCombobox
                              value={f.defaultValue}
                              onChange={(val) => updateField(f.key, { defaultValue: val })}
                              options={defaultValueOptions}
                              allOptions={allModelFiles}
                              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono outline-none focus:border-neon-violet/50"
                            />
                          ) : (
                            <input
                              value={f.defaultValue}
                              onChange={(e) => updateField(f.key, { defaultValue: e.target.value })}
                              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-neon-violet/50"
                            />
                          )}
                        </div>
                      )}
                      {f.type === "toggle" && (
                        <div>
                          <label className="mb-1 block text-[10px] font-medium text-muted">初期値</label>
                          <select
                            value={f.defaultValue === "true" ? "true" : "false"}
                            onChange={(e) => updateField(f.key, { defaultValue: e.target.value })}
                            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-neon-violet/50"
                          >
                            <option value="false">OFF</option>
                            <option value="true">ON</option>
                          </select>
                        </div>
                      )}
                      {f.type === "slider" && (
                        <>
                          <div>
                            <label className="mb-1 block text-[10px] font-medium text-muted">初期値</label>
                            <input
                              type="number"
                              step="any"
                              value={f.defaultValue}
                              onChange={(e) => updateField(f.key, { defaultValue: e.target.value })}
                              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-neon-violet/50"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-[10px] font-medium text-muted">min</label>
                            <input
                              type="number"
                              step="any"
                              value={f.min}
                              onChange={(e) => updateField(f.key, { min: e.target.value })}
                              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-neon-violet/50"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-[10px] font-medium text-muted">max</label>
                            <input
                              type="number"
                              step="any"
                              value={f.max}
                              onChange={(e) => updateField(f.key, { max: e.target.value })}
                              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-neon-violet/50"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-[10px] font-medium text-muted">step</label>
                            <input
                              type="number"
                              step="any"
                              value={f.step}
                              onChange={(e) => updateField(f.key, { step: e.target.value })}
                              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-neon-violet/50"
                            />
                          </div>
                        </>
                      )}
                      {(f.type === "image" || f.type === "video") && (
                        <p className="sm:col-span-4 self-end text-[10px] text-muted">
                          {f.type === "video"
                            ? "動画タイプはStudio側でドロップゾーン＋インラインプレビューとして表示されます（初期値なし）。node_id/fieldにはLoadVideoノードのfileパラメータ等を指定してください。"
                            : "画像タイプはStudio側でドロップゾーンとして表示されます（初期値なし）。"}
                        </p>
                      )}
                    </div>

                    <div className="mt-2 grid gap-2 sm:grid-cols-4">
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-muted">並び順 (order)</label>
                        <input
                          type="number"
                          value={f.order}
                          onChange={(e) => updateField(f.key, { order: e.target.value })}
                          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-neon-violet/50"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-muted">表示区分</label>
                        <select
                          value={f.section}
                          onChange={(e) =>
                            updateField(f.key, { section: e.target.value as WorkflowInputFieldSection })
                          }
                          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-neon-violet/50"
                        >
                          {WORKFLOW_INPUT_FIELD_SECTIONS.map((s) => (
                            <option key={s} value={s}>
                              {FIELD_SECTION_LABEL[s]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="sm:col-span-2">
                        <label className="mb-1 block text-[10px] font-medium text-muted">
                          追加クレジット (credits_add)
                        </label>
                        <input
                          type="number"
                          value={f.creditsAdd}
                          onChange={(e) => updateField(f.key, { creditsAdd: e.target.value })}
                          placeholder="例: 10（このオプション選択時に基本料へ加算）"
                          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-neon-violet/50"
                        />
                      </div>
                    </div>

                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => removeField(f.key)}
                        className="flex items-center gap-1 text-[11px] text-muted transition-colors hover:text-red-400"
                      >
                        <Trash2 size={12} />
                        削除
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </section>

          {error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          {/* Sticky footer: the modal card itself scrolls (max-h-[90vh]
              overflow-y-auto above), so a save button placed at the natural
              end of a long form — many parameters, a large workflow_json,
              a long node list — could scroll out of view entirely and read
              as "missing" rather than "below the fold". -mx-6/-mb-6 bleeds
              back out through the card's own p-6 so this footer's
              background spans the full card width/bottom edge instead of
              floating with a gap around it. */}
          <div className="sticky bottom-0 z-10 -mx-6 -mb-6 flex items-center justify-end gap-3 rounded-b-2xl border-t border-border bg-surface px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-full border border-border bg-background px-5 py-2.5 text-sm font-medium text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting && <Loader2 size={16} className="animate-spin" />}
              💾 {isEdit ? "変更を保存" : "ワークフローを作成"}
            </button>
          </div>
        </form>
      </div>
    </div>,
        document.body,
      )}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
