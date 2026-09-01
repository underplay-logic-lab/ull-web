import { supabase } from "@/lib/supabaseClient";

// Client-side AI-vision auto-captioning for the LoRA Studio dataset.
//
// Each image is downscaled to a small JPEG in the browser (so the request
// stays well under Vercel's 4.5 MB body cap — no upload needed) and sent to
// /api/studio/lora/caption. The route answers each batch with EN + JA in one
// multimodal call. This module drives that endpoint to 100% completion:
//
//   - up to CAPTION_CONCURRENCY batches in flight, paced DISPATCH_GAP_MS apart
//     so we stay under the ~15 RPM free tier;
//   - a 429 / 503 / network failure on a batch is retried in place with
//     exponential backoff + jitter (never abandoned);
//   - whatever is still missing after a full sweep is re-queued for another
//     round with a smaller batch size, so a genuine safety refusal can be
//     pinned to the single offending image;
//   - only images the server marks as safety-filtered are surfaced as
//     `safetyRejected` (the Modal worker's VLM fills exactly those gaps).

const CAPTION_MAX_EDGE = 768;
const CAPTION_JPEG_QUALITY = 0.72;
// 4 lanes overlaps the ~8s/batch latency well (benchmarks: 150 imgs in ~22s).
// The retry ceilings below keep a transient 429 from snowballing.
const CAPTION_CONCURRENCY = 4;
// Minimum gap between two batch requests starting — client-side pacing.
const DISPATCH_GAP_MS = 350;
// Per-batch retry on 429 / 503 / 5xx / network error. Kept low: the server
// hands us Google's own retryAfterMs, so a couple of well-timed retries beat
// many blind ones.
const MAX_BATCH_RETRIES = 3;
const BACKOFF_BASE_MS = 2000;
// Cap on how long we'll honour a server "retry in Xs" hint for one attempt.
const MAX_RETRY_WAIT_MS = 20_000;
// Whole-dataset re-sweeps. Batch size shrinks each round so a persistent
// safety block ends up isolated to one image.
const ROUND_BATCH_SIZES = [10, 4, 1];
const BATCH_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// ±25% jitter so retrying lanes don't resynchronise into a new burst.
const jitter = (ms: number) => Math.round(ms * (0.75 + Math.random() * 0.5));
const backoffFor = (attempt: number) => jitter(BACKOFF_BASE_MS * 2 ** attempt);

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
    // Fires when a batch hits a rate limit / transient error and is about to
    // wait `waitMs` before retrying — for a "still working…" UI hint.
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

  const allIndices = () => Array.from({ length: total }, (_, i) => i);
  const stale = (i: number) => opts.isStale?.(i) ?? false;
  const captioned = (i: number) => captions[i].trim().length > 0;
  // An image still worth sending: present, uncaptioned, not safety-blocked.
  const wanted = (i: number) => !stale(i) && !captioned(i) && !safety.has(i);

  const done = (): DatasetCaptionResult => ({
    captions,
    captionsJa,
    captionedCount: captions.filter((c) => c.trim().length > 0).length,
    safetyRejected: [...safety].sort((a, b) => a - b),
    complete: total === 0 || allIndices().filter(wanted).length === 0,
  });
  if (total === 0) return done();

  const token = await accessToken();
  if (!token) return done();

  let progressed = 0;
  const bump = (n: number) => {
    progressed = Math.min(total, progressed + n);
    opts.onProgress?.(progressed, total);
  };

  // Serialise batch dispatch across all lanes to >= DISPATCH_GAP_MS apart.
  let lastDispatch = 0;
  const pace = async () => {
    const wait = lastDispatch + DISPATCH_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastDispatch = Date.now();
  };

  const aborted = () => opts.signal?.aborted === true;

  // POST one group of file indices, merging captions in place. Retries the
  // whole request on 429 / 503 / 5xx / network error with exponential backoff.
  const postGroup = async (idxs: number[]): Promise<void> => {
    if (aborted()) return;
    const group = idxs.filter(wanted);
    if (!group.length) return;

    const encoded = await Promise.all(group.map((i) => downscaleToBase64(files[i])));
    const pairs = group
      .map((i, k) => ({ i, img: encoded[k] }))
      .filter((p): p is { i: number; img: { data: string; mimeType: string } } => p.img != null);
    if (!pairs.length) {
      bump(group.length);
      return;
    }

    for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
      if (aborted()) return;
      await pace();
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
        error?: unknown;
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
        status = 0; // network error / timeout — retryable
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

        // Whole request refused by the safety filter and this is a single
        // image — that's a genuine NSFW/policy block, not a rate limit.
        if (data.safety === true && landed.length === 0 && pairs.length === 1) {
          safety.add(pairs[0].i);
        }
        bump(pairs.length);
        return;
      }

      const retryable =
        status === 0 || status === 429 || status === 503 || status === 500 || status === 502 || status === 504;
      if (retryable && attempt < MAX_BATCH_RETRIES) {
        // Prefer Google's own "retry in Xs" hint; fall back to exponential.
        const hinted =
          typeof data.retryAfterMs === "number" && data.retryAfterMs > 0
            ? Math.min(data.retryAfterMs + 250, MAX_RETRY_WAIT_MS)
            : 0;
        const waitMs = hinted || backoffFor(attempt);
        opts.onRetry?.({ status, waitMs });
        await sleep(waitMs);
        continue;
      }
      // Out of retries, or a hard 4xx (401/501/…). Leave for the next round;
      // if none succeed the image ends up blank and the worker VLM fills it.
      bump(pairs.length);
      return;
    }
  };

  const runRound = async (groups: number[][]): Promise<void> => {
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

  for (let round = 0; round < ROUND_BATCH_SIZES.length; round++) {
    if (aborted()) break;
    const pending = allIndices().filter(wanted);
    if (!pending.length) break;

    // Re-sweeps re-count from zero against the shrinking pending set.
    if (round > 0) progressed = total - pending.length;

    const size = ROUND_BATCH_SIZES[round];
    const groups: number[][] = [];
    for (let s = 0; s < pending.length; s += size) groups.push(pending.slice(s, s + size));

    await runRound(groups);

    if (aborted()) break;
    const after = allIndices().filter(wanted).length;
    // A whole sweep (with per-batch backoff already exhausted) moved nothing —
    // the quota is hard-exhausted or every remaining image is unservable.
    // Further rounds won't help; let the worker's VLM take the rest.
    if (after === pending.length) break;
  }

  return done();
}
