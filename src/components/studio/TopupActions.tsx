"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Loader2, X, Zap } from "lucide-react";
import { Pricing } from "@/components/Pricing";
import { supabase } from "@/lib/supabaseClient";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { TOPUP_PRICE_BY_TIER, useProfileCredits } from "@/hooks/useProfileCredits";
import { POLAR_PRODUCT_IDS } from "@/lib/polarProducts";

// クレジット不足の案内の中身（2026-10-01）。都度チャージは Studio の上に Polar の決済を重ねて出す（@polar-sh/checkout/embed）
// ので、ページを離れず・タブも増えず・作業中の内容が消えない。月額プランは料金表（Pricing）をこの上に重ねて出し、そこから
// 同じく埋め込み決済で買う（2026-10-01 ホスト指摘「月額は別タブが開く」→ 別タブをやめた）。
// 購入後の残高は webhook → profiles 更新 → useProfileCredits の realtime 購読で、この画面にもそのまま反映される。
// 埋め込みが使えないとき（API が embedded:false を返した＝許可外の origin 等）は決済ページを新しいタブで開く。

const TOPUP_CREDITS = 300; // src/lib/polar.ts の POLAR_PRODUCT_CONFIG（topup）と同じ

export function TopupActions({ cost, onClose }: { cost: number; onClose: () => void }) {
  const { user } = useSupabaseUser();
  const { credits, tier } = useProfileCredits(user);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [purchased, setPurchased] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
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
      <button
        type="button"
        onClick={() => setPlansOpen(true)}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-border px-6 py-2.5 text-xs text-muted hover:border-neon-violet/40 hover:text-foreground"
      >
        月額プランを見る
      </button>
      <p className="text-center text-[11px] leading-relaxed text-muted">
        どちらもこの画面のまま購入でき、今の設定は消えません。
      </p>
      {error && <p className="text-center text-[11px] text-red-400">{error}</p>}
      {plansOpen &&
        createPortal(
          // 重なり順は他のモーダルと同じ 100（料金表の中のプラン変更の確認・ログインも 100 で、後から開いた方が上に来る）。
          <div className="fixed inset-0 z-[100] overflow-y-auto bg-background/95 backdrop-blur-sm">
            <button
              type="button"
              onClick={() => setPlansOpen(false)}
              aria-label="閉じる"
              className="fixed right-4 top-4 z-[101] rounded-full border border-border bg-surface p-2 text-muted hover:text-foreground"
            >
              <X size={18} />
            </button>
            <Pricing
              onPurchased={() => {
                setPlansOpen(false);
                setPurchased(true);
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
