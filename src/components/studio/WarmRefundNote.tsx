"use client";

/** 温まり返金（2026-10-10）: 続けて作って準備（読み込み）が要らなかったとき、完了時に返した額を結果欄に出す。 */
export function WarmRefundNote({ credits }: { credits: number | null | undefined }) {
  if (!credits || credits <= 0) return null;
  return (
    <p className="text-center text-[11px] text-emerald-500">
      続けて作ったので、準備の分 {credits}C をお返ししました。
    </p>
  );
}
