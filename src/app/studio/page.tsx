import type { Metadata } from "next";
import { Studio } from "@/components/Studio";
import { PurchaseSuccessToast } from "@/components/PurchaseSuccessToast";

// Studio の専用ページ（2026-10-01）。以前はトップページの 1 セクション（/#studio）で、作業中に下へスクロールしすぎると
// 料金表などトップの別の内容が出てきて紛らわしかった（ホスト指摘）。今のタブは ?tab= に載る（Studio.tsx）。
// 古い /#studio のリンク（決済の戻り・ログイン後の戻り先・DB の文言リンク等）は StudioHashRedirect がここへ送る。

export const metadata: Metadata = {
  title: "Studio — ULL Studio",
  description:
    "動画生成・マルチアングル・LoRA の学習素材づくり・4K/8K 超解像・LoRA 学習を、ブラウザだけで。環境構築は不要です。",
};

export default function StudioPage() {
  return (
    <>
      <PurchaseSuccessToast />
      <Studio />
    </>
  );
}
