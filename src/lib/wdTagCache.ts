// 構図の判定（WD タガー）の結果を、画像の中身のハッシュでブラウザに覚える（2026-09-27、ホスト要望）。
// LoRA Studio は再読み込みで画像が消えるので、同じ zip を入れ直すたびに同じ画像を判定し直していた。
// 画像が同じなら結果も同じなので精度は変わらない。IndexedDB が使えない環境（プライベートウィンドウ等）では
// 黙ってキャッシュ無しで動く。タガーのモデル・しきい値を変えたら WD_CACHE_VERSION を上げる。

const DB_NAME = "ull-wd-tags";
const STORE = "tags";
const WD_CACHE_VERSION = 1;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Row = { tags: string; at: number };

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function sha256(file: File): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** files ごとのキャッシュキー（ハッシュが取れなければ null）。 */
export async function wdCacheKeys(files: File[]): Promise<(string | null)[]> {
  return Promise.all(
    files.map(async (f) => {
      try {
        return `v${WD_CACHE_VERSION}:${await sha256(f)}`;
      } catch {
        return null;
      }
    }),
  );
}

/** キーごとのタグ（無い・期限切れは null）。 */
export async function wdCacheGet(keys: (string | null)[]): Promise<(string | null)[]> {
  const db = await openDb();
  if (!db) return keys.map(() => null);
  try {
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    const now = Date.now();
    return await Promise.all(
      keys.map(
        (k) =>
          new Promise<string | null>((resolve) => {
            if (!k) return resolve(null);
            const req = store.get(k);
            req.onsuccess = () => {
              const row = req.result as Row | undefined;
              resolve(row && row.tags && now - row.at < TTL_MS ? row.tags : null);
            };
            req.onerror = () => resolve(null);
          }),
      ),
    );
  } catch {
    return keys.map(() => null);
  } finally {
    db.close();
  }
}

export async function wdCachePut(entries: { key: string; tags: string }[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const at = Date.now();
    for (const e of entries) if (e.tags) store.put({ tags: e.tags, at } satisfies Row, e.key);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // キャッシュに書けなくても判定結果は返っているので無視してよい
  } finally {
    db.close();
  }
}
