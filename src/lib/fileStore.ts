// ブラウザ内にファイル（Blob）を保存して、リロード後に戻す（2026-09-28、素材づくり用）。
// 素材づくりは段階が多く、途中でリロードするとメイン画像・参照が消えて最初からになっていた。
// IndexedDB が使えない環境では黙って何もしない（保存できなくても生成は止めない）。

const DB_NAME = "ull-file-store";
const STORE = "files";

type Row = { blob: Blob; name: string; type: string; lastModified: number; at: number };

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

export async function fileStorePut(key: string, file: File | null): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (file) {
      store.put({ blob: file, name: file.name, type: file.type, lastModified: file.lastModified, at: Date.now() } satisfies Row, key);
    } else {
      store.delete(key);
    }
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // 保存できなくても動作は続ける
  } finally {
    db.close();
  }
}

export async function fileStoreGet(key: string): Promise<File | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    return await new Promise<File | null>((resolve) => {
      const req = store.get(key);
      req.onsuccess = () => {
        const row = req.result as Row | undefined;
        resolve(row?.blob ? new File([row.blob], row.name, { type: row.type, lastModified: row.lastModified }) : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** 接頭辞で始まるキーを全部消す（例: "dataset-builder:"）。 */
export async function fileStoreClear(prefix: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const k of req.result) if (typeof k === "string" && k.startsWith(prefix)) store.delete(k);
    };
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // ignore
  } finally {
    db.close();
  }
}

/** 複数ファイルを 1 トランザクションで保存する（LoRA Studio のデータセット用、2026-09-28）。null は削除。 */
export async function fileStorePutMany(entries: { key: string; file: File | null }[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const { key, file } of entries) {
      if (file) {
        store.put({ blob: file, name: file.name, type: file.type, lastModified: file.lastModified, at: Date.now() } satisfies Row, key);
      } else {
        store.delete(key);
      }
    }
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // 保存できなくても動作は続ける
  } finally {
    db.close();
  }
}

/** 複数キーをまとめて読む。無いキーは結果に入らない。 */
export async function fileStoreGetMany(keys: string[]): Promise<Map<string, File>> {
  const out = new Map<string, File>();
  if (keys.length === 0) return out;
  const db = await openDb();
  if (!db) return out;
  try {
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    await Promise.all(
      keys.map(
        (key) =>
          new Promise<void>((resolve) => {
            const req = store.get(key);
            req.onsuccess = () => {
              const row = req.result as Row | undefined;
              if (row?.blob) out.set(key, new File([row.blob], row.name, { type: row.type, lastModified: row.lastModified }));
              resolve();
            };
            req.onerror = () => resolve();
          }),
      ),
    );
  } catch {
    // 読めなければ空のまま
  } finally {
    db.close();
  }
  return out;
}
