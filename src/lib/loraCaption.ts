import { supabase } from "@/lib/supabaseClient";
import type { LoraCaptionCategory, ResolvedCaptionMode } from "@/lib/loraCaptionSpec";

// Client-side AI-vision auto-captioning for the LoRA Studio dataset.
//
// Hardened against the failure modes a 100+ image / 4K-mixed dataset hits:
//
//  1. Browser memory — every image is decoded exactly ONCE into a ~640px
//     thumbnail (cached by file identity, reused on every retry), and at most
//     MAX_DECODE_CONCURRENCY decodes run at a time. A 4K source is never held
//     in a canvas longer than the downscale, and never base64'd at full res.
//  2. Non-blocking pipeline — CAPTION_CONCURRENCY workers pull a queue; each
//     request has a REQUEST_TIMEOUT_MS AbortController; 429 / 5xx / network /
//     timeout retry with exponential backoff up to MAX_RETRIES; a batch that
//     still fails is split to singles so one toxic frame can't stall the rest.
//  3. Error isolation — an image that exhausts its retries is marked
//     `errored` and the run CONTINUES. It never throws, never hangs; the run
//     ends when every image is captioned, safety-blocked, undecodable, or
//     errored, and `complete` is true only when nothing is left pending.

const CAPTION_MAX_EDGE = 640; // 512–768 band — tiny payload, plenty for tagging
const CAPTION_QUALITY = 0.8;
// Small batches: bounded request-body size, fast failure isolation, and the
// 20s timeout stays realistic (a handful of thumbnails per call).
const CAPTION_BATCH_SIZE = 4;
// Workers pulling the queue. 3 concurrent ~6s calls ≈ 0.5 req/s — well under
// the vision API's burst ceiling, and 3 in-flight requests is a small memory
// footprint now that thumbnails are pre-computed + cached.
const CAPTION_CONCURRENCY = 3;
// Per-request hard timeout (AbortController).
const REQUEST_TIMEOUT_MS = 20_000;
// Retries per task before its images are marked `errored`.
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;
// Exponential backoff with jitter. `attempt` is 0-based (0 -> ~1s, 1 -> ~2s,
// 2 -> ~4s), capped, honouring any server-provided retry hint.
const backoffMs = (attempt: number, retryAfterMs = 0): number =>
  Math.max(
    Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt) + Math.floor(Math.random() * 400),
    retryAfterMs + 200,
  );
// Never more than this many full-res decodes in flight — the OOM guard.
const MAX_DECODE_CONCURRENCY = 2;
// Absolute wall-clock ceiling so a total API outage can't spin forever.
const MAX_TOTAL_MS = 30 * 60_000;
// Idle spin while the queue is momentarily empty but peers may re-enqueue.
const IDLE_POLL_MS = 150;

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
  /** File indices that exhausted their retries (rate limit / error / timeout). */
  errored: number[];
  /** true when every valid (present, decodable) image ended up with a caption. */
  complete: boolean;
};

// --- thumbnail cache + decode semaphore -----------------------------------
// A thumbnail is computed once per file and reused on every retry. Keyed by a
// stable file identity so it also survives a fresh generateDatasetCaptions()
// call for the same File objects (a manual "re-analyze").
type Thumb = { data: string; mimeType: string };
const thumbCache = new Map<string, Thumb | null>();
export const captionFileKey = (f: File): string => `${f.name}::${f.size}::${f.lastModified}`;

let activeDecodes = 0;
const decodeQueue: (() => void)[] = [];
const acquireDecode = (): Promise<void> =>
  new Promise((resolve) => {
    if (activeDecodes < MAX_DECODE_CONCURRENCY) {
      activeDecodes++;
      resolve();
    } else {
      decodeQueue.push(() => {
        activeDecodes++;
        resolve();
      });
    }
  });
const releaseDecode = (): void => {
  activeDecodes--;
  decodeQueue.shift()?.();
};

// Downscale one File to a base64 thumbnail (no data: prefix), longest edge
// CAPTION_MAX_EDGE, WebP where the browser supports canvas WebP export else
// JPEG. Returns null (cached) if the browser can't decode it.
async function makeThumbnail(file: File): Promise<Thumb | null> {
  const key = captionFileKey(file);
  const hit = thumbCache.get(key);
  if (hit !== undefined) return hit;

  await acquireDecode();
  let out: Thumb | null = null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, CAPTION_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, w, h);
      let mimeType = "image/webp";
      let dataUrl = canvas.toDataURL(mimeType, CAPTION_QUALITY);
      if (!dataUrl.startsWith("data:image/webp")) {
        mimeType = "image/jpeg";
        dataUrl = canvas.toDataURL(mimeType, CAPTION_QUALITY);
      }
      const comma = dataUrl.indexOf(",");
      if (comma >= 0) out = { data: dataUrl.slice(comma + 1), mimeType };
    }
    bitmap.close?.();
    // Release the backing store immediately — don't wait for GC.
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    out = null;
  } finally {
    releaseDecode();
  }
  thumbCache.set(key, out);
  return out;
}

