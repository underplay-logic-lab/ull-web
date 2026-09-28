// Studio の作業状態（実行中ジョブ・今回の生成・下書き・データセット）はブラウザに保存していて、アカウントで分けていない。
// 同じブラウザで別アカウントに切り替えると、前のアカウントのジョブを読みに行って失敗する（2026-09-28、新規アカウントの
// Director で「状況の取得に繰り返し失敗しました」）。そこで持ち主の user id を 1 つ覚えておき、違うアカウントで
// ログインしたら Studio の保存分を消す。ログアウトでは消さない（同じ人がログインし直せば続きから戻れる）。
// 端末の設定（WebP アップロード等の "ull_lora_*" の単発フラグ）は人に依らないので残す。

import { fileStoreClear } from "@/lib/fileStore";

const OWNER_KEY = "ull_studio_owner";
const PREFIXES = ["ull_studio_form_", "lora_studio_", "ull_lora_background_jobs", "ull.lora."];

/** 持ち主が変わって保存分を消したら true（呼び出し側は画面を読み直す。マウント済みのタブが古い状態を持っているため）。 */
export async function claimStudioStorage(userId: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  let previous: string | null = null;
  try {
    previous = window.localStorage.getItem(OWNER_KEY);
    window.localStorage.setItem(OWNER_KEY, userId);
  } catch {
    return false;
  }
  // 初回（この仕組みより前からの利用者）は持ち主不明なので消さない。
  if (!previous || previous === userId) return false;

  let removed = 0;
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key && PREFIXES.some((p) => key.startsWith(p))) {
        window.localStorage.removeItem(key);
        removed += 1;
      }
    }
  } catch {
    // ignore
  }
  await fileStoreClear("");
  return removed > 0;
}
