import { supabase } from "@/lib/supabaseClient";

// Client-side AI-vision auto-captioning for the LoRA Studio dataset.
//
// Each image is downscaled to a small JPEG in the browser (so the request
// stays well under Vercel's 4.5 MB body cap) and sent to
// /api/studio/lora/caption, which answers with EN + JA in one multimodal
// call. Strategy — built for a billed Tier-1 key (1000 RPM) with the safety
// filter fully off:
//
//   - tiny batches (2 images) so one bad frame can't take out its neighbours;
//   - fired wide (CAPTION_CONCURRENCY lanes) so 145 images finish in seconds;
//   - one in-place retry on a transient error, then one final straggler pass
//     at batch size 1 — no exponential backoff, no shrinking-round machinery.

const CAPTION_MAX_EDGE = 768;
const CAPTION_JPEG_QUALITY = 0.72;
// 2 per call: a refusal / junk response can only cost these two.
const CAPTION_BATCH = 2;
// Fired wide against the Tier-1 quota (1000 RPM) — ~32 in flight clears 145
// images in ~5s on Vercel (HTTP/2). Browsers cap same-origin HTTP/1.1 at ~6
// sockets, so `next dev` on localhost is effectively 6 and will be slower.
const CAPTION_CONCURRENCY = 32;
// One retry, short wait — with BLOCK_NONE there are no safety refusals and a
// 2-image batch is too small to cascade, so one more go clears any blip.
const MAX_BATCH_RETRIES = 1;
const RETRY_WAIT_MS = 1200;
const MAX_RETRY_WAIT_MS = 8000;
const BATCH_TIMEOUT_MS = 45_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type DatasetCaptionResult = {
  /** English caption per image, "" where captioning failed. */
  captions: string[];
  /** Japanese working copy per image (for the curation UI), "" where absent. */
  captionsJa: string[];
  /** How many images got a non-empty English caption. */
  captionedCount: number;
  /** File indices Google's safety filter refused — the worker VLM fills these. */
  safetyRejected: number[];
  /** true when every still-wanted image ended up with an English caption. */
  complete: boolean;
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
    // Fires as each batch lands, with the freshly-captioned entries (indices
    // into `files`). Lets the caller merge results incrementally and drop
    // any that belong to an image the user has since removed.
    onBatch?: (entries: { index: number; en: string; ja: string }[]) => void;
    // Fires when a batch hits a transient error and is about to retry.
    onRetry?: (info: { status: number; waitMs: number }) => void;
    // Return true for a file index the caller no longer cares about (image
    // removed mid-pass) — it's skipped, not encoded or sent.
    isStale?: (index: number) => boolean;
    signal?: AbortSignal;
  } = {},
): Promise<DatasetCaptionResult> {
  const total = files.length;
  const captions = new Array<string>(total).fill("");
  const captionsJa = new Array<string>(total).fill("");
  const safety = new Set<number>();

  const stale = (i: number) => opts.isStale?.(i) ?? false;
  const captioned = (i: number) => captions[i].trim().length > 0;
  // An image still worth sending: present, uncaptioned, not safety-blocked.
  const wanted = (i: number) => !stale(i) && !captioned(i) && !safety.has(i);
  const aborted = () => opts.signal?.aborted === true;

  const result = (): DatasetCaptionResult => {
    let remaining = 0;
    for (let i = 0; i < total; i++) if (wanted(i)) remaining++;
    return {
      captions,
      captionsJa,
      captionedCount: captions.filter((c) => c.trim().length > 0).length,
      safetyRejected: [...safety].sort((a, b) => a - b),
      complete: total === 0 || remaining === 0,
    };
  };
  if (total === 0) return result();

  const token = await accessToken();
  if (!token) return result();

  let progressed = 0;
  const bump = (n: number) => {
    progressed = Math.min(total, progressed + n);
    opts.onProgress?.(progressed, total);
  };

  // POST one group of file indices, merging captions in place. One retry on a
  // transient error, then give up (the straggler pass / worker VLM covers it).
  const postGroup = async (idxs: number[]): Promise<void> => {
    if (aborted()) return;
    const group = idxs.filter(wanted);
    if (!group.length) {
      bump(idxs.length);
      return;
    }

    const encoded = await Promise.all(group.map((i) => downscaleToBase64(files[i])));
    const pairs = group
      .map((i, k) => ({ i, img: encoded[k] }))
      .filter((p): p is { i: number; img: { data: string; mimeType: string } } => p.img != null);
    if (!pairs.length) {
      bump(idxs.length);
      return;
    }

    for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
      if (aborted()) return;

      const to = new AbortController();
      const timer = setTimeout(() => to.abort(), BATCH_TIMEOUT_MS);
      const onAbort = () => to.abort();
      opts.signal?.addEventListener("abort", onAbort);

      let status = 0;
      let data: {
        captions?: unknown;
        captionsJa?: unknown;
        safety?: unknown;
        retryAfterMs?: unknown;
      } = {};
      try {
        const res = await fetch("/api/studio/lora/caption", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            images: pairs.map((p) => p.img),
            trigger_word: opts.triggerWord || undefined,
            caption_prompt: opts.captionPrompt || undefined,
          }),
          signal: to.signal,
        });
        status = res.status;
        data = await res.json().catch(() => ({}));
      } catch {
        status = 0; // network error / timeout
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      }
      if (aborted()) return;

      if (status === 200 && Array.isArray(data.captions)) {
        const en = data.captions as unknown[];
        const ja = Array.isArray(data.captionsJa) ? (data.captionsJa as unknown[]) : [];
        const landed: { index: number; en: string; ja: string }[] = [];
        pairs.forEach((p, k) => {
          const e = typeof en[k] === "string" ? (en[k] as string).trim() : "";
          const j = typeof ja[k] === "string" ? (ja[k] as string).trim() : "";
          if (e) captions[p.i] = e;
          if (j) captionsJa[p.i] = j;
          if (e || j) landed.push({ index: p.i, en: e, ja: j });
        });
        if (landed.length) opts.onBatch?.(landed);
        // Should never happen with BLOCK_NONE, but if the server still reports
        // a safety refusal, mark the (tiny) batch so the worker VLM fills it.
        if (data.safety === true && landed.length === 0) {
          pairs.forEach((p) => safety.add(p.i));
        }
        bump(idxs.length);
        return;
      }

      const retryable =
        status === 0 || status === 429 || status === 503 || status >= 500;
      if (retryable && attempt < MAX_BATCH_RETRIES) {
        const waitMs =
          typeof data.retryAfterMs === "number" && data.retryAfterMs > 0
            ? Math.min(data.retryAfterMs + 200, MAX_RETRY_WAIT_MS)
            : RETRY_WAIT_MS;
        opts.onRetry?.({ status, waitMs });
        await sleep(waitMs);
        continue;
      }
      bump(idxs.length);
      return;
    }
  };

  // Run `groups` through a CAPTION_CONCURRENCY-wide lane pool.
  const runPool = async (groups: number[][]): Promise<void> => {
    let next = 0;
    const lane = async (): Promise<void> => {
      while (!aborted()) {
        const my = next++;
        if (my >= groups.length) return;
        await postGroup(groups[my]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CAPTION_CONCURRENCY, groups.length) }, () => lane()),
    );
  };

  const chunk = (idxs: number[], size: number): number[][] => {
    const out: number[][] = [];
    for (let s = 0; s < idxs.length; s += size) out.push(idxs.slice(s, s + size));
    return out;
  };

  // Main pass: every image, batched by 2.
  const first: number[] = [];
  for (let i = 0; i < total; i++) if (wanted(i)) first.push(i);
  await runPool(chunk(first, CAPTION_BATCH));

  // One straggler pass at batch size 1 for anything a transient blip missed.
  if (!aborted()) {
    const stragglers: number[] = [];
    for (let i = 0; i < total; i++) if (wanted(i)) stragglers.push(i);
    if (stragglers.length) {
      progressed = total - stragglers.length;
      await runPool(chunk(stragglers, 1));
    }
  }

  return result();
}
