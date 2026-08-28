// ComfyUI API-format graph helpers + input-field inference — shared by the
// admin Custom Workflow editor (CustomWorkflowModal.tsx) and the Phase 1+
// UI builder. Extracted verbatim from CustomWorkflowModal.tsx so both can
// use them; no "server-only" guard and no side effects (pure functions).

import type { WorkflowInputFieldType } from "@/lib/customWorkflows";

// One entry per top-level key in workflow_json (a ComfyUI API-format graph:
// { [node_id]: { class_type, inputs, _meta?: { title } } }).
export type WorkflowNodeInfo = {
  nodeId: string;
  classType: string;
  title: string;
  inputs: Record<string, unknown>;
};

export function parseWorkflowNodes(jsonText: string): WorkflowNodeInfo[] {
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

// A ComfyUI API-format graph link: [sourceNodeId, sourceOutputSlot]. Node ids
// are always exported as strings, which is what distinguishes a real link
// from a same-shaped literal value (e.g. a [width, height] pair, which is
// [number, number]).
export function isLinkValue(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}

export type BypassSnapshotEntry = { nodeId: string; inputName: string; originalValue: [string, number] };

// Rewires every downstream node currently pointing at `nodeId` to instead
// point at whatever `nodeId` itself was fed from — the "🚫 バイパス" button's
// effect: skip this node, wire its consumers straight to its own source.
// Node N itself is never touched (its class_type/inputs are left exactly as
// they are), so toggling bypass off is a pure inverse via the returned
// snapshot, and N — now referenced by nothing — simply never executes
// rather than needing to be deleted or otherwise marked.
//
// Slots are matched positionally: N's own link-type inputs, in declaration
// order, stand in for its (unknown — API-format JSON carries no output
// schema) output slots. This mirrors how simple wrapper/patch nodes are
// written (LoraLoader's "model"/"clip" inputs and MODEL/CLIP outputs are
// both declared in that same order), which covers the LoraLoader /
// LoraLoaderModelOnly / EasyCache / SageAttention-style patch nodes this
// feature targets. A downstream connection whose slot has no positional
// match on N is left untouched rather than guessed at.
export function bypassNode(
  jsonText: string,
  nodeId: string,
): { text: string; snapshot: BypassSnapshotEntry[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const targetNode = obj[nodeId];
  if (!targetNode || typeof targetNode !== "object" || Array.isArray(targetNode)) return null;
  const targetInputs = (targetNode as Record<string, unknown>).inputs;
  if (!targetInputs || typeof targetInputs !== "object" || Array.isArray(targetInputs)) return null;

  const upstreamBySlot: [string, number][] = [];
  for (const value of Object.values(targetInputs as Record<string, unknown>)) {
    if (isLinkValue(value)) upstreamBySlot.push(value);
  }
  if (upstreamBySlot.length === 0) return null;

  const snapshot: BypassSnapshotEntry[] = [];
  for (const [otherNodeId, otherNode] of Object.entries(obj)) {
    if (otherNodeId === nodeId) continue;
    if (!otherNode || typeof otherNode !== "object" || Array.isArray(otherNode)) continue;
    const inputs = (otherNode as Record<string, unknown>).inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) continue;
    const inputsObj = inputs as Record<string, unknown>;

    for (const [inputName, value] of Object.entries(inputsObj)) {
      if (!isLinkValue(value)) continue;
      const [refId, refSlot] = value;
      if (refId !== nodeId) continue;
      const replacement = upstreamBySlot[refSlot];
      if (!replacement) continue; // no matching pass-through slot — leave this connection alone
      snapshot.push({ nodeId: otherNodeId, inputName, originalValue: value });
      inputsObj[inputName] = replacement;
    }
  }

  return { text: JSON.stringify(obj, null, 2), snapshot };
}

// Inverse of bypassNode — restores every rewired downstream input back to
// its pre-bypass value from the snapshot bypassNode returned.
export function restoreBypass(jsonText: string, snapshot: BypassSnapshotEntry[]): string {
  if (snapshot.length === 0) return jsonText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return jsonText;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return jsonText;
  const obj = parsed as Record<string, unknown>;

  for (const entry of snapshot) {
    const node = obj[entry.nodeId];
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const inputs = (node as Record<string, unknown>).inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) continue;
    (inputs as Record<string, unknown>)[entry.inputName] = entry.originalValue;
  }

  return JSON.stringify(obj, null, 2);
}

