"use client";

import { useState } from "react";
import { ArrowRight, Check, Gift, Loader2, Sparkles } from "lucide-react";
import { pricingPlans, type PricingPlan } from "@/lib/data";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { supabase } from "@/lib/supabaseClient";
import { EditableText } from "@/components/EditableText";

export function Pricing() {
  const { user } = useSupabaseUser();
  const [loginOpen, setLoginOpen] = useState(false);
  const [processingPlanId, setProcessingPlanId] = useState<string | null>(null);

  // Only the one-time top-up has a Polar product configured
  // (NEXT_PUBLIC_POLAR_PRODUCT_ID_120 — see src/lib/polar.ts). The four
  // subscription plans' purchase buttons are disabled ("準備中") below
  // until they have Polar products of their own; Stripe checkout, which
  // used to serve all five, is retired (see src/app/api/stripe/checkout).
  const isPurchasable = (planId: string) => planId === "topup";

  const handlePurchase = async (plan: PricingPlan) => {
    if (!isPurchasable(plan.id)) return;

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
        setLoginOpen(true);
        return;
      }

      const res = await fetch("/api/checkout/polar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({}),
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
                <span className="text-3xl font-bold tracking-tight text-gradient">
                  {plan.price}
                </span>
                {plan.period && (
                  <span className="font-mono text-xs text-muted">
                    {plan.period}
                  </span>
                )}
              </div>
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
                disabled={!isPurchasable(plan.id) || processingPlanId === plan.id}
                className="mt-8 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {processingPlanId === plan.id ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    決済ページへ移動中...
                  </>
                ) : !isPurchasable(plan.id) ? (
                  "準備中（Coming Soon）"
                ) : (
                  plan.cta
                )}
              </button>

              {plan.id === "topup" ? (
                <p className="mt-3 text-[11px] leading-relaxed text-muted">
                  ※ 決済完了後、直ちにクレジットが付与されます。
                </p>
              ) : (
                <p className="mt-3 text-[11px] leading-relaxed text-muted">
                  ※ 月額サブスクリプションプランは現在準備中です。公開までしばらくお待ちください。
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
