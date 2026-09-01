import { supabase } from "@/lib/supabaseClient";

// Client-side AI-vision auto-captioning for the LoRA Studio dataset.
//
// Each image is downscaled to a small JPEG in the browser (so the request
// stays well under Vercel's 4.5 MB body cap — no upload needed) and sent to
// /api/studio/lora/caption in batches. Returns captions aligned to the input
// order; a blank entry means that image couldn't be captioned (the Modal
// worker's local VLM fills those gaps at training time).

const CAPTION_MAX_EDGE = 768;
const CAPTION_JPEG_QUALITY = 0.72;
// 10 images per Gemini call — the route now answers each batch with EN + JA
// in ONE multimodal response (no translation round trip).
const CAPTION_BATCH = 10;
// Batches run through a worker pool instead of one-at-a-time. A 145-img
// dataset was ~15 serial calls at 1-3 min each (~30 min wall time); 4 in
// flight + the single-call route brings a 100-img set to well under 10s.
// On a 429 the pool stops early and the rest fall to the worker's VLM.
const CAPTION_CONCURRENCY = 4;
// A single batch that runs longer than this is abandoned (its images fall to
// the worker's VLM at training time) so one stuck call can't wedge a lane.
const BATCH_TIMEOUT_MS = 45_000;

export type DatasetCaptionResult = {
  /** English caption per image, "" where captioning failed. */
  captions: string[];
  /** Japanese working copy per image (for the curation UI), "" where absent. */
  captionsJa: string[];
  /** How many images got a non-empty English caption. */
  captionedCount: number;
};

// Downscale one image File to a base64 JPEG (no data: prefix), longest edge
// CAPTION_MAX_EDGE. Falls back to null if the browser can't decode it.
async function downscaleToBase64(file: File): Promise<{ data: string; mimeType: string } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, CAPTION_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const dataUrl = canvas.toDataURL("image/jpeg", CAPTION_JPEG_QUALITY);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    return { data: dataUrl.slice(comma + 1), mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}

async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// Captions `files` (aligned to order). Never throws — on any failure the
// corresponding entries stay blank. `onProgress(done, total)` fires per batch.
export async function generateDatasetCaptions(
  files: File[],
  opts: {
    triggerWord?: string;
    captionPrompt?: string;
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<DatasetCaptionResult> {
  const total = files.length;
  const captions = new Array<string>(total).fill("");
  const captionsJa = new Array<string>(total).fill("");
  if (total === 0) return { captions, captionsJa, captionedCount: 0 };

  const token = await accessToken();
  if (!token) return { captions, captionsJa, captionedCount: 0 };

  // Index ranges, one per batch.
  const batches: number[][] = [];
  for (let start = 0; start < total; start += CAPTION_BATCH) {
    batches.push(
      Array.from({ length: Math.min(CAPTION_BATCH, total - start) }, (_, k) => start + k),
    );
  }

  let done = 0;
  let nextBatch = 0;
  // Set once a 429 comes back — lanes then stop pulling new work rather than
  // hammering an exhausted quota. Remaining images stay blank (VLM fills them).
  let quotaHit = false;

  const runBatch = async (idxs: number[]): Promise<void> => {
    if (opts.signal?.aborted || quotaHit) return;

    const encoded = await Promise.all(idxs.map((i) => downscaleToBase64(files[i])));
    const sendPairs = idxs
      .map((i, k) => ({ i, img: encoded[k] }))
      .filter((p): p is { i: number; img: { data: string; mimeType: string } } => p.img != null);

    if (sendPairs.length) {
      // Local timeout, also tripped by the caller's abort signal.
      const to = new AbortController();
      const timer = setTimeout(() => to.abort(), BATCH_TIMEOUT_MS);
      const onAbort = () => to.abort();
      opts.signal?.addEventListener("abort", onAbort);
      try {
        const res = await fetch("/api/studio/lora/caption", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            images: sendPairs.map((p) => p.img),
            trigger_word: opts.triggerWord || undefined,
            caption_prompt: opts.captionPrompt || undefined,
          }),
          signal: to.signal,
        });
        if (res.status === 429) quotaHit = true;
        const data = await res.json().catch(() => ({}));
        if (res.ok && Array.isArray(data?.captions)) {
          const en = data.captions as unknown[];
          const ja = Array.isArray(data?.captionsJa) ? (data.captionsJa as unknown[]) : [];
          sendPairs.forEach((p, k) => {
            if (typeof en[k] === "string") captions[p.i] = (en[k] as string).trim();
            if (typeof ja[k] === "string") captionsJa[p.i] = (ja[k] as string).trim();
          });
        } else {
          console.warn("[loraCaption] batch failed:", data?.error || res.status);
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError" && opts.signal?.aborted) return;
        console.warn("[loraCaption] batch errored:", err);
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      }
    }

    done += idxs.length;
    opts.onProgress?.(Math.min(done, total), total);
  };

  const lane = async (): Promise<void> => {
    while (!opts.signal?.aborted && !quotaHit) {
      const my = nextBatch++;
      if (my >= batches.length) return;
      await runBatch(batches[my]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CAPTION_CONCURRENCY, batches.length) }, () => lane()),
  );

  return {
    captions,
    captionsJa,
    captionedCount: captions.filter((c) => c.trim().length > 0).length,
  };
}
