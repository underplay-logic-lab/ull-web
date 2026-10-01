// 特化ワークフローの実行 GPU の一覧（物理型番・VRAM・時給）。admin とサーバーだけが import すること。
// customWorkflows.ts から分けた（2026-10-01）。Studio の画面が customWorkflows.ts を読むと、この一覧ごと
// ブラウザに配られて型番と時給が誰でも読める状態だったため（CLAUDE.md §2）。
import { SYSTEM_FIELD_GPU_TIER, type WorkflowFieldOption, type WorkflowInputField } from "@/lib/customWorkflows";

// Which Modal GPU a workflow runs on — an admin, per-workflow choice
// (studio_custom_workflows.default_gpu_tier). Passed to Modal as `gpu_tier`.
export type WorkflowGpuTier =
  | "b300"
  | "b200"
  | "h200"
  | "h100"
  | "rtx_pro_6000"
  | "a100_80gb"
  | "a100_40gb"
  | "l40s"
  | "a10"
  | "l4"
  | "t4";

export type WorkflowGpuSpec = {
  value: WorkflowGpuTier;
  // Physical model name — also the default user-facing display name.
  label: string;
  // Compact name for dense UI (fit/OOM lists, chips).
  shortLabel: string;
  // Human string for the physical memory ("288GB HBM3e").
  vram: string;
  // Numeric VRAM capacity in GB — used by the OOM / GPU-fit checker.
  vramGb: number;
  hourlyUsd: number;
};

// The full GPU master, high → low. `hourlyUsd` is the raw Modal hourly cost;
// `vram` the physical memory. Ordered so the select reads top-spec first.
export const WORKFLOW_GPU_TIERS: WorkflowGpuSpec[] = [
  { value: "b300", label: "NVIDIA B300", shortLabel: "B300", vram: "288GB HBM3e", vramGb: 288, hourlyUsd: 7.1 },
  { value: "b200", label: "NVIDIA B200", shortLabel: "B200", vram: "192GB HBM3e", vramGb: 192, hourlyUsd: 6.25 },
  { value: "h200", label: "NVIDIA H200 SXM", shortLabel: "H200", vram: "141GB HBM3e", vramGb: 141, hourlyUsd: 4.54 },
  { value: "h100", label: "NVIDIA H100 SXM5", shortLabel: "H100", vram: "80GB HBM3", vramGb: 80, hourlyUsd: 3.95 },
  {
    value: "rtx_pro_6000",
    label: "NVIDIA RTX PRO 6000",
    shortLabel: "RTX PRO 6000",
    vram: "96GB GDDR7",
    vramGb: 96,
    hourlyUsd: 3.03,
  },
  { value: "a100_80gb", label: "NVIDIA A100 80GB", shortLabel: "A100-80GB", vram: "80GB HBM2e", vramGb: 80, hourlyUsd: 2.5 },
  { value: "a100_40gb", label: "NVIDIA A100 40GB", shortLabel: "A100-40GB", vram: "40GB HBM2", vramGb: 40, hourlyUsd: 2.1 },
  { value: "l40s", label: "NVIDIA L40S", shortLabel: "L40S", vram: "48GB GDDR6", vramGb: 48, hourlyUsd: 1.95 },
  { value: "a10", label: "NVIDIA A10", shortLabel: "A10", vram: "24GB GDDR6", vramGb: 24, hourlyUsd: 1.1 },
  { value: "l4", label: "NVIDIA L4", shortLabel: "L4", vram: "24GB GDDR6", vramGb: 24, hourlyUsd: 0.8 },
  { value: "t4", label: "NVIDIA T4", shortLabel: "T4", vram: "16GB GDDR6", vramGb: 16, hourlyUsd: 0.59 },
];

export const WORKFLOW_GPU_SPEC_BY_TIER: Record<string, WorkflowGpuSpec> = Object.fromEntries(
  WORKFLOW_GPU_TIERS.map((s) => [s.value, s]),
);

export const DEFAULT_WORKFLOW_GPU_TIER: WorkflowGpuTier = "l4";

export function isValidWorkflowGpuTier(value: unknown): value is WorkflowGpuTier {
  return typeof value === "string" && value in WORKFLOW_GPU_SPEC_BY_TIER;
}

// Legacy Standard/ULTRA classification for the two-tier job tracker
// (activeGenerationJobs) — anything ≥ $3.00/h counts as "ultra".
export function isUltraGpuTier(tier: string): boolean {
  return (WORKFLOW_GPU_SPEC_BY_TIER[tier]?.hourlyUsd ?? 0) >= 3.0;
}

// Validates studio_custom_workflows.gpu_fallback_list — a priority-ordered
// array of GPU tier ids. Empty array is valid (the default). Non-arrays,
// unknown tier ids, and duplicates are rejected.
export function isValidWorkflowGpuFallbackList(value: unknown): value is WorkflowGpuTier[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isValidWorkflowGpuTier(item)) return false;
    if (seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

// Normalises a raw (possibly untrusted) fallback list into a clean,
// deduped chain of valid tier ids, always led by `primary`. Used by the
// generate route to build the ordered list sent to Modal.
export function resolveGpuFallbackChain(
  primary: WorkflowGpuTier,
  rawList: unknown,
): WorkflowGpuTier[] {
  const chain: WorkflowGpuTier[] = [primary];
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      if (isValidWorkflowGpuTier(item) && !chain.includes(item)) chain.push(item);
    }
  }
  return chain;
}

// One option per hardware tier, all enabled with no add-on — the admin edits
// label / enabled / credits_add per tier in the inspector. `value` stays the
// tier id so the server can resolve the choice.
export function defaultGpuTierOptions(): WorkflowFieldOption[] {
  return WORKFLOW_GPU_TIERS.map((t) => ({
    label: t.label,
    value: t.value,
    credits_add: 0,
    multiplier: 1,
    enabled: true,
  }));
}

export function makeGpuTierField(): WorkflowInputField {
  return {
    id: SYSTEM_FIELD_GPU_TIER,
    label: "⚡ 実行GPU",
    type: "select",
    node_id: "",
    field: "",
    default: DEFAULT_WORKFLOW_GPU_TIER,
    options: defaultGpuTierOptions(),
    colSpan: 12,
  };
}
