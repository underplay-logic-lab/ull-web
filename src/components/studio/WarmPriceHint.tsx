"use client";

/**
 * 料金の行の下に出す一言（2026-10-10・温まり返金）。表示している料金は初回（準備込み）の額で、続けて作るか予約で順番に流すと
 * 準備の分が戻って安くなることを伝える（ホスト方針「かかっていない費用はもらわない」。仕組みは src/lib/pricing/warmRefund.ts）。
 */
export function WarmPriceHint({ batch = false }: { batch?: boolean }) {
  return (
    <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
      {batch ? "基本料はまとめて 1 回分だけです（2 枚目からは仕上げの分だけ）。" : ""}
      表示は初回（準備込み）の料金です。前の生成が終わってから 30 秒以内に続けるか、予約で順番に流すと、準備の分が戻って安くなります。
    </p>
  );
}
