import { supabase } from "@/lib/supabaseClient";
import type { LoraCaptionCategory, LoraSubject, ResolvedCaptionMode } from "@/lib/loraCaptionSpec";

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
// 1リクエストあたりの枚数。
//
// ⚠️ 大きくしてはいけない（2026-09-22）。Gemini が安全性で拒否すると**その
// リクエストの全画像**が巻き添えで失われる（landed.length === 0 で batch 丸ごと
// safety 扱い）。12枚にすると1枚の拒否で12枚が消える。無料枠の節約のために
// 一度12へ上げたが、このプロジェクトの素材（NSFW寄りのイラスト）は Google の
// **設定で解除できない**カテゴリに当たることがあり、巻き添えのほうが痛い。
// 課金キーならリクエスト数は問題にならないので、切り分けの細かさを優先する。
const CAPTION_BATCH_SIZE = 4;
// Workers pulling the queue. 3 concurrent ~6s calls ≈ 0.5 req/s — well under
// the vision API's burst ceiling, and 3 in-flight requests is a small memory
// footprint now that thumbnails are pre-computed + cached.
const CAPTION_CONCURRENCY = 3;
// Per-request hard timeout (AbortController).
const REQUEST_TIMEOUT_MS = 40_000;
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
  /** 空応答の理由（API がそのまま返した文字列）。断定を避けるため生で出す。 */
  safetyReason?: string;
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
export async function makeThumbnail(file: File): Promise<Thumb | null> {
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
    // 2+ entries activates multi-subject vision classification server-side
    // (each image gets whichever trigger the model judges it depicts) —
    // see matchLeadingSubjectTrigger in loraCaptionSpec.ts. Omitted or a
    // single entry: identical to the legacy single-trigger behaviour.
    subjects?: LoraSubject[];
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
    // 自前 VLM 経路の状況表示（GPU の起動待ち等、進捗の数字が動かない間の一言）。null で消す。
    onNote?: (note: string | null) => void;
    /** 自己チェックで学習したい特徴の記述を直した枚数（自前 VLM 経路、2026-09-25）。 */
    onSelfCheck?: (fixed: number, flagged: number) => void;
  } = {},
): Promise<DatasetCaptionResult> {
  if (captionBackend() === "vlm") return generateDatasetCaptionsVlm(files, opts);
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
  let safetyReason = "";
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
      safetyReason,
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
    let data: {
      captions?: unknown;
      captionsJa?: unknown;
      safety?: unknown;
      retryAfterMs?: unknown;
      reason?: unknown;
    } = {};
    try {
      const res = await fetch("/api/studio/lora/caption", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          images: pairs.map((p) => p.img),
          trigger_word: opts.triggerWord || undefined,
          // A single entry is still worth sending when it carries fixedTags
          // (the gender/count tag lock) — only a truly empty list is dropped.
          subjects: opts.subjects && opts.subjects.length >= 1 ? opts.subjects : undefined,
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
        // 理由の文字列を捨てない（2026-09-22、ホスト指摘「コンテンツポリシー
        // により対象外も間違ってる」）。安全性フィルタ以外の事情で空応答に
        // なることがあり、こちらが断定すると誤った案内になる。
        if (typeof data.reason === "string" && data.reason.trim() && !safetyReason) {
          safetyReason = data.reason.trim().slice(0, 200);
        }
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


// --- 被写体の identity タグを画像から抽出する（2026-09-21）------------------
//
// キャプションとは逆向きの情報（あちらは identity をブラックリストで書かせない）
// なので、被写体ごとに数枚だけ渡す専用の1パスを立てる。返るのは**候補**で、
// 取捨選択は UI 側（ホスト方針: 「不要なら削除、不足なら追加」）。
//
// サムネイルはキャプションと同じキャッシュを使うので、解析済みのデータセット
// なら追加のデコードは発生しない。
export type IdentityTag = { en: string; ja: string };

export async function extractIdentityTags(
  files: File[],
  trigger: string,
  hintJa: string,
  /** 性別/人数タグ（"1man, solo, male" 等）。誰を見るかの決定打として渡す。 */
  fixedTags = "",
): Promise<IdentityTag[]> {
  const thumbs: Thumb[] = [];
  for (const f of files.slice(0, 6)) {
    const t = await makeThumbnail(f);
    if (t) thumbs.push(t);
  }
  if (thumbs.length === 0) throw new Error("画像を読み込めませんでした。");

  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("ログインが必要です。");

  const res = await fetch("/api/studio/lora/identity-tags", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ trigger, hint_ja: hintJa, fixed_tags: fixedTags, images: thumbs }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "特徴の抽出に失敗しました。");
  return Array.isArray(data?.tags) ? (data.tags as IdentityTag[]) : [];
}

// ---------------------------------------------------------------------------
// 自前 VLM 経路（2026-09-24、docs/gpu-benchmarks.md §17）: Qwen3.8-27B を vLLM でまとめて回す。
// Gemini は素材の一部を安全フィルタで拒否し（設定では外せない）、有料枠の原価もかかる。
// 縮小画像（makeThumbnail と同じ 640px）をブラウザから R2 へ直接 PUT し、GPU が全枚数を一括で解析する。
// 既定はこちら。localStorage `ull_lora_caption_backend=gemini` か
// NEXT_PUBLIC_LORA_CAPTION_BACKEND=gemini で旧経路に戻せる。
// ---------------------------------------------------------------------------
type CaptionOpts = NonNullable<Parameters<typeof generateDatasetCaptions>[1]>;


export function captionBackend(): "vlm" | "gemini" {
  try {
    const v = typeof window !== "undefined" ? window.localStorage.getItem("ull_lora_caption_backend") : null;
    if (v === "gemini" || v === "vlm") return v;
  } catch {
    /* private mode 等 — 既定値 */
  }
  return process.env.NEXT_PUBLIC_LORA_CAPTION_BACKEND === "gemini" ? "gemini" : "vlm";
}

const VLM_POLL_MS = 2_000;
// 解析が始まらない（GPU の起動・読み込みの失敗）まま 3 分経ったら打ち切って返金（2026-09-25 ホスト判断）。
// 読み込みは普段 10〜30 秒。駄目なら早く終わらせて、もう一度押してもらう方が良い。
const VLM_START_TIMEOUT_MS = 3 * 60_000;
// 直前の有料の解析で取りこぼした枚数。やり直しはこれ以下なら無料（route が前回ジョブで確かめる）。
// 再読み込みしても無料のやり直しが効くよう、端末に残す（2026-09-25。無料はこちらの取りこぼしだけなので、
// その権利を再読み込みで失わせない）。route が前回ジョブの結果で確かめるので、書き換えられても害は無い。
const LAST_VLM_JOB_KEY = "ull_lora_caption_last_job";
function readLastVlmJob(): { jobId: string; missed: number } | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(LAST_VLM_JOB_KEY) ?? "null");
    return v && typeof v.jobId === "string" && typeof v.missed === "number" ? v : null;
  } catch {
    return null;
  }
}
function writeLastVlmJob(v: { jobId: string; missed: number } | null): void {
  try {
    if (v) window.localStorage.setItem(LAST_VLM_JOB_KEY, JSON.stringify(v));
    else window.localStorage.removeItem(LAST_VLM_JOB_KEY);
  } catch {
    /* private mode 等 — 無料のやり直しが効かないだけ */
  }
}
const VLM_MAX_MS = 25 * 60_000; // 冷えた起動＋読み込み約 1 分・500 枚で数分。CLAUDE.md §0 のとおり多めに取る
const VLM_PUT_CONCURRENCY = 8;

