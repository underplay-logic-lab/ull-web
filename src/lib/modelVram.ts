// Model-file sizing + GPU VRAM-fit / OOM estimation. Client-safe (no
// "server-only" guard) so both the admin Custom Workflow editor and the UI
// builder can import it. Pure functions only.

import { parseWorkflowNodes } from "@/lib/workflowGraph";
import {
  inferModelCategoryFromFieldName,
  toComfyRelativeName,
} from "@/lib/modelFileCategories";
import {
  WORKFLOW_GPU_TIERS,
  type WorkflowGpuSpec,
  type WorkflowGpuTier,
} from "@/lib/customWorkflows";

// "63.2 GB" / "840 MB" / "512 KB" / "0 B". Binary units (1024).
export function formatBytes(bytes: number | null | undefined): string {
  const n = typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const scaled = n / 1024 ** i;
  // Whole number for bytes, one decimal above.
  return `${i === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[i]}`;
}

const BYTES_PER_GB = 1024 ** 3;

export type VolumeFileLike = { path?: string | null; size_bytes?: number | null };

// Maps every recognizable key for a Volume file to its byte size:
//   - the raw Volume path            ("diffusion_models/wan2.1.safetensors")
//   - the ComfyUI-relative name      ("wan2.1.safetensors")
//   - the bare basename              ("wan2.1.safetensors")
// so a lookup by whatever string a workflow node stores still resolves.
export function buildModelSizeIndex(
  files: VolumeFileLike[] | null | undefined,
): Map<string, number> {
  const index = new Map<string, number>();
  for (const file of files ?? []) {
    const path = typeof file?.path === "string" ? file.path : "";
    const size = typeof file?.size_bytes === "number" ? file.size_bytes : 0;
    if (!path || size <= 0) continue;
    index.set(path, size);
    const comfyName = toComfyRelativeName(path);
    if (comfyName) index.set(comfyName, size);
    const basename = path.split("/").pop() ?? "";
    if (basename && !index.has(basename)) index.set(basename, size);
  }
  return index;
}

export function lookupModelSize(
  index: Map<string, number>,
  name: string | null | undefined,
): number | undefined {
  if (typeof name !== "string" || !name) return undefined;
  return (
    index.get(name) ??
    index.get(toComfyRelativeName(name)) ??
    index.get(name.split("/").pop() ?? "")
  );
}

// Every distinct, non-empty model/VAE/CLIP/LoRA filename referenced by a
// ComfyUI graph's node inputs (same field-name heuristic the file-picker
// combo boxes use).
export function collectWorkflowModelFiles(jsonText: string): string[] {
  const seen = new Set<string>();
  for (const node of parseWorkflowNodes(jsonText)) {
    for (const [fieldName, rawValue] of Object.entries(node.inputs)) {
      if (typeof rawValue !== "string" || !rawValue.trim()) continue;
      if (!inferModelCategoryFromFieldName(fieldName)) continue;
      seen.add(rawValue);
    }
  }
  return [...seen];
}

export type ModelVramEstimate = {
  // Names that matched a Volume file, with their byte size.
  matched: { name: string; bytes: number }[];
  // Referenced model names with no Volume match (size unknown).
  unmatched: string[];
  totalBytes: number;
  totalGb: number;
  // Estimated VRAM needed to load these weights + ComfyUI's inference
  // buffers, in GB (rounded up to a 10 GB step with headroom).
  requiredVramGb: number;
  // GPU tiers whose VRAM covers requiredVramGb, and those that would OOM.
  fitGpus: WorkflowGpuSpec[];
  oomGpus: WorkflowGpuSpec[];
};

// Weights + activation/latent/VAE working set. ComfyUI needs materially
// more than the raw checkpoint size at runtime, so pad by 15% and a flat
// 3 GB, then round the requirement up to the next 10 GB tier so the
// answer reads as a clean capacity target ("80 GB+").
export function estimateRequiredVramGb(totalBytes: number): number {
  const weightsGb = totalBytes / BYTES_PER_GB;
  if (weightsGb <= 0) return 0;
  const withBuffer = weightsGb * 1.15 + 3;
  return Math.ceil(withBuffer / 10) * 10;
}

export function classifyGpusByVram(requiredVramGb: number): {
  fitGpus: WorkflowGpuSpec[];
  oomGpus: WorkflowGpuSpec[];
} {
  if (requiredVramGb <= 0) {
    return { fitGpus: [...WORKFLOW_GPU_TIERS], oomGpus: [] };
  }
  const fitGpus: WorkflowGpuSpec[] = [];
  const oomGpus: WorkflowGpuSpec[] = [];
  for (const spec of WORKFLOW_GPU_TIERS) {
    (spec.vramGb >= requiredVramGb ? fitGpus : oomGpus).push(spec);
  }
  return { fitGpus, oomGpus };
}

// The full estimate for a workflow: which model files it references, their
// combined size, the VRAM that implies, and the GPU fit / OOM split.
export function estimateWorkflowModelVram(
  jsonText: string,
  sizeIndex: Map<string, number>,
): ModelVramEstimate {
  const names = collectWorkflowModelFiles(jsonText);
  const matched: { name: string; bytes: number }[] = [];
  const unmatched: string[] = [];
  for (const name of names) {
    const bytes = lookupModelSize(sizeIndex, name);
    if (typeof bytes === "number" && bytes > 0) matched.push({ name, bytes });
    else unmatched.push(name);
  }
  const totalBytes = matched.reduce((sum, m) => sum + m.bytes, 0);
  const requiredVramGb = estimateRequiredVramGb(totalBytes);
  const { fitGpus, oomGpus } = classifyGpusByVram(requiredVramGb);
  return {
    matched,
    unmatched,
    totalBytes,
    totalGb: totalBytes / BYTES_PER_GB,
    requiredVramGb,
    fitGpus,
    oomGpus,
  };
}

// Whether a single GPU tier would OOM for the given VRAM requirement —
// used to badge fallback-chain rows with a ⚠️.
export function isOomForTier(tier: WorkflowGpuTier, requiredVramGb: number): boolean {
  if (requiredVramGb <= 0) return false;
  const spec = WORKFLOW_GPU_TIERS.find((t) => t.value === tier);
  return spec ? spec.vramGb < requiredVramGb : false;
}
