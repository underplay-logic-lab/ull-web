import { supabase } from "@/lib/supabaseClient";

// Client-side AI-vision auto-captioning for the LoRA Studio dataset.
//
// A size-independent queue + rate-limiter: works the same for 10 or 500+
// images. Every image is chunked into CAPTION_BATCH_SIZE tasks on a queue;
// CAPTION_CONCURRENCY workers pull tasks and POST them to
// /api/studio/lora/caption (which internally rotates gemini-flash-lite-latest
// -> 3.5-flash -> flash-latest -> 3.6-flash on a 429). A rate-limited or
// transient task is NEVER dropped — it goes back to the FRONT of the queue
// after a 1.5-2.0s backoff and is retried until it lands. The run finishes
// only when every valid image has a caption (or the wall-clock safety cap
// trips), and reports `complete: true` in that case.

const CAPTION_MAX_EDGE = 768;
const CAPTION_JPEG_QUALITY = 0.72;
// Efficiency-max batch — few requests per dataset, well under the route's
// MAX_IMAGES (16).
const CAPTION_BATCH_SIZE = 12;
// Workers pulling the queue. 4 * (one ~6s request) ≈ 0.7 req/s — nowhere near
// Google's ~15 req/s burst ceiling even at the start of a run.
const CAPTION_CONCURRENCY = 4;
// Backoff before a rate-limited task is retried (jittered 1.5-2.0s) — long
// enough for Google's token bucket to refill.
const backoffMs = () => 1500 + Math.floor(Math.random() * 500);
const BATCH_TIMEOUT_MS = 60_000;
// Safety valves so a permanently-broken image / total API outage can't hang
// the tab forever. Generous — a healthy run never approaches these.
const MAX_TASK_ATTEMPTS = 30;
const MAX_TOTAL_MS = 20 * 60_000;
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
  /** true when every valid (present, decodable) image ended up with a caption. */
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
    // Fires when a task is re-queued after a rate limit / transient error.
    onRetry?: (info: { status: number; waitMs: number }) => void;
    // Return true for a file index the caller no longer cares about (image
    // removed mid-pass) — it's dropped from its task, not sent.
    isStale?: (index: number) => boolean;
    signal?: AbortSignal;
  } = {},
): Promise<DatasetCaptionResult> {
  const total = files.length;
  const captions = new Array<string>(total).fill("");
  const captionsJa = new Array<string>(total).fill("");
  const safety = new Set<number>();
  const undecodable = new Set<number>();

  const stale = (i: number) => opts.isStale?.(i) ?? false;
  const captioned = (i: number) => captions[i].trim().length > 0;
  // Still needs work: present, decodable, uncaptioned, not safety-blocked.
  const wanted = (i: number) =>
    !stale(i) && !captioned(i) && !safety.has(i) && !undecodable.has(i);
  const aborted = () => opts.signal?.aborted === true;

  const result = (): DatasetCaptionResult => {
    let complete = true;
    for (let i = 0; i < total; i++) {
      if (!stale(i) && !undecodable.has(i) && !captioned(i)) {
        complete = false;
        break;
      }
    }
    return {
      captions,
      captionsJa,
      captionedCount: captions.filter((c) => c.trim().length > 0).length,
      safetyRejected: [...safety].sort((a, b) => a - b),
      complete: total === 0 || complete,
    };
  };
  if (total === 0) return result();

  const token = await accessToken();
  if (!token) return result();

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
    // "resolved": the request completed; `leftover` are ids still uncaptioned
    // (model returned an empty slot, or a hard non-retryable 4xx).
    kind: "transient" | "resolved";
    leftover: number[];
    status: number;
    retryAfterMs?: number;
  };

  // POST one group of file indices, merging captions in place.
  const send = async (ids: number[]): Promise<SendResult> => {
    const encoded = await Promise.all(ids.map((i) => downscaleToBase64(files[i])));
    // Anything the browser couldn't decode is not a "valid" image — drop it.
    ids.forEach((i, k) => {
      if (encoded[k] == null) undecodable.add(i);
    });
    const pairs = ids
      .map((i, k) => ({ i, img: encoded[k] }))
      .filter((p): p is { i: number; img: { data: string; mimeType: string } } => p.img != null);
    if (!pairs.length) return { kind: "resolved", leftover: [], status: 200 };

    const to = new AbortController();
    const timer = setTimeout(() => to.abort(), BATCH_TIMEOUT_MS);
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

    // 429 / 503 / 5xx / network → retry the whole task. Hard 4xx → resolved
    // with leftover; the per-task attempt cap decides when to stop.
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
      } finally {
        inFlight--;
      }
      if (aborted()) return;

      if (out.kind === "transient") {
        // Never drop it — back to the FRONT of the queue after a backoff.
        const wait = Math.max(backoffMs(), (out.retryAfterMs ?? 0) + 200);
        opts.onRetry?.({ status: out.status || 429, waitMs: wait });
        queue.unshift({ ids: live, attempts: task.attempts + 1 });
        await sleep(wait);
        continue;
      }

      reportProgress();

      const leftover = out.leftover.filter(wanted);
      if (leftover.length) {
        // A hard 4xx (bad image data, etc.) won't fix itself — cap it low. An
        // empty slot from an otherwise-200 response gets the full budget.
        const hardFail = out.status !== 200 && out.status !== 0;
        const cap = hardFail ? 3 : MAX_TASK_ATTEMPTS;
        if (task.attempts + 1 < cap) {
          if (hardFail) await sleep(400);
          // Requeue split to single images so one stubborn frame can't hold
          // up the rest.
          for (const id of leftover) queue.push({ ids: [id], attempts: task.attempts + 1 });
        }
      }
    }
  };

  await Promise.all(Array.from({ length: CAPTION_CONCURRENCY }, () => worker()));

  reportProgress();
  return result();
}
