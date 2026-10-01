"use client";

import { useEffect } from "react";

// 古い /#studio（Studio がトップページの 1 セクションだった頃のリンク）を /studio へ送る（2026-10-01）。
// 決済の戻り（/?purchase=success#studio）・ログインが要るページからの戻り先・DB に入った文言リンク（"#studio"）などを
// 書き換えずに済ませるため。クエリ（purchase=success 等）は引き継ぐ。ページ内で #studio へ飛んだとき（hashchange）も同じ。
export function StudioHashRedirect() {
  useEffect(() => {
    const go = () => {
      if (window.location.hash !== "#studio") return;
      window.location.replace(`/studio${window.location.search}`);
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, []);
  return null;
}