function b64ToBlob(b64: string, mimeType: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function captionVlmPost(token: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const res = await fetch("/api/studio/lora/caption-vlm", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string })?.error || "画像の自動解析に失敗しました。");
  return data as Record<string, unknown>;
}

async function generateDatasetCaptionsVlm(files: File[], opts: CaptionOpts): Promise<DatasetCaptionResult> {
  const total = files.length;
  const captions = new Array<string>(total).fill("");
  const captionsJa = new Array<string>(total).fill("");
  if (!opts.forceOverwrite && opts.preCaptioned) {
    for (let i = 0; i < total; i++) {
      const en = opts.preCaptioned[i];
      if (typeof en === "string" && en.trim()) captions[i] = en.trim();
      const ja = opts.preCaptionedJa?.[i];
      if (typeof ja === "string" && ja.trim()) captionsJa[i] = ja.trim();
    }
  }
  const errored = new Set<number>();
  const stale = (i: number) => opts.isStale?.(i) ?? false;
  const result = (): DatasetCaptionResult => {
    const complete = captions.every((c, i) => stale(i) || c.trim().length > 0);
    return {
      captions,
      captionsJa,
      captionedCount: captions.filter((c) => c.trim()).length,
      safetyRejected: [],
      errored: [...errored],
      complete,
    };
  };

  const targets: number[] = [];
  for (let i = 0; i < total; i++) if (!stale(i) && !captions[i].trim()) targets.push(i);
  if (targets.length === 0) return result();
  const note = (t: string | null) => opts.onNote?.(t);
  const fail = (msg: string) => {
    targets.forEach((i) => errored.add(i));
    opts.onError?.(targets);
    note(msg);
    return result();
  };

  const token = await accessToken();
  if (!token) return fail("ログインが必要です。");
  note("解析用に画像を準備しています…");
  const thumbs = await Promise.all(targets.map((i) => makeThumbnail(files[i])));
  const ok = targets.map((i, k) => ({ i, t: thumbs[k] })).filter((x): x is { i: number; t: Thumb } => x.t !== null);
  if (ok.length === 0) return fail("画像を読み込めませんでした。");
  const mimes = ok.map((x) => x.t.mimeType);
  const spec = {
    trigger_word: opts.triggerWord || undefined,
    subjects: opts.subjects && opts.subjects.length >= 1 ? opts.subjects : undefined,
    caption_prompt: opts.captionPrompt || undefined,
    caption_mode: opts.captionMode || undefined,
    category: opts.category || undefined,
  };

  try {
    const start = await captionVlmPost(token, { action: "start", count: ok.length, mimes }, opts.signal);
    const jobId = String(start.jobId ?? "");
    const uploads = (start.uploads as string[]) ?? [];
    note(`解析用に画像を送っています（${ok.length} 枚）…`);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(VLM_PUT_CONCURRENCY, ok.length) }, async () => {
        while (next < ok.length) {
          const k = next++;
          const res = await fetch(uploads[k], {
            method: "PUT",
            headers: { "Content-Type": mimes[k] },
            body: b64ToBlob(ok[k].t.data, mimes[k]),
            signal: opts.signal,
          });
          if (!res.ok) throw new Error(`upload ${res.status}`);
        }
      }),
    );
    const lastVlmJob = readLastVlmJob();
    const retryOf = lastVlmJob && ok.length <= lastVlmJob.missed ? lastVlmJob.jobId : undefined;
    await captionVlmPost(token, { action: "run", jobId, mimes, retry_of: retryOf, ...spec }, opts.signal);
    note("AI を起動しています（1〜2 分ほどかかります）…");

    // 受け取った英語キャプション（index → 本文）。完了時の自己チェックが、既に受け取った画像のキャプションを
    // 書き直すので、本文が変わっていたら受け取り直す（2026-09-25、ホスト報告「自己チェックで直ったはずの特徴が
    // 25 枚残っている」: 一度受け取った画像を二度と見ておらず、直した版が画面に届いていなかった）。
    const seen = new Map<number, string>();
    const t0 = Date.now();
    for (;;) {
      if (opts.signal?.aborted) return result();
      if (Date.now() - t0 > VLM_MAX_MS) return fail("解析が時間内に終わりませんでした。再試行してください。");
      await sleep(VLM_POLL_MS);
      let st: Record<string, unknown>;
      try {
        st = await captionVlmPost(token, { action: "status", jobId, ...spec }, opts.signal);
      } catch {
        continue; // 一時的な失敗は次の周回で取り直す
      }
      const entries = (st.entries as { index: number; en: string; ja: string }[]) ?? [];
      const fresh: { index: number; en: string; ja: string }[] = [];
      for (const e of entries) {
        const i = ok[e.index]?.i;
        if (i === undefined || seen.get(e.index) === e.en) continue;
        seen.set(e.index, e.en);
        if (stale(i)) continue;
        captions[i] = e.en;
        captionsJa[i] = e.ja;
        fresh.push({ index: i, en: e.en, ja: e.ja });
      }
      if (fresh.length) opts.onBatch?.(fresh);
      const done = Number(st.done ?? 0);
      if ((st.status === "queued" || st.status === "unknown") && Date.now() - t0 > VLM_START_TIMEOUT_MS) {
        const ab = await captionVlmPost(token, { action: "abort", jobId, ...spec }, opts.signal).catch(() => null);
        if (ab?.aborted) {
          return fail("AI の起動に時間がかかりすぎたため中止しました（料金は返金済み）。もう一度お試しください。");
        }
      }
      if (st.status === "running" || st.status === "completed") {
        opts.onProgress?.(Math.min(done, ok.length), ok.length);
        if (st.status === "running") note(done > 0 ? null : "AI が解析しています…");
      }
      if (st.status === "completed") {
        const sc = st.selfcheck as { flagged?: number; fixed?: number } | undefined;
        if (sc && (sc.flagged ?? 0) > 0) opts.onSelfCheck?.(sc.fixed ?? 0, sc.flagged ?? 0);
        const missed = ok.filter((x) => !captions[x.i].trim()).map((x) => x.i);
        writeLastVlmJob(missed.length ? { jobId, missed: missed.length } : null);
        if (missed.length) {
          missed.forEach((i) => errored.add(i));
          opts.onError?.(missed);
        }
        note(null);
        return result();
      }
      if (st.status === "failed") return fail(String(st.error ?? "解析に失敗しました。"));
    }
  } catch (err) {
    if (opts.signal?.aborted) return result();
    return fail(err instanceof Error ? err.message : "画像の自動解析に失敗しました。");
  }
}


