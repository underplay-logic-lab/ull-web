// Shared shape for studio_custom_workflows.input_schema — imported by both
// server code (admin API validation, public API selection) and client
// components (admin builder UI, Studio's dynamic form renderer), so this
// file has no "server-only" guard and no side effects.

export type WorkflowInputFieldType = "text" | "image" | "video" | "slider" | "toggle";

export const WORKFLOW_INPUT_FIELD_TYPES: WorkflowInputFieldType[] = [
  "text",
  "image",
  "video",
  "slider",
  "toggle",
];

export type WorkflowInputFieldSection = "main" | "advanced";

export const WORKFLOW_INPUT_FIELD_SECTIONS: WorkflowInputFieldSection[] = ["main", "advanced"];

// 12-column grid span for the UI builder: 3 = 1/4, 4 = 1/3, 6 = 1/2,
// 12 = full width. Undefined = full width (12), so every field created
// before the builder existed keeps rendering exactly as it did.
export type WorkflowFieldColSpan = 3 | 4 | 6 | 12;

export const WORKFLOW_FIELD_COL_SPANS: WorkflowFieldColSpan[] = [3, 4, 6, 12];

// Subscription tier gate for a field or section — a value below `minTier`
// hides/locks it in the Studio renderer (server also enforces it, Phase 2).
export type WorkflowFieldTier = "free" | "entry" | "standard" | "pro" | "master";

export const WORKFLOW_FIELD_TIERS: WorkflowFieldTier[] = ["free", "entry", "standard", "pro", "master"];

// Named layout section on a workflow (studio_custom_workflows.sections) —
// supersedes the two-way main/advanced split. Phase 1 only defines the
// shape and validator; the renderer/builder wire it in Phase 2.
export type WorkflowSection = {
  id: string;
  label: string;
  description?: string;
  defaultCollapsed?: boolean;
  minTier?: WorkflowFieldTier;
};

export type WorkflowInputField = {
  id: string;
  label: string;
  type: WorkflowInputFieldType;
  node_id: string;
  field: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  // Display order within its section (ascending); ties fall back to array
  // order. Optional so existing rows created before this field was added
  // still validate/render (falls back to array index — see sortFields()).
  order?: number;
  // 'main' fields render directly on the Studio tab; 'advanced' fields are
  // tucked into a collapsed "詳細設定" accordion. Defaults to 'main'.
  section?: WorkflowInputFieldSection;
  // Extra credits added to the workflow's base credits_cost while this
  // field is "actively selected" away from its baseline — see
  // fieldAppliesCreditsAdd() for exactly what that means per type.
  credits_add?: number;
  // --- UI builder layout (all optional; undefined = pre-builder behaviour) ---
  // 12-col grid span (3/4/6/12). Undefined → full width.
  colSpan?: WorkflowFieldColSpan;
  // Explicit grid row; fields without one flow by `order`.
  row?: number;
  // Named section id (references a WorkflowSection). Falls back to `section`.
  sectionId?: string;
  // Lowest subscription tier that may see/use this field.
  minTier?: WorkflowFieldTier;
};

export type StudioCustomWorkflow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  category: string;
  workflow_json: Record<string, unknown>;
  input_schema: WorkflowInputField[];
  credits_cost: number;
  priority: number;
  is_active: boolean;
  // ComfyUI runtime/memory-optimization flags applied when this workflow
  // runs on Modal — see _ensure_comfy_running in scripts/modal_wan_animate.py.
  disable_smart_memory: boolean;
  cpu_vae: boolean;
  gpu_only: boolean;
  use_pytorch_cross_attention: boolean;
  high_vram: boolean;
  extra_args: string;
  // Node id in workflow_json whose output ComfyUI should be read from —
  // empty string means "auto-detect" (see run_custom_workflow in
  // scripts/modal_wan_animate.py).
  output_node_id: string;
  created_at: string;
  updated_at: string;
};

// Public-facing projection served by /api/studio/custom-workflows — no
// workflow_json (the raw ComfyUI graph never needs to reach the browser)
// and none of the admin-only bookkeeping columns.
export type PublicCustomWorkflow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  category: string;
  input_schema: WorkflowInputField[];
  credits_cost: number;
};

export function isValidWorkflowJson(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0
  );
}

