"use client";

// 大きいファイルを分割して並行に落とす（2026-10-03）。
//
// R2（署名付き URL）は 1 本の接続だとときどき 1〜2MB/s に張り付く（同じ Cloudflare の東京経由でも、速度測定サーバーは
// 43〜68MB/s で張り付きなし＝R2 の中の経路の問題。ファイルを替えても読み直しても起きたり起きなかったりする）。
// ブラウザ標準のダウンロードは 1 本の接続なので、LoRA（300MB）が 4 分以上止まったように見えた（ホスト「事故レベル」）。
// 8MB ずつ 6 本並行（R2 は HTTP/1.1 なのでブラウザは本当に別々の接続を張る）で取り、止まったかけらは打ち切って取り直す。
// 実測（Python で同じ方式）: 最悪のファイルでも 8MB/s、普段は 28〜70MB/s（1 本だと最悪 1.2MB/s）。
//
// 組み立てはメモリ上（Blob）。LoRA 1 本 300MB 程度を想定。複数本は 1 本ずつ順に。
// 範囲指定に応じない URL（R2 以外・旧 Modal の ZIP 等）は、従来どおりブラウザに任せる（fallback）。

const CHUNK = 8 * 1024 * 1024;
const CONCURRENCY = 6;
/** 1 つのかけら（8MB）をこの時間で取れなければ打ち切って取り直す（≒ 1.3MB/s 未満を捨てる）。 */
const CHUNK_TIMEOUT_MS = 6_000;
const CHUNK_ATTEMPTS = 6;

export type DownloadProgress = { filename: string; done: number; total: number; index: number; count: number };

// 画面の隅の表示用（ParallelDownloadIndicator が読む）。同時に 1 件だけ出す。
let current: DownloadProgress | null = null;
const listeners = new Set<() => void>();
function emit(p: DownloadProgress | null) {
  current = p;
  for (const l of listeners) l();
}
export function subscribeDownloadProgress(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function getDownloadProgress(): DownloadProgress | null {
  return current;
}

/** R2 の署名付き URL か（範囲指定と CORS の Content-Range が使える相手だけ分割する）。 */
export function isR2Url(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".r2.cloudflarestorage.com");
  } catch {
    return false;
  }
}

function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

async function fetchRange(url: string, start: number, end: number): Promise<ArrayBuffer> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    // 最後の 1 回は打ち切らない（全部の接続が遅い時間帯でも、いつかは終わらせる）。
    const timer = attempt < CHUNK_ATTEMPTS - 1 ? setTimeout(() => ac.abort(), CHUNK_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: ac.signal, cache: "no-store" });
      if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength !== end - start + 1) throw new Error("short read");
      return buf;
    } catch (err) {
      lastErr = err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("ダウンロードに失敗しました。");
}

/**
 * url を分割して並行に落とし、filename で保存する。範囲指定に応じない相手なら false を返す（呼び出し側が従来の方法で落とす）。
 * index / count は複数本を順に落とすときの表示用。
 */
export async function parallelDownload(
  url: string,
  filename: string,
  opts: { index?: number; count?: number } = {},
): Promise<boolean> {
  const index = opts.index ?? 1;
  const count = opts.count ?? 1;
  // 大きさを知る（先頭 1 バイトだけ取って Content-Range を読む）。
  let total = 0;
  try {
    const probe = await fetch(url, { headers: { Range: "bytes=0-0" }, cache: "no-store" });
    const cr = probe.headers.get("content-range");
    await probe.arrayBuffer().catch(() => undefined);
    const m = cr?.match(/\/(\d+)$/);
    if (probe.status !== 206 || !m) return false;
    total = Number(m[1]);
  } catch {
    return false;
  }

  const ranges: [number, number][] = [];
  for (let s = 0; s < total; s += CHUNK) ranges.push([s, Math.min(s + CHUNK, total) - 1]);
  const parts: ArrayBuffer[] = new Array(ranges.length);
  let next = 0;
  let done = 0;
  emit({ filename, done: 0, total, index, count });
  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, ranges.length) }, async () => {
        while (next < ranges.length) {
          const i = next++;
          const [s, e] = ranges[i];
          parts[i] = await fetchRange(url, s, e);
          done += e - s + 1;
          emit({ filename, done, total, index, count });
        }
      }),
    );
    saveBlob(new Blob(parts, { type: "application/octet-stream" }), filename);
  } finally {
    emit(null);
  }
  return true;
}
