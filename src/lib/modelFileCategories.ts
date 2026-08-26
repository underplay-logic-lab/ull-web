// Client-safe categorization of Modal Volume files into the model-type
// buckets used by the admin custom-workflow editor's file-picker combo
// boxes (CustomWorkflowModal.tsx). Deliberately has no "server-only" guard
// (unlike modalStorage.ts) so a client component can import it directly.

export type ModelFileCategory = "diffusion_models" | "vae" | "clip" | "loras" | "checkpoints";

export const MODEL_FILE_CATEGORIES: ModelFileCategory[] = [
  "diffusion_models",
  "vae",
  "clip",
  "loras",
  "checkpoints",
];

const MODEL_FILE_EXTENSIONS = [".safetensors", ".ckpt", ".pt", ".bin"];

// Volume path segment -> category. Mirrors the real folder layout (see
// MODEL_SUBFOLDERS in scripts/modal_wan_animate.py / modalStorage.ts) plus a
// couple of common ComfyUI folder aliases (unet/, text_encoders/) that files
// pulled in via the admin's repo bulk-downloader may land under.
const FOLDER_TO_CATEGORY: Record<string, ModelFileCategory> = {
  diffusion_models: "diffusion_models",
  unet: "diffusion_models",
  vae: "vae",
  clip: "clip",
  clip_vision: "clip",
  text_encoders: "clip",
  loras: "loras",
  checkpoints: "checkpoints",
};

// Guards against malformed Volume-listing entries (a missing/null `path`
// from a partial API response, a storage backend hiccup, etc.) — every
// helper below runs on every keystroke/render of the admin's workflow
// editor, so a single bad row must degrade gracefully instead of throwing
// and blanking the whole modal (save button included, since it lives in
// the same render tree).
export function hasModelExtension(path: string | null | undefined): boolean {
  if (typeof path !== "string" || !path) return false;
  const lower = path.toLowerCase();
  return MODEL_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Every model-extension file on the Volume, regardless of folder/category —
// the "全モデル一覧" fallback so an admin can always find a file even if
// categoryForPath's folder-name heuristic doesn't recognize where it lives
// (e.g. a custom folder layout, or a category this module doesn't know
// about yet).
export function listAllModelFiles(files: { path: string }[] | null | undefined): string[] {
  return (files ?? [])
    .filter((f) => hasModelExtension(f?.path))
    .map((f) => toComfyRelativeName(f.path))
    .sort((a, b) => a.localeCompare(b));
}

// Categorizes by the file's Volume folder — checks every path segment (not
// just the first) so nested layouts (e.g. a snapshot_download'd repo under
// diffusion_models/some-repo/...) still resolve.
function categoryForPath(path: string | null | undefined): ModelFileCategory | null {
  if (typeof path !== "string" || !path) return null;
  for (const segment of path.split("/")) {
    const category = FOLDER_TO_CATEGORY[segment];
    if (category) return category;
  }
  return null;
}

// Volume file listing paths are relative to the Volume mount (e.g.
// "diffusion_models/wan2.1.safetensors"), but ComfyUI's own loader nodes
// (UNETLoader.unet_name, VAELoader.vae_name, ...) store filenames relative
// to *that model-type folder itself* — no "diffusion_models/" prefix (see
// workflow_json samples like wan_animate2_export.json: "unet_name":
// "wan_animate_2_int8_convrot.safetensors"). Comparing/writing raw Volume
// paths against those values would never match (every combo box would
// silently fail to preselect the model actually configured), so this strips
// through the first recognized category-folder segment — mirroring
// categoryForPath's "search every segment" behavior — leaving exactly what
// ComfyUI expects, including any nested subfolder a repo download may have
// created (e.g. "diffusion_models/some-repo/model.safetensors" ->
// "some-repo/model.safetensors"). Falls back to the full path when no
// recognized segment is found, since there's nothing meaningful to strip.
export function toComfyRelativeName(path: string | null | undefined): string {
  if (typeof path !== "string" || !path) return "";
  const segments = path.split("/");
  const idx = segments.findIndex((segment) => FOLDER_TO_CATEGORY[segment]);
  if (idx === -1) return path;
  return segments.slice(idx + 1).join("/");
}

export function categorizeVolumeFiles(
  files: { path: string }[] | null | undefined,
): Record<ModelFileCategory, string[]> {
  const result: Record<ModelFileCategory, string[]> = {
    diffusion_models: [],
    vae: [],
    clip: [],
    loras: [],
    checkpoints: [],
  };
  for (const file of files ?? []) {
    if (!hasModelExtension(file?.path)) continue;
    const category = categoryForPath(file.path);
    if (category) result[category].push(toComfyRelativeName(file.path));
  }
  for (const category of MODEL_FILE_CATEGORIES) {
    result[category].sort((a, b) => a.localeCompare(b));
  }
  return result;
}

// Field-name heuristics for the model/VAE/CLIP/LoRA picker — matches the
// common ComfyUI loader input names (CheckpointLoaderSimple.ckpt_name,
// UNETLoader.unet_name, VAELoader.vae_name, CLIPLoader.clip_name,
// LoraLoader.lora_name, and *_1/*_2-suffixed variants some multi-LoRA nodes
// use). Order matters: more specific patterns are checked first.
const FIELD_NAME_CATEGORY_PATTERNS: [RegExp, ModelFileCategory][] = [
  [/vae_name/i, "vae"],
  [/unet_name/i, "diffusion_models"],
  [/clip_name/i, "clip"],
  [/lora_name/i, "loras"],
  [/ckpt_name|checkpoint_name/i, "checkpoints"],
  // Generic "model_name" is ambiguous across loader node types —
  // diffusion_models is the more common case in this project's workflows,
  // so it's the default guess. The combo box always allows manual entry, so
  // a wrong guess here is never a dead end.
  [/model_name/i, "diffusion_models"],
];

export function inferModelCategoryFromFieldName(fieldName: string | null | undefined): ModelFileCategory | null {
  if (typeof fieldName !== "string" || !fieldName) return null;
  for (const [pattern, category] of FIELD_NAME_CATEGORY_PATTERNS) {
    if (pattern.test(fieldName)) return category;
  }
  return null;
}