async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// Captions `files` (aligned to order). Never throws — on any failure the
// corresponding entries stay blank and their index lands in `errored`.
export async function generateDatasetCaptions(
  files: File[],
  opts: {
    triggerWord?: string;
    captionPrompt?: string;
    // Selected LoRA training type. Sent alongside every request so that — when
    // no explicit `captionPrompt` was synthesised (empty feature form) — the
    // server still applies this category's blacklist/whitelist policy instead
    // of captioning the whole image. Ignored when `captionPrompt` is set.
    category?: LoraCaptionCategory;
    // Caption FORMAT for the selected base model (resolveCaptionMode). "dense"
    // = natural-language paragraph for LLM/VLM text encoders; "tags" (default
    // on the server when omitted) = comma-separated phrases for CLIP.
    captionMode?: ResolvedCaptionMode;
    // Captions the caller already holds, aligned to `files`. When a slot is a
    // non-empty string AND `forceOverwrite` is not set, that image counts as
    // done: its slot is returned unchanged and NO request goes out for it
    // (the "skip already-captioned" optimisation). Ignored entirely when
    // `forceOverwrite` is true — every image is then re-analysed from scratch.
    preCaptioned?: (string | null | undefined)[];
    preCaptionedJa?: (string | null | undefined)[];
    // Force a full re-analysis: bypasses the `preCaptioned` skip so every
    // file is sent to the vision API even if it already has a caption. Used
    // by the curation screen's "全カードを現在の形式で再解析".
    forceOverwrite?: boolean;
    onProgress?: (done: number, total: number) => void;
    // Fires as each batch lands, with the freshly-captioned entries (indices
    // into `files`). Lets the caller merge + persist results incrementally.
    onBatch?: (entries: { index: number; en: string; ja: string }[]) => void;
    // Fires when a task is re-queued after a rate limit / transient error.
    onRetry?: (info: { status: number; waitMs: number }) => void;
    // Fires when image indices exhaust their retries — the caller marks them
    // `error` so the resume button / per-card retry can pick them up.
    onError?: (indices: number[]) => void;
    // Return true for a file index the caller no longer cares about (image
    // removed mid-pass) — it's dropped from its task, not sent.
    isStale?: (index: number) => boolean;
    signal?: AbortSignal;
  } = {},
): Promise<DatasetCaptionResult> {
  const total = files.length;
  const captions = new Array<string>(total).fill("");
  const captionsJa = new Array<string>(total).fill("");
  // Seed the slots the caller already has a caption for — unless a full
  // re-analysis was explicitly requested. A seeded slot is `captioned()` and
  // therefore never `wanted()`, so no request is sent and `complete` still
  // resolves normally.
  if (!opts.forceOverwrite && opts.preCaptioned) {
    for (let i = 0; i < total; i++) {
      const en = opts.preCaptioned[i];
      if (typeof en === "string" && en.trim()) captions[i] = en.trim();
      const ja = opts.preCaptionedJa?.[i];
      if (typeof ja === "string" && ja.trim()) captionsJa[i] = ja.trim();
    }
  }
  const safety = new Set<number>();
  const undecodable = new Set<number>();
  const errored = new Set<number>();

  const stale = (i: number) => opts.isStale?.(i) ?? false;
  const captioned = (i: number) => captions[i].trim().length > 0;
  // Still needs work: present, decodable, uncaptioned, not safety-blocked,
  // not already given up on.
  const wanted = (i: number) =>
    !stale(i) && !captioned(i) && !safety.has(i) && !undecodable.has(i) && !errored.has(i);
  const aborted = () => opts.signal?.aborted === true;

  const result = (): DatasetCaptionResult => {
    let complete = true;
    for (let i = 0; i < total; i++) {
      if (wanted(i)) {
        complete = false;
        break;
      }
    }
    return {
      captions,
      captionsJa,
      captionedCount: captions.filter((c) => c.trim().length > 0).length,
      safetyRejected: [...safety].sort((a, b) => a - b),
      errored: [...errored].sort((a, b) => a - b),
      complete: total === 0 || complete,
    };
  };
  if (total === 0) return result();

  const token = await accessToken();
  if (!token) {
    for (let i = 0; i < total; i++) errored.add(i);
    opts.onError?.([...errored]);
    return result();
  }

  const giveUp = (ids: number[]) => {
    const hit = ids.filter((i) => wanted(i));
    if (!hit.length) return;
    hit.forEach((i) => errored.add(i));
    opts.onError?.(hit);
  };

  // Live N/Total: images that have reached a terminal state.
  const reportProgress = () => {
    let done = 0;
    for (let i = 0; i < total; i++) if (!wanted(i)) done++;
    opts.onProgress?.(Math.min(done, total), total);
  };

  type Task = { ids: number[]; attempts: number };
  const queue: Task[] = [];
  for (let s = 0; s < total; s += CAPTION_BATCH_SIZE) {
    queue.push({
      ids: Array.from({ length: Math.min(CAPTION_BATCH_SIZE, total - s) }, (_, k) => s + k),
      attempts: 0,
    });
  }

  const deadline = Date.now() + MAX_TOTAL_MS;
  let inFlight = 0;

  type SendResult = {
    // "transient": the whole request must be retried (rate limit / 5xx / net).
    // "resolved": the request completed; `leftover` are ids still uncaptioned.
    kind: "transient" | "resolved";
    leftover: number[];
    status: number;
    retryAfterMs?: number;
  };

  // POST one group of file indices, merging captions in place.
  const send = async (ids: number[]): Promise<SendResult> => {
    const encoded = await Promise.all(ids.map((i) => makeThumbnail(files[i])));
    // Anything the browser couldn't decode is not a "valid" image — drop it.
    ids.forEach((i, k) => {
      if (encoded[k] == null) undecodable.add(i);
    });
    const pairs = ids
      .map((i, k) => ({ i, img: encoded[k] }))
      .filter((p): p is { i: number; img: Thumb } => p.img != null);
    if (!pairs.length) return { kind: "resolved", leftover: [], status: 200 };

    const to = new AbortController();
    const timer = setTimeout(() => to.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => to.abort();
    opts.signal?.addEventListener("abort", onAbort);

    let status = 0;
    let data: { captions?: unknown; captionsJa?: unknown; safety?: unknown; retryAfterMs?: unknown } = {};
    try {
      const res = await fetch("/api/studio/lora/caption", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          images: pairs.map((p) => p.img),
          trigger_word: opts.triggerWord || undefined,
          caption_prompt: opts.captionPrompt || undefined,
          caption_mode: opts.captionMode || undefined,
          category: opts.category || undefined,
        }),
        signal: to.signal,
      });
      status = res.status;
      data = await res.json().catch(() => ({}));
    } catch {
      status = 0; // network error / timeout / abort
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    const retryAfterMs = typeof data.retryAfterMs === "number" ? data.retryAfterMs : undefined;
    if (aborted()) return { kind: "resolved", leftover: [], status };

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
      if (data.safety === true && landed.length === 0) {
        pairs.forEach((p) => safety.add(p.i));
        return { kind: "resolved", leftover: [], status };
      }
      return { kind: "resolved", leftover: pairs.map((p) => p.i).filter(wanted), status };
    }

    // 429 / 503 / 5xx / network / timeout → retry the whole task.
    const transient = status === 0 || status === 429 || status === 503 || status >= 500;
    return {
      kind: transient ? "transient" : "resolved",
      leftover: pairs.map((p) => p.i).filter(wanted),
      status,
      retryAfterMs,
    };
  };

  const worker = async (): Promise<void> => {
    while (!aborted() && Date.now() < deadline) {
      const task = queue.shift();
      if (!task) {
        if (inFlight === 0) return; // queue drained and nobody can refill it
        await sleep(IDLE_POLL_MS);
        continue;
      }

      const live = task.ids.filter(wanted);
      if (!live.length) {
        reportProgress();
        continue;
      }

      inFlight++;
      let out: SendResult;
      try {
        out = await send(live);
      } catch {
        out = { kind: "transient", leftover: live, status: 0 };
      } finally {
        inFlight--;
      }
      if (aborted()) return;

      if (out.kind === "transient") {
        const nextAttempt = task.attempts + 1;
        if (nextAttempt < MAX_RETRIES) {
          const wait = backoffMs(task.attempts, out.retryAfterMs ?? 0);
          opts.onRetry?.({ status: out.status || 429, waitMs: wait });
          queue.unshift({ ids: live, attempts: nextAttempt });
          await sleep(wait);
        } else if (live.length > 1) {
          // Retries exhausted as a batch — isolate: give each image one final
          // solo attempt so a single toxic frame can't drag the rest down.
          const wait = backoffMs(task.attempts, out.retryAfterMs ?? 0);
          opts.onRetry?.({ status: out.status || 429, waitMs: wait });
          for (const id of live) queue.push({ ids: [id], attempts: MAX_RETRIES - 1 });
          await sleep(wait);
        } else {
          giveUp(live);
          reportProgress();
        }
        continue;
      }

      reportProgress();

      // 200 with an empty slot for some images (or a non-retryable 4xx).
      const leftover = out.leftover.filter(wanted);
      if (leftover.length) {
        const nextAttempt = task.attempts + 1;
        if (nextAttempt < MAX_RETRIES) {
          if (out.status !== 200 && out.status !== 0) await sleep(400);
          for (const id of leftover) queue.push({ ids: [id], attempts: nextAttempt });
        } else {
          giveUp(leftover);
          reportProgress();
        }
      }
    }
    // deadline hit — anything still wanted in this worker's reach is errored
    // by the top-level sweep below.
  };

  await Promise.all(Array.from({ length: CAPTION_CONCURRENCY }, () => worker()));

  // Final sweep: if we bailed on the wall-clock ceiling, everything still
  // pending is an error (not a silent blank).
  if (!aborted()) {
    const late: number[] = [];
    for (let i = 0; i < total; i++) {
      if (wanted(i)) {
        errored.add(i);
        late.push(i);
      }
    }
    if (late.length) opts.onError?.(late);
  }

  reportProgress();
  return result();
}