// ---------------------------------------------------------------------------
// 構図診断用のタグ付け（2026-09-25、modal_wd_tagger.py・無料・CPU）。キャプション（有料）より前に
// 距離・向き・仰角・姿勢・背景を判定するための材料。画像はキャプションと同じ縮小版を R2 へ直接 PUT する。
// ---------------------------------------------------------------------------
const WD_POLL_MS = 1_500;
const WD_MAX_MS = 10 * 60_000; // 500 枚でも 1〜2 分の見込み。CLAUDE.md §0 のとおり多めに取る

async function wdTagPost(token: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const res = await fetch("/api/studio/lora/wd-tags", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string })?.error || "構図の診断に失敗しました。");
  return data as Record<string, unknown>;
}

/** files の順にタグ文字列を返す（読めなかった画像は ""）。onBatch で届いた分から順に渡す。 */
export async function tagDatasetComposition(
  files: File[],
  opts: {
    onBatch?: (entries: { index: number; tags: string }[]) => void;
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<string[]> {
  const out = new Array<string>(files.length).fill("");
  if (files.length === 0) return out;
  const token = await accessToken();
  if (!token) throw new Error("ログインが必要です。");
  const thumbs = await Promise.all(files.map((f) => makeThumbnail(f)));
  const ok = thumbs.map((t, i) => ({ i, t })).filter((x): x is { i: number; t: Thumb } => x.t !== null);
  if (ok.length === 0) throw new Error("画像を読み込めませんでした。");
  const mimes = ok.map((x) => x.t.mimeType);

  const start = await wdTagPost(token, { action: "start", mimes }, opts.signal);
  const jobId = String(start.jobId ?? "");
  const uploads = (start.uploads as string[]) ?? [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(VLM_PUT_CONCURRENCY, ok.length) }, async () => {
      while (next < ok.length) {
        const k = next++;
        const res = await fetch(uploads[k], {
          method: "PUT",
          headers: { "Content-Type": mimes[k] },
          body: b64ToBlob(ok[k].t.data, mimes[k]),
          signal: opts.signal,
        });
        if (!res.ok) throw new Error(`upload ${res.status}`);
      }
    }),
  );
  await wdTagPost(token, { action: "run", jobId, mimes }, opts.signal);

  const seen = new Set<number>();
  const t0 = Date.now();
  for (;;) {
    if (opts.signal?.aborted) return out;
    if (Date.now() - t0 > WD_MAX_MS) throw new Error("構図の診断が時間内に終わりませんでした。再試行してください。");
    await sleep(WD_POLL_MS);
    let st: Record<string, unknown>;
    try {
      st = await wdTagPost(token, { action: "status", jobId }, opts.signal);
    } catch {
      continue; // 一時的な失敗は次の周回で取り直す
    }
    const fresh: { index: number; tags: string }[] = [];
    for (const e of (st.entries as { index: number; tags: string }[]) ?? []) {
      const i = ok[e.index]?.i;
      if (i === undefined || seen.has(e.index)) continue;
      seen.add(e.index);
      out[i] = e.tags;
      fresh.push({ index: i, tags: e.tags });
    }
    if (fresh.length) opts.onBatch?.(fresh);
    opts.onProgress?.(Math.min(Number(st.done ?? 0), ok.length), ok.length);
    if (st.status === "completed") return out;
    if (st.status === "failed") throw new Error(String(st.error ?? "構図の診断に失敗しました。"));
  }
}
