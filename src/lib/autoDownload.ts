// 生成した画像・動画を「完了したら自動で保存」する（2026-10-01、お客さんの「生成した画像と動画はどこ？」を受けて）。
// 生成物の一覧ページは作らない（作ると 14 日の保存を約束することになる — ホスト判断）。代わりに手元へ落とす。
//
// 送信したジョブだけを「予約」し、完了を見たタブが 1 回だけ保存する。予約はブラウザに残るので、
// 生成中にタブを閉じても、次に開いて完了を見た時点で保存される。予約していない古いジョブ
// （この仕組みより前のもの・復元しただけのもの）は落とさない。
// LoRA と素材づくりは対象外（LoRA は完了画面から、素材づくりは LoRA Studio へ送るのが主な使い道）。
//
// タブへの組み込み（CLAUDE.md §6-13）: 送信してジョブ ID が決まったら armAutoDownload(id)（LoRA へ戻す分は呼ばない）→
// ポーリングで完了を見たら takeAutoDownload(id) が true のときだけ runAutoDownload(タグ, 保存処理) →
// 生成ボタンの下に <AutoDownloadToggle />（オンオフと失敗の表示）。

import { useCallback, useSyncExternalStore } from "react";
import { loadFormState, saveFormState } from "./studioFormPersistence";

const PENDING_KEY = "auto_download_pending";
const OFF_KEY = "auto_download_off";
// 予約が溜まり続けないように、古いものから捨てる（完了を見ないまま終わったジョブの分）。
const MAX_PENDING = 100;

function pendingIds(): string[] {
  const ids = loadFormState<{ ids: string[] }>(PENDING_KEY)?.ids;
  return Array.isArray(ids) ? ids : [];
}

/** 送信したジョブを自動保存の対象にする。ジョブ ID が決まった直後に呼ぶ。 */
export function armAutoDownload(...jobIds: string[]): void {
  const ids = [...pendingIds().filter((x) => !jobIds.includes(x)), ...jobIds];
  saveFormState(PENDING_KEY, { ids: ids.slice(-MAX_PENDING) });
}

/**
 * 完了を見たときに呼ぶ。予約されていれば予約を外し、自動保存が有効なら true（＝今保存する）。
 * 同じジョブで 2 回 true を返すことはない（再読み込み・StrictMode の二重実行でも 1 回だけ）。
 */
export function takeAutoDownload(jobId: string): boolean {
  const ids = pendingIds();
  if (!ids.includes(jobId)) return false;
  saveFormState(PENDING_KEY, { ids: ids.filter((x) => x !== jobId) });
  return isAutoDownloadOn();
}

export function isAutoDownloadOn(): boolean {
  return !loadFormState<{ off: boolean }>(OFF_KEY)?.off;
}

// 切り替えと失敗をすべてのタブの表示に反映する（同じページ内は listeners、別のブラウザタブは storage イベント）。
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

/**
 * 自動保存を実行する。失敗は握りつぶさず、切り替えスイッチの下に出す（CLAUDE.md §6-11）。
 * タブ側のエラー表示は「生成の失敗」用で、結果を表示中は出ない所が多いため、こちらにまとめる。
 */
let failure: string | null = null;
export function runAutoDownload(tag: string, save: () => Promise<void> | void): void {
  failure = null;
  emit();
  Promise.resolve()
    .then(save)
    .catch((err) => {
      console.error(`[${tag}] auto download failed:`, err);
      failure = "自動保存に失敗しました。結果の「ダウンロード」から保存してください。";
      emit();
    });
}

export function useAutoDownloadFailure(): string | null {
  return useSyncExternalStore(subscribe, () => failure, () => null);
}

/** 自動保存のオンオフ。既定はオン。 */
export function useAutoDownloadSetting(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, isAutoDownloadOn, () => true);
  const set = useCallback((next: boolean) => {
    saveFormState(OFF_KEY, { off: !next });
    emit();
  }, []);
  return [on, set];
}
