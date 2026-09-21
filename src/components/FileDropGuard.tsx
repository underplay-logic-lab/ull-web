"use client";

import { useEffect } from "react";

/**
 * ページのどこにファイルをドロップしても、ブラウザがそのファイルを
 * 開いてしまわないようにする（2026-09-21、ホスト報告）。
 *
 * 症状: 画像を取り込もうとして、ドロップゾーンが受け付け可能になる前
 * （ハイドレーション前・トリガーワード未入力で無効化されている間など）や、
 * ドロップゾーンの外に落とすと、ブラウザの既定動作でその画像ファイルへ
 * 遷移し、画像ビューアのような表示になってしまう。作業中の入力が全部
 * 巻き戻るので、地味に被害が大きい。
 *
 * 対策: window 上で dragover / drop の既定動作を止めるだけ。バブリング
 * フェーズで拾うので、各ドロップゾーン自身のハンドラ（そちらでも
 * preventDefault 済み）より後に走り、正規の取り込みは一切邪魔しない。
 */
export function FileDropGuard() {
  useEffect(() => {
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const block = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);
  return null;
}
