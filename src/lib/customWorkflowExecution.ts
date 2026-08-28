import "server-only";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkflowInputField } from "@/lib/customWorkflows";

// Same shape as WanAnimateWorkflow (wanAnimateWorkflow.ts) — a ComfyUI
// API-format graph keyed by node id.
type WorkflowNode = { inputs?: Record<string, unknown>; class_type?: string; _meta?: unknown };
type WorkflowGraph = Record<string, WorkflowNode>;

export type CustomWorkflowFieldValue =
  | string
  | number
  | boolean
  | { fileBuffer: Buffer; fileName: string };

export type PatchedCustomWorkflow = {
  workflow: Record<string, unknown>;
  files: { filename: string; base64: string }[];
};

// Injects each submitted field value into the ComfyUI graph at
// workflow[field.node_id].inputs[field.field] — the same
// workflow["189"].inputs.image = referenceImageName pattern
// buildWanAnimateWorkflow() uses, generalized to an admin-declared
// node_id/field pair per input_schema entry (see CustomWorkflowModal.tsx,
// where the admin picks these while building the workflow). Image/video
// fields get a randomized filename (collision-safe across concurrent
// requests against a possibly-still-warm container) and are returned
// separately in `files` for the caller to upload alongside the graph.
export function patchCustomWorkflow(
  workflowJson: Record<string, unknown>,
  inputSchema: WorkflowInputField[],
  values: Record<string, CustomWorkflowFieldValue>,
): PatchedCustomWorkflow {
  const workflow = structuredClone(workflowJson) as WorkflowGraph;
  const files: { filename: string; base64: string }[] = [];

  for (const field of inputSchema) {
    const node = workflow[field.node_id];
    if (!node || typeof node !== "object" || !node.inputs) continue;

    const value = values[field.id];
    if (value === undefined) continue;

    if (field.type === "image" || field.type === "video") {
      if (typeof value !== "object" || !("fileBuffer" in value)) continue;
      const ext = path.extname(value.fileName) || (field.type === "video" ? ".mp4" : ".png");
      const filename = `${field.id}_${randomUUID()}${ext}`;
      files.push({ filename, base64: value.fileBuffer.toString("base64") });
      node.inputs[field.field] = filename;
    } else if (field.type === "slider") {
      node.inputs[field.field] = typeof value === "number" ? value : Number(value);
    } else if (field.type === "toggle") {
      node.inputs[field.field] = value === true || value === "true";
    } else if (field.type === "select") {
      // Resolve the picked option so a numeric choice (e.g. steps 4/8/20) is
      // written back as a number, not a string.
      const opt = field.options?.find((o) => String(o.value) === String(value));
      node.inputs[field.field] = opt ? opt.value : String(value);
    } else {
      node.inputs[field.field] = String(value);
    }
  }

  return { workflow, files };
}
