// Studio の作業状態（実行中ジョブ・今回の生成・下書き・データセット）はブラウザに保存していて、アカウントで分けていない。
// 同じブラウザで別アカウントに切り替えると、前のアカウントのジョブを読みに行って失敗する（2026-09-28、新規アカウントの
// Director で「状況の取得に繰り返し失敗しました」）。そこで持ち主の user id を 1 つ覚えておき、違うアカウントで
// ログインしたら前の持ち主の分を退避し、今のアカウントの退避分があれば戻す（2026-09-29、A→B→A で A の作業が
// 消えていたため。ホスト判断）。共用端末で残したくない人は、ログアウト時に「この端末から消す」を選ぶ（clearStudioStorage）。
// 端末の設定（WebP アップロード等の "ull_lora_*" の単発フラグ）は人に依らないので対象外。

import { fileStoreDeleteWhere, fileStoreRenameKeys } from "@/lib/fileStore";

const OWNER_KEY = "ull_studio_owner";
const PREFIXES = ["ull_studio_form_", "lora_studio_", "ull_lora_background_jobs", "ull.lora."];
// localStorage の退避先（JSON 1 本）と IndexedDB の退避キーの接頭辞。
const LS_STASH_PREFIX = "ull_studio_stash:";
const IDB_STASH_PREFIX = "stash:";

const isStudioKey = (key: string) => PREFIXES.some((p) => key.startsWith(p));

function studioLocalKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key && isStudioKey(key)) keys.push(key);
  }
  return keys;
}

/** 今の作業状態を userId の退避に移す（画面からは消える）。 */
async function stash(userId: string): Promise<void> {
  try {
    const keys = studioLocalKeys();
    const saved: Record<string, string> = {};
    for (const k of keys) saved[k] = window.localStorage.getItem(k) ?? "";
    for (const k of keys) window.localStorage.removeItem(k);
    if (keys.length > 0) {
      try {
        window.localStorage.setItem(LS_STASH_PREFIX + userId, JSON.stringify(saved));
      } catch {
        // 容量オーバーなら退避を諦める（消えるだけで、他人に見えることはない）
      }
    }
  } catch {
    // ignore
  }
  const tag = `${IDB_STASH_PREFIX}${userId}:`;
  await fileStoreRenameKeys((k) => (k.startsWith(IDB_STASH_PREFIX) ? null : tag + k));
}

/** userId の退避があれば戻す。戻したら true。 */
async function restore(userId: string): Promise<boolean> {
  let restored = false;
  try {
    const raw = window.localStorage.getItem(LS_STASH_PREFIX + userId);
    if (raw) {
      window.localStorage.removeItem(LS_STASH_PREFIX + userId);
      const saved = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(saved)) window.localStorage.setItem(k, v);
      restored = true;
    }
  } catch {
    // ignore
  }
  const tag = `${IDB_STASH_PREFIX}${userId}:`;
  await fileStoreRenameKeys((k) => (k.startsWith(tag) ? k.slice(tag.length) : null));
  return restored;
}

/** 持ち主が変わって作業状態を入れ替えたら true（呼び出し側は画面を読み直す。マウント済みのタブが古い状態を持っているため）。 */
export async function claimStudioStorage(userId: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  let previous: string | null = null;
  try {
    previous = window.localStorage.getItem(OWNER_KEY);
    window.localStorage.setItem(OWNER_KEY, userId);
  } catch {
    return false;
  }
  if (previous === userId) return false;
  // 持ち主不明（この仕組みより前からの利用者・ログアウト時に消した後）は、今の分をそのまま引き継ぐ。
  if (previous) await stash(previous);
  const restored = await restore(userId);
  return Boolean(previous) || restored;
}

/** ログアウト時に「この端末から消す」を選んだとき: 今のアカウントの作業状態と退避分を消し、持ち主も忘れる。 */
export async function clearStudioStorage(userId: string | null): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    for (const k of studioLocalKeys()) window.localStorage.removeItem(k);
    if (userId) window.localStorage.removeItem(LS_STASH_PREFIX + userId);
    window.localStorage.removeItem(OWNER_KEY);
  } catch {
    // ignore
  }
  // 画面に出ている分（退避キー以外）と、このアカウントの退避分。他のアカウントの退避は残す。
  const mine = userId ? `${IDB_STASH_PREFIX}${userId}:` : null;
  await fileStoreDeleteWhere((k) => !k.startsWith(IDB_STASH_PREFIX) || (mine !== null && k.startsWith(mine)));
}
