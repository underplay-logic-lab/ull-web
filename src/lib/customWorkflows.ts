// Shared shape for studio_custom_workflows.input_schema — imported by both
// server code (admin API validation, public API selection) and client
// components (admin builder UI, Studio's dynamic form renderer), so this
// file has no "server-only" guard and no side effects.

export type WorkflowInputFieldType = "text" | "image" | "video" | "slider" | "toggle" | "select";

export const WORKFLOW_INPUT_FIELD_TYPES: WorkflowInputFieldType[] = [
  "text",
  "image",
  "video",
  "slider",
  "toggle",
  "select",
];

// One choice on a "select" field. `credits_add` is added to the total while
// this option is selected; `is_base_override` instead makes `credits_add`
// the new base price (replacing the workflow's credits_cost) — for
// resolution/quality tiers where the price isn't "base + extra" but a flat
// per-tier amount. See calculateTotalWorkflowCredits().
export type WorkflowFieldOption = {
  label: string;
  value: string | number;
  credits_add?: number;
  is_base_override?: boolean;
};

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

// Which Modal GPU a workflow runs on — an admin, per-workflow choice
// (studio_custom_workflows.default_gpu_tier), independent of the user-facing
// Standard/ULTRA selector. Passed through to the Modal request as `gpu_tier`.
export type WorkflowGpuTier = "t4" | "l4" | "a100_40gb" | "a100_80gb" | "h100" | "b300";

export const WORKFLOW_GPU_TIERS: { value: WorkflowGpuTier; label: string }[] = [
  { value: "t4", label: "T4" },
  { value: "l4", label: "L4" },
  { value: "a100_40gb", label: "A100 40GB" },
  { value: "a100_80gb", label: "A100 80GB" },
  { value: "h100", label: "H100" },
  { value: "b300", label: "B300 (Blackwell Ultra)" },
];

export const DEFAULT_WORKFLOW_GPU_TIER: WorkflowGpuTier = "l4";

export function isValidWorkflowGpuTier(value: unknown): value is WorkflowGpuTier {
  return typeof value === "string" && WORKFLOW_GPU_TIERS.some((t) => t.value === value);
}

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
  // --- Field height (all optional) ---
  // "text": textarea row count (2 / 4 / 6 / 8 …). Undefined → 3.
  rows?: number;
  // "image" / "video": dropzone height preset.
  heightPreset?: "compact" | "standard" | "large" | "square";
  // --- Dynamic credit pricing (all optional) ---
  // Choices for a "select" field.
  options?: WorkflowFieldOption[];
  // "slider" per-unit pricing: every whole unit of the field's value above
  // credits_baseline adds credits_per_unit. Undefined credits_per_unit =>
  // the slider uses the flat credits_add behaviour instead.
  credits_baseline?: number;
  credits_per_unit?: number;
};

export type StudioCustomWorkflow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  category: string;
  workflow_json: Record<string, unknown>;
  input_schema: WorkflowInputField[];
  // Named layout sections (studio_custom_workflows.sections). May be absent
  // on rows read before the 20260841000000 migration ran.
  sections?: WorkflowSection[];
  // Modal GPU this workflow runs on. Absent on rows read before the
  // 20260842000000 migration ran.
  default_gpu_tier?: WorkflowGpuTier;
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
    // Field height.
    if (f.rows !== undefined && typeof f.rows !== "number") return false;
    if (
      f.heightPreset !== undefined &&
      !["compact", "standard", "large", "square"].includes(f.heightPreset as string)
    ) {
      return false;
    }
    // Dynamic credit pricing.
    if (f.credits_baseline !== undefined && typeof f.credits_baseline !== "number") return false;
    if (f.credits_per_unit !== undefined && typeof f.credits_per_unit !== "number") return false;
    if (f.options !== undefined) {
      if (!Array.isArray(f.options)) return false;
      for (const opt of f.options) {
        if (!opt || typeof opt !== "object") return false;
        const o = opt as Record<string, unknown>;
        if (typeof o.label !== "string" || !o.label.trim()) return false;
        if (typeof o.value !== "string" && typeof o.value !== "number") return false;
        if (o.credits_add !== undefined && typeof o.credits_add !== "number") return false;
        if (o.is_base_override !== undefined && typeof o.is_base_override !== "boolean") return false;
      }
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

export type WorkflowCreditsInput = {
  // The workflow's base price (studio_custom_workflows.credits_cost).
  creditsCost: number;
  inputSchema: WorkflowInputField[];
  // Current form values keyed by field id. File-typed values may be a File,
  // a Buffer wrapper, or anything truthy — only their presence matters here.
  values: Record<string, unknown>;
  // Flat add-on for the selected GPU tier (0 for Standard).
  gpuTierAddon?: number;
};

export type WorkflowCreditsBreakdown = {
  // The effective base: credits_cost, or a selected is_base_override option's amount.
  base: number;
  // Sum of every field add-on currently in effect.
  addons: number;
  gpuTierAddon: number;
  total: number;
};

// The single source of truth for what a workflow generation costs — used by
// the Studio renderer (live total), the builder (⚡ preview), and the
// server generate route (actual debit). Never trust a client-sent total.
//
//   total = base + Σ(field add-ons) + gpuTierAddon
//
// where `base` is credits_cost unless a selected "select" option is marked
// is_base_override, in which case that option's credits_add becomes the base
// (the last such option in schema order wins).
export function workflowCreditsBreakdown(input: WorkflowCreditsInput): WorkflowCreditsBreakdown {
  const { creditsCost, inputSchema, values, gpuTierAddon = 0 } = input;

  let base = creditsCost;
  let addons = 0;

  for (const field of inputSchema) {
    const value = values[field.id];

    if (field.type === "select" && Array.isArray(field.options)) {
      const opt = field.options.find((o) => String(o.value) === String(value));
      if (opt) {
        if (opt.is_base_override) {
          if (typeof opt.credits_add === "number") base = opt.credits_add;
        } else if (typeof opt.credits_add === "number") {
          addons += opt.credits_add;
        }
      }
      continue;
    }

    if (field.type === "slider" && typeof field.credits_per_unit === "number") {
      const num = typeof value === "number" ? value : Number(value);
      const baseline =
        typeof field.credits_baseline === "number"
          ? field.credits_baseline
          : typeof field.default === "number"
            ? field.default
            : field.min ?? 0;
      if (Number.isFinite(num) && num > baseline) {
        addons += Math.ceil(num - baseline) * field.credits_per_unit;
      }
      continue;
    }

    // toggle / text / image / video (and sliders without per-unit pricing):
    // the flat credits_add, applied when the field is "actively selected".
    if (fieldAppliesCreditsAdd(field, value)) {
      addons += field.credits_add ?? 0;
    }
  }

  base = Math.max(0, Math.round(base));
  addons = Math.round(addons);
  const total = Math.max(0, base + addons + Math.round(gpuTierAddon));
  return { base, addons, gpuTierAddon: Math.round(gpuTierAddon), total };
}

// Just the total — the common case, and the shape existing callers expect.
export function calculateTotalWorkflowCredits(input: WorkflowCreditsInput): number {
  return workflowCreditsBreakdown(input).total;
}
