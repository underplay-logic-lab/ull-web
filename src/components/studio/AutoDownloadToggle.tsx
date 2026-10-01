"use client";

import { useAutoDownloadFailure, useAutoDownloadSetting } from "@/lib/autoDownload";

/** 「完了したら自動で保存」のオンオフ（全タブ共通の設定）と、自動保存の失敗の表示。生成ボタンの下に置く。 */
export default function AutoDownloadToggle() {
  const [on, setOn] = useAutoDownloadSetting();
  const failure = useAutoDownloadFailure();
  return (
    <div>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="accent-neon-pink" />
        完了したら自動で保存する（タブを閉じていた場合は、次にこの画面を開いたときに保存）
      </label>
      {failure && <p className="mt-1 text-xs text-red-400">{failure}</p>}
    </div>
  );
}
