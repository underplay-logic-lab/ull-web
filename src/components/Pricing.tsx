"use client";

import { useState } from "react";
import { ArrowRight, Check, Gift, Loader2, Sparkles } from "lucide-react";
import { pricingPlans, type PricingPlan } from "@/lib/data";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, TOPUP_PRICE_BY_TIER } from "@/hooks/useProfileCredits";
import { supabase } from "@/lib/supabaseClient";
import { EditableText } from "@/components/EditableText";

const TOPUP_FULL_PRICE = TOPUP_PRICE_BY_TIER.free;

export function Pricing() {
  const { user } = useSupabaseUser();
  const { tier, cancelAtPeriodEnd } = useProfileCredits(user);
  const [loginOpen, setLoginOpen] = useState(false);
  const [processingPlanId, setProcessingPlanId] = useState<string | null>(null);

  // The top-up's effective price for this viewer. A signed-in active paid
  // member sees their standing discount — the same one /api/checkout/polar
  // applies via a Polar Discount. A reserved cancellation suspends the perk
  // (matches CancellationWarningModal), and signed-out visitors see full price.
  const effectiveTopupTier = !user || cancelAtPeriodEnd ? "free" : tier ?? "free";
  const topupPrice = TOPUP_PRICE_BY_TIER[effectiveTopupTier] ?? TOPUP_FULL_PRICE;
  const topupDiscountPct = Math.round((1 - topupPrice / TOPUP_FULL_PRICE) * 100);

  // All five plans (topup + entry/standard/pro/master) now check out through
  // Polar — each carries its Polar product id from NEXT_PUBLIC_POLAR_PRODUCT_ID_*
  // (see src/lib/data.ts / src/lib/polar.ts). A plan is purchasable as long
  // as its product id resolved; a button only stays disabled if the env var
  // is missing. Stripe checkout, which used to serve all five, is retired
  // (see src/app/api/stripe/checkout).
  const isPurchasable = (plan: PricingPlan) => Boolean(plan.productId);

  const handlePurchase = async (plan: PricingPlan) => {
    if (!isPurchasable(plan)) return;

    if (!user) {
      setLoginOpen(true);
      return;
    }

    setProcessingPlanId(plan.id);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        setProcessingPlanId(null);
        setLoginOpen(true);
        return;
      }

      const res = await fetch("/api/checkout/polar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ productId: plan.productId }),
      });

      const data = await res.json();

      if (!res.ok || !data.checkoutUrl) {
        throw new Error(data?.error || "決済セッションの作成に失敗しました。");
      }

      window.location.assign(data.checkoutUrl);
    } catch (err) {
      alert(err instanceof Error ? err.message : "決済セッションの作成に失敗しました。");
      setProcessingPlanId(null);
    }
  };

  return (
    <section id="pricing" data-source-file="src/components/Pricing.tsx" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-16 text-center">
          <EditableText
            as="p"
            siteKey="pricing_eyebrow"
            fallback="Pricing"
            className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-violet"
          />
          <EditableText
            as="h2"
            siteKey="pricing_title"
            fallback="料金プラン"
            className="text-3xl font-bold tracking-tight sm:text-4xl"
          />
          <EditableText
            as="p"
            siteKey="pricing_subtitle"
            fallback="必要な分だけの都度チャージか、毎月クレジットが自動付与される月額プラン。"
            className="mx-auto mt-4 max-w-xl text-muted"
          />
          <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-neon-pink/30 bg-neon-pink/10 px-4 py-1.5 text-xs font-mono font-medium text-neon-pink">
            <Gift size={14} />
            新規アカウント登録で即時10クレジット無料進呈（クレカ登録不要）
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {pricingPlans.map((plan) => (
            <div
              key={plan.id}
              className={`relative flex flex-col rounded-2xl p-6 ${
                plan.highlighted
                  ? "border-gradient bg-surface/60 glow-pink"
                  : "border border-border bg-surface/40"
              }`}
            >
              {plan.highlighted && (
                <span className="absolute top-5 right-5 flex items-center gap-1 rounded-full bg-neon-pink/10 px-3 py-1 text-xs font-mono font-medium text-neon-pink">
                  <Sparkles size={12} />
                  おすすめ
                </span>
              )}

              <h3 className="text-base font-bold text-muted">{plan.name}</h3>
              <div className="mt-3 flex items-baseline gap-1">
                {plan.id === "topup" && topupDiscountPct > 0 && (
                  <span className="font-mono text-base font-medium text-muted line-through">
                    ¥{TOPUP_FULL_PRICE.toLocaleString()}
                  </span>
                )}
                <span className="text-3xl font-bold tracking-tight text-gradient">
                  {plan.id === "topup" ? `¥${topupPrice.toLocaleString()}` : plan.price}
                </span>
                {plan.period && (
                  <span className="font-mono text-xs text-muted">
                    {plan.period}
                  </span>
                )}
              </div>
              {plan.id === "topup" && topupDiscountPct > 0 && (
                <p className="mt-1.5 inline-flex w-fit items-center gap-1 rounded-full bg-neon-pink/10 px-2.5 py-1 font-mono text-[11px] font-medium text-neon-pink">
                  会員ランク優待 {topupDiscountPct}%OFF 適用中
                </p>
              )}
              <p className="mt-4 text-xs leading-relaxed text-muted">
                {plan.description}
              </p>

              <ul className="mt-6 flex-1 space-y-2.5">
                {plan.features.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-start gap-2.5 text-xs text-foreground/80"
                  >
                    <Check size={14} className="mt-0.5 shrink-0 text-neon-pink" />
                    {feature}
                  </li>
                ))}
              </ul>

              <button
                type="button"
                onClick={() => handlePurchase(plan)}
                disabled={!isPurchasable(plan) || processingPlanId === plan.id}
                className="mt-8 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {processingPlanId === plan.id ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    決済ページへ移動中...
                  </>
                ) : (
                  plan.cta
                )}
              </button>

              {plan.id === "topup" ? (
                <p className="mt-3 text-[11px] leading-relaxed text-muted">
                  ※ 決済完了後、直ちにクレジットが付与されます。
                  {topupDiscountPct === 0 &&
                    " 月額会員は会員ランクに応じて最大50%OFFの優待価格が自動適用されます。"}
                </p>
              ) : (
                <p className="mt-3 text-[11px] leading-relaxed text-muted">
                  ※ 毎月自動更新。決済完了後すぐにクレジットが付与され、以降は毎月自動で付与されます。
                </p>
              )}
            </div>
          ))}
        </div>

        <a
          href="#contact"
          className="mt-10 flex flex-col items-center justify-between gap-4 rounded-2xl border border-neon-violet/30 bg-neon-violet/5 p-6 text-center transition-colors hover:bg-neon-violet/10 sm:flex-row sm:text-left"
        >
          <p className="text-sm leading-relaxed text-foreground/90">
            ⚙️ 大量生成・専用リソースが必要な法人のお客様へ：エンタープライズプラン・大口契約のご相談を承ります。
          </p>
          <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-gradient-to-r from-neon-pink to-neon-violet px-5 py-2.5 text-sm font-semibold text-white">
            お問い合わせはこちら
            <ArrowRight size={16} />
          </span>
        </a>

        <p className="mt-8 text-center text-xs text-muted">
          安全な決済プラットフォーム（Polar.sh）により、クレジットカード、Apple Pay、Google
          Payに対応しています。価格はすべて税込表示です。
          生成物の権利はユーザーに帰属しますが、商用利用の可否は使用した各AIモデル・LoRA固有のオープンソースライセンスに準じます。
          <br />
          ※サブスクリプションを解約予約された場合、デイリーログインボーナスの付与は即日停止されます（保有クレジットは有効期限までご利用可能）。
          <br />
          ※ 請求書・領収書に関するお問い合わせはサポート窓口（support@ullstudio.com）までご連絡ください。
        </p>
      </div>

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        message="購入を続けるにはログインしてください。"
      />
    </section>
  );
}