export function isValidInputSchema(value: unknown): value is WorkflowInputField[] {
  if (!Array.isArray(value)) return false;

  const seenIds = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return false;
    const f = item as Record<string, unknown>;

    if (typeof f.id !== "string" || !f.id.trim()) return false;
    if (seenIds.has(f.id)) return false;
    seenIds.add(f.id);

    if (typeof f.label !== "string" || !f.label.trim()) return false;
    if (typeof f.type !== "string" || !WORKFLOW_INPUT_FIELD_TYPES.includes(f.type as WorkflowInputFieldType)) {
      return false;
    }
    if (typeof f.node_id !== "string" || !f.node_id.trim()) return false;
    if (typeof f.field !== "string" || !f.field.trim()) return false;
    if (f.min !== undefined && typeof f.min !== "number") return false;
    if (f.max !== undefined && typeof f.max !== "number") return false;
    if (f.step !== undefined && typeof f.step !== "number") return false;
    if (
      f.default !== undefined &&
      typeof f.default !== "string" &&
      typeof f.default !== "number" &&
      typeof f.default !== "boolean"
    ) {
      return false;
    }
    if (f.order !== undefined && typeof f.order !== "number") return false;
    if (f.section !== undefined && !WORKFLOW_INPUT_FIELD_SECTIONS.includes(f.section as WorkflowInputFieldSection)) {
      return false;
    }
    if (f.credits_add !== undefined && typeof f.credits_add !== "number") return false;
    // UI builder layout fields — all optional, all backward compatible.
    if (
      f.colSpan !== undefined &&
      !WORKFLOW_FIELD_COL_SPANS.includes(f.colSpan as WorkflowFieldColSpan)
    ) {
      return false;
    }
    if (f.row !== undefined && typeof f.row !== "number") return false;
    if (f.sectionId !== undefined && (typeof f.sectionId !== "string" || !f.sectionId.trim())) return false;
    if (
      f.minTier !== undefined &&
      !WORKFLOW_FIELD_TIERS.includes(f.minTier as WorkflowFieldTier)
    ) {
      return false;
    }
  }

  return true;
}

// Validates studio_custom_workflows.sections — a plain array of named
// layout sections. Empty array is valid (the default).
export function isValidWorkflowSections(value: unknown): value is WorkflowSection[] {
  if (!Array.isArray(value)) return false;

  const seenIds = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return false;
    const s = item as Record<string, unknown>;

    if (typeof s.id !== "string" || !s.id.trim()) return false;
    if (seenIds.has(s.id)) return false;
    seenIds.add(s.id);

    if (typeof s.label !== "string" || !s.label.trim()) return false;
    if (s.description !== undefined && typeof s.description !== "string") return false;
    if (s.defaultCollapsed !== undefined && typeof s.defaultCollapsed !== "boolean") return false;
    if (
      s.minTier !== undefined &&
      !WORKFLOW_FIELD_TIERS.includes(s.minTier as WorkflowFieldTier)
    ) {
      return false;
    }
  }

  return true;
}

// Stable sort by `order` (ascending, undefined last), preserving original
// array position among ties/undefined — used to render both the 'main'
// group and the 'advanced' accordion in the admin's declared order.
export function sortFieldsByOrder(fields: WorkflowInputField[]): WorkflowInputField[] {
  return fields
    .map((field, index) => ({ field, index }))
    .sort((a, b) => {
      const orderA = a.field.order ?? Number.POSITIVE_INFINITY;
      const orderB = b.field.order ?? Number.POSITIVE_INFINITY;
      if (orderA !== orderB) return orderA - orderB;
      return a.index - b.index;
    })
    .map((entry) => entry.field);
}

// Whether `field.credits_add` currently applies to the total, given the
// field's present value in the Studio form:
//   - image/video: applies once a file is attached (no baseline "default" exists).
//   - toggle: applies while ON.
//   - slider: applies once moved away from its default (or min, if no
//     default was set).
//   - text: applies once non-empty and different from its default.
export function fieldAppliesCreditsAdd(field: WorkflowInputField, value: unknown): boolean {
  if (!field.credits_add) return false;

  if (field.type === "image" || field.type === "video") return value !== null && value !== undefined;
  if (field.type === "toggle") return value === true;
  if (field.type === "slider") {
    const baseline = typeof field.default === "number" ? field.default : (field.min ?? 0);
    return typeof value === "number" && value !== baseline;
  }
  if (field.type === "text") {
    const baseline = typeof field.default === "string" ? field.default : "";
    return typeof value === "string" && value.trim() !== "" && value !== baseline;
  }
  return false;
}
