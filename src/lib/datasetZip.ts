// Browser-side dataset ZIP unpacking for the LoRA Studio curation UI.
// jszip is dynamically imported so it never lands in the main bundle.

export type ParsedDatasetEntry = {
  // The image's filename inside the ZIP (already system-renamed by an
  // earlier export, e.g. "0001.png").
  name: string;
  file: File;
  // The paired "<stem>.txt" content, or "" when the ZIP had no caption.
  caption: string;
};

const IMG_RE = /\.(png|jpe?g|webp)$/i;

function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

export function isZipFile(file: File): boolean {
  return (
    /\.zip$/i.test(file.name) ||
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed"
  );
}

// Unpacks a dataset ZIP, pairing each image with its same-stem .txt caption.
// Images are returned sorted by filename (numeric-aware) and capped at
// `maxImages`.
export async function parseDatasetZip(
  zipFile: File,
  opts: { maxImages?: number } = {},
): Promise<ParsedDatasetEntry[]> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(zipFile);

  const captionByStem = new Map<string, string>();
  const images: { stem: string; name: string; path: string }[] = [];

  for (const path of Object.keys(zip.files)) {
    const entry = zip.files[path];
    if (entry.dir) continue;
    const base = path.split("/").pop() ?? path;
    if (!base || base.startsWith(".") || path.startsWith("__MACOSX")) continue;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    if (IMG_RE.test(base)) {
      images.push({ stem, name: base, path });
    } else if (/\.txt$/i.test(base)) {
      captionByStem.set(stem, (await entry.async("string")).trim());
    }
  }

  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  const max = opts.maxImages ?? 200;
  const out: ParsedDatasetEntry[] = [];
  for (const img of images.slice(0, max)) {
    const blob = await zip.files[img.path].async("blob");
    const file = new File([blob], img.name, { type: mimeFor(img.name) });
    out.push({ name: img.name, file, caption: captionByStem.get(img.stem) ?? "" });
  }
  return out;
}

// Pack an in-memory dataset (image File + its caption text) into a ZIP the
// worker can re-ingest verbatim: every image becomes "0001.<ext>" and its
// caption "0001.txt" right beside it. Returns the ZIP as a Blob.
export async function buildDatasetZip(
  entries: { file: File; caption: string }[],
): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  entries.forEach((e, i) => {
    const ext = (e.file.name.match(/\.(png|jpe?g|webp)$/i)?.[1] ?? "png").toLowerCase();
    const stem = String(i + 1).padStart(4, "0");
    zip.file(`${stem}.${ext === "jpeg" ? "jpg" : ext}`, e.file);
    zip.file(`${stem}.txt`, e.caption ?? "");
  });
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

// Trigger a browser download of a Blob under `filename`.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
