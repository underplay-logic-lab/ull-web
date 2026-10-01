"use client";

import { useEffect, useState } from "react";
import { ToastStack, type ToastData } from "@/components/Toast";

// 決済から戻ったとき（?purchase=success）のお礼のトースト。/studio 用（2026-10-01、Studio を専用ページへ移したため。
// トップページでは従来どおり Pricing.tsx が出す）。出したら URL から purchase を消す（再読み込みで二度出さない）。
export function PurchaseSuccessToast() {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("purchase") !== "success") return;
    url.searchParams.delete("purchase");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    // effect 内で同期 setState しない（react-hooks の規則）。次のタスクで出す。
    const t = setTimeout(() => setToasts([{ id: Date.now(), message: "ご購入ありがとうございます。クレジットを付与しました。" }]), 0);
    return () => clearTimeout(t);
  }, []);
  return <ToastStack toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />;
}
