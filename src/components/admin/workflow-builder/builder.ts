// Shared helpers for the workflow UI builder (Phase 2).

import type { WorkflowInputField } from "@/lib/customWorkflows";
import {
  inferFieldType,
  inferSliderRange,
  suggestFieldLabel,
  type WorkflowNodeInfo,
} from "@/lib/workflowGraph";

export const UNSECTIONED = "__none__";

let idSeq = 0;
// Field ids only need to be unique within a workflow's input_schema and
// stable for the editing session; a short suffix off a monotonic counter is
// plenty and keeps them readable.
export function makeFieldId(base: string, existing: Set<string>): string {
  const slug = (base || "field").replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "field";
  if (!existing.has(slug)) return slug;
  idSeq += 1;
  let candidate = `${slug}_${idSeq}`;
  while (existing.has(candidate)) {
    idSeq += 1;
    candidate = `${slug}_${idSeq}`;
  }
  return candidate;
}

// Rewrites every field's `order` to match array position — call after any
// reorder so the Studio renderer (sortFieldsByOrder) shows the same order.
export function renumberOrder(fields: WorkflowInputField[]): WorkflowInputField[] {
  return fields.map((f, i) => ({ ...f, order: i }));
}

// Builds a fresh input_schema entry for a node input the admin chose to
// expose, using the same inference the modal editor uses.
export function fieldFromNodeInput(
  node: WorkflowNodeInfo,
  fieldName: string,
  existingIds: Set<string>,
): WorkflowInputField {
  const rawValue = node.inputs[fieldName];
  const type = inferFieldType(node.classType, fieldName, rawValue);
  const base: WorkflowInputField = {
    id: makeFieldId(fieldName, existingIds),
    label: suggestFieldLabel(fieldName),
    type,
    node_id: node.nodeId,
    field: fieldName,
    colSpan: 12,
  };

  if (type === "slider") {
    const range = inferSliderRange(fieldName, rawValue);
    return { ...base, default: range.default, min: range.min, max: range.max, step: range.step };
  }
  if (type === "toggle") {
    return { ...base, default: rawValue === true };
  }
  if (type === "text" && typeof rawValue === "string") {
    return { ...base, default: rawValue };
  }
  return base;
}

// Which "bucket" a field renders in on the canvas: its sectionId, or the
// shared unsectioned bucket.
export function fieldBucket(field: WorkflowInputField): string {
  return field.sectionId && field.sectionId.trim() ? field.sectionId : UNSECTIONED;
}
