"use client";

import { useCallback, useEffect, useState } from "react";

// 2026-09-13: 旧 gpu_warm_status（サイト全体共有・DB連動）の後継。
// あの仕組みは「課金して延長できる」部分が複数ユーザー間の横取り問題で
// 破綻していた（gpu-warm-extend-removed）ため全廃止したが、無料の受動的な
// 「GPUがまだ温かいので今なら待たずに生成できます」という案内自体は有用
// だった。各 Studio タブは別々の Modal worker（scaledown_window=30秒、
// CLAUDE.md §1）にディスパッチするため、サイト全体で1個の共有状態を持つ
// 設計はもう正確ではない — 代わりにタブ内で完結する、自分の直前のジョブ
// 完了時刻だけを基準にしたローカルなカウントダウンにする。DB・共有状態
// 一切不要、他ユーザーとの横取り問題も原理的に起こらない。
//
// 使い方: ジョブが completed になったタイミングで markWarm() を呼ぶ。
// seconds はそのタブが叩く worker の scaledown_window と合わせること
// （既定 30 — 動画生成系ワーカーの標準値。LoRA 等 2 秒即切りのワーカーでは
// 使う意味がないので呼ばないこと）。
export function useLocalWarmCountdown(seconds = 30) {
  const [warmUntil, setWarmUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (warmUntil == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [warmUntil]);

  const markWarm = useCallback(() => {
    setWarmUntil(Date.now() + seconds * 1000);
  }, [seconds]);

  const remainingMs = warmUntil != null ? Math.max(0, warmUntil - now) : 0;
  const isWarm = remainingMs > 0;

  return { isWarm, remainingMs, markWarm };
}

export function formatWarmCountdown(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / 1000))}`;
}
