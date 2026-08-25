"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Loader2, Plus, Trash2, UploadCloud, X, Zap } from "lucide-react";
import {
  WORKFLOW_INPUT_FIELD_TYPES,
  WORKFLOW_INPUT_FIELD_SECTIONS,
  isValidWorkflowJson,
  type WorkflowInputField,
  type WorkflowInputFieldType,
  type WorkflowInputFieldSection,
} from "@/lib/customWorkflows";
import type { StudioCustomWorkflow } from "./types";

const FIELD_TYPE_LABEL: Record<WorkflowInputFieldType, string> = {
  text: "テキスト",
  image: "画像",
  video: "動画",
  slider: "スライダー",
  toggle: "トグル",
};

const FIELD_SECTION_LABEL: Record<WorkflowInputFieldSection, string> = {
  main: "通常表示",
  advanced: "詳細設定（アコーディオン）",
};

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
  };
}

// One entry per top-level key in workflow_json (a ComfyUI API-format graph:
// { [node_id]: { class_type, inputs, _meta?: { title } } }).
type WorkflowNodeInfo = {
  nodeId: string;
  classType: string;
  title: string;
  inputs: Record<string, unknown>;
};

function parseWorkflowNodes(jsonText: string): WorkflowNodeInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const nodes: WorkflowNodeInfo[] = [];
  for (const [nodeId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const classType = typeof v.class_type === "string" ? v.class_type : "";
    const meta = v._meta as Record<string, unknown> | undefined;
    const title =
      (meta && typeof meta.title === "string" && meta.title) ||
      (typeof v.title === "string" ? (v.title as string) : "") ||
      classType ||
      nodeId;
    const inputs =
      v.inputs && typeof v.inputs === "object" && !Array.isArray(v.inputs)
        ? (v.inputs as Record<string, unknown>)
        : {};
    nodes.push({ nodeId, classType, title, inputs });
  }
  return nodes;
}

// Suggested Japanese labels for common ComfyUI input field names — falls
// back to a title-cased version of the field name when not listed here.
const FIELD_LABEL_SUGGESTIONS: Record<string, string> = {
  image: "入力画像",
  text: "プロンプト",
  prompt: "プロンプト",
  negative: "ネガティブプロンプト",
  seed: "シード値",
  steps: "ステップ数",
  cfg: "CFGスケール",
  denoise: "ノイズ除去強度",
  strength_model: "LoRA強度 (Model)",
  strength_clip: "LoRA強度 (CLIP)",
  width: "幅",
  height: "高さ",
  batch_size: "バッチサイズ",
  video: "入力動画",
  file: "入力ファイル",
};

function suggestFieldLabel(fieldName: string): string {
  if (FIELD_LABEL_SUGGESTIONS[fieldName]) return FIELD_LABEL_SUGGESTIONS[fieldName];
  return fieldName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Requirement 4's type inference: node/field-name heuristics first (image,
// video, text), then the actual current value's JS type as a fallback.
function inferFieldType(classType: string, fieldName: string, rawValue: unknown): WorkflowInputFieldType {
  if (fieldName === "image" || classType === "LoadImage") return "image";
  // LoadVideo's actual input is named "file" (see wanAnimateWorkflow.ts's
  // "240" node), so class_type is the reliable signal — "video" as a
  // fallback for node types that do name it that way.
  if (classType === "LoadVideo" || fieldName === "video") return "video";
  if (fieldName === "text" || classType === "CLIPTextEncode") return "text";
  if (typeof rawValue === "number") return "slider";
  if (typeof rawValue === "boolean") return "toggle";
  return "text";
}

function inferSliderRange(fieldName: string, rawValue: unknown): { default: number; min: number; max: number; step: number } {
  const value = typeof rawValue === "number" ? rawValue : 0;
  if (fieldName === "cfg") return { default: value, min: 1, max: 20, step: 0.1 };
  if (fieldName === "steps") return { default: value, min: 1, max: 100, step: 1 };
  if (fieldName === "seed") return { default: value, min: 0, max: 4294967295, step: 1 };
  if (/strength|denoise/.test(fieldName)) return { default: value, min: 0, max: 1, step: 0.01 };
  if (Number.isInteger(value)) return { default: value, min: 0, max: value > 0 ? value * 2 : 100, step: 1 };
  return { default: value, min: 0, max: 1, step: 0.01 };
}

function draftToField(draft: FieldDraft): WorkflowInputField {
  const base = {
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

  const parsedNodes = useMemo(() => parseWorkflowNodes(values.workflowJsonText), [values.workflowJsonText]);
  const outputNodeCandidates = useMemo(
    () => parsedNodes.filter((n) => OUTPUT_NODE_CLASS_TYPES.has(n.classType)),
    [parsedNodes],
  );

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

  // Builds the auto-inferred patch (type, label, default/min/max/step) for a
  // given node + field-name combination — shared by the node_id and field
  // dropdown change handlers below (requirement 3/4: field list + type auto-
  // inference re-run every time either dropdown changes).
  const buildInferredPatch = (
    node: WorkflowNodeInfo | undefined,
    fieldName: string,
    currentDraft: FieldDraft,
  ): Partial<FieldDraft> => {
    const rawValue = node?.inputs[fieldName];
    const type = inferFieldType(node?.classType ?? "", fieldName, rawValue);
    const patch: Partial<FieldDraft> = {
      field: fieldName,
      type,
      label: suggestFieldLabel(fieldName),
      id: currentDraft.id.trim() ? currentDraft.id : fieldName,
      defaultValue: "",
      min: "",
      max: "",
      step: "",
    };
    if (type === "slider") {
      const range = inferSliderRange(fieldName, rawValue);
      patch.defaultValue = String(range.default);
      patch.min = String(range.min);
      patch.max = String(range.max);
      patch.step = String(range.step);
    } else if (type === "toggle") {
      patch.defaultValue = rawValue === true ? "true" : "false";
    } else if (type === "text" && typeof rawValue === "string") {
      patch.defaultValue = rawValue;
    }
    return patch;
  };

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

  return createPortal(
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
                          <label className="mb-1 block text-[10px] font-medium text-muted">初期値</label>
                          <input
                            value={f.defaultValue}
                            onChange={(e) => updateField(f.key, { defaultValue: e.target.value })}
                            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-neon-violet/50"
                          />
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

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && <Loader2 size={16} className="animate-spin" />}
            {isEdit ? "変更を保存" : "ワークフローを作成"}
          </button>
        </form>
      </div>
    </div>,
    document.body,
  );
}