// Rewrites one node's one input value inside the raw workflow_json text —
// backs the "モデル / VAE / CLIP / LoRA ファイル" combo boxes, which edit
// workflow_json node values directly rather than going through input_schema.
// Returns the text unchanged (rather than throwing) if the JSON, node, or
// inputs object isn't in the expected shape, since this runs on every
// keystroke/selection.
export function updateNodeInputValue(
  jsonText: string,
  nodeId: string,
  fieldName: string,
  newValue: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return jsonText;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return jsonText;
  const obj = parsed as Record<string, unknown>;

  const node = obj[nodeId];
  if (!node || typeof node !== "object" || Array.isArray(node)) return jsonText;
  const nodeObj = node as Record<string, unknown>;

  const inputs = nodeObj.inputs;
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return jsonText;
  (inputs as Record<string, unknown>)[fieldName] = newValue;

  return JSON.stringify(obj, null, 2);
}

// Suggested Japanese labels for common ComfyUI input field names — falls
// back to a title-cased version of the field name when not listed here.
export const FIELD_LABEL_SUGGESTIONS: Record<string, string> = {
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

export function suggestFieldLabel(fieldName: string): string {
  if (FIELD_LABEL_SUGGESTIONS[fieldName]) return FIELD_LABEL_SUGGESTIONS[fieldName];
  return fieldName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Type inference: node/field-name heuristics first (image, video, text),
// then the actual current value's JS type as a fallback.
export function inferFieldType(
  classType: string,
  fieldName: string,
  rawValue: unknown,
): WorkflowInputFieldType {
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

export function inferSliderRange(
  fieldName: string,
  rawValue: unknown,
): { default: number; min: number; max: number; step: number } {
  const value = typeof rawValue === "number" ? rawValue : 0;
  if (fieldName === "cfg") return { default: value, min: 1, max: 20, step: 0.1 };
  if (fieldName === "steps") return { default: value, min: 1, max: 100, step: 1 };
  if (fieldName === "seed") return { default: value, min: 0, max: 4294967295, step: 1 };
  if (/strength|denoise/.test(fieldName)) return { default: value, min: 0, max: 1, step: 0.01 };
  if (Number.isInteger(value)) return { default: value, min: 0, max: value > 0 ? value * 2 : 100, step: 1 };
  return { default: value, min: 0, max: 1, step: 0.01 };
}

// The subset of the admin editor's per-field "draft" shape that field
// inference produces — a Partial of this is spread onto a FieldDraft in the
// editor (every key here is also a FieldDraft key with the same type).
export type InferredFieldPatch = {
  field: string;
  type: WorkflowInputFieldType;
  label: string;
  id: string;
  defaultValue: string;
  min: string;
  max: string;
  step: string;
};

// Builds the auto-inferred patch (type, label, default/min/max/step) for a
// given node + field-name combination — shared by the node_id and field
// dropdown change handlers in the editor (field list + type auto-inference
// re-run every time either dropdown changes). `currentDraft` only needs its
// `id` (kept as-is when already set, seeded from the field name otherwise).
export function buildInferredPatch(
  node: WorkflowNodeInfo | undefined,
  fieldName: string,
  currentDraft: { id: string },
): Partial<InferredFieldPatch> {
  const rawValue = node?.inputs[fieldName];
  const type = inferFieldType(node?.classType ?? "", fieldName, rawValue);
  const patch: Partial<InferredFieldPatch> = {
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
}
