"use client";

import { useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, Zap } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { TOPUP_PRICE_BY_TIER, useProfileCredits } from "@/hooks/useProfileCredits";
import { POLAR_PRODUCT_IDS } from "@/lib/polarProducts";
import { TOPUP_URL } from "@/lib/topup";

// クレジット不足の案内の中身（2026-10-01）。都度チャージは Studio の上に Polar の決済を重ねて出す（@polar-sh/checkout/embed）
// ので、ページを離れず・タブも増えず・作業中の内容が消えない。月額プランは比べて選ぶ画面が要るので料金表を新しいタブで開く。
// 購入後の残高は webhook → profiles 更新 → useProfileCredits の realtime 購読で、この画面にもそのまま反映される。
// 埋め込みが使えないとき（API が embedded:false を返した＝許可外の origin 等）は決済ページを新しいタブで開く。

const TOPUP_CREDITS = 300; // src/lib/polar.ts の POLAR_PRODUCT_CONFIG（topup）と同じ

export function TopupActions({ cost, onClose }: { cost: number; onClose: () => void }) {
  const { user } = useSupabaseUser();
  const { credits, tier } = useProfileCredits(user);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [purchased, setPurchased] = useState(false);
  const price = TOPUP_PRICE_BY_TIER[tier ?? "free"] ?? TOPUP_PRICE_BY_TIER.free;
  const enough = (credits ?? 0) >= cost;

  const buyHere = async () => {
    setBusy(true);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("ログインし直してください。");
      const res = await fetch("/api/checkout/polar", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ productId: POLAR_PRODUCT_IDS.topup, embed: true }),
      });
      const data = (await res.json()) as { checkoutUrl?: string; embedded?: boolean; error?: string };
      if (!res.ok || !data.checkoutUrl) throw new Error(data.error || "決済の準備に失敗しました。");
      if (!data.embedded) {
        window.open(data.checkoutUrl, "_blank", "noopener");
        return;
      }
      const { PolarEmbedCheckout } = await import("@polar-sh/checkout/embed");
      const checkout = await PolarEmbedCheckout.create(data.checkoutUrl, { theme: "dark" });
      checkout.addEventListener("success", (event) => {
        // 成功ページへ移動させない（移動すると Studio の作業内容が消える）。
        event.preventDefault();
        setPurchased(true);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "決済の準備に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  if (purchased) {
    return (
      <div className="mt-6 space-y-3 text-center">
        <p className="flex items-center justify-center gap-1.5 text-sm font-medium text-foreground">
          <CheckCircle2 size={16} className="text-green-400" />
          購入が完了しました
        </p>
        <p className="text-xs leading-relaxed text-muted">
          {enough
            ? `残高 ${credits} クレジット。この設定のまま実行できます。`
            : "クレジットの反映まで数秒かかります。反映されたらそのまま実行できます。"}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-xl border border-border px-6 py-2.5 text-sm text-foreground hover:border-neon-violet/50"
        >
          閉じる
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-2">
      <button
        type="button"
        onClick={() => void buyHere()}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-60"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
        {TOPUP_CREDITS} クレジットをここで購入（¥{price.toLocaleString()}）
      </button>
      <a
        href={TOPUP_URL}
        target="_blank"
        rel="noopener"
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-border px-6 py-2.5 text-xs text-muted hover:border-neon-violet/40 hover:text-foreground"
      >
        月額プランを見る
        <ExternalLink size={12} />
      </a>
      <p className="text-center text-[11px] leading-relaxed text-muted">
        この画面のまま購入できます。月額プランは新しいタブで開きます。
      </p>
      {error && <p className="text-center text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
