"use client";

import { Check, Sparkles } from "lucide-react";
import { pricingPlans } from "@/lib/data";

function handlePurchase(planName: string) {
  alert(
    `「${planName}」の Stripe Checkout 連携は準備中です。\n公開時にここから決済ページへ遷移します。`,
  );
}

export function Pricing() {
  return (
    <section id="pricing" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-5xl px-6">
        <div className="mb-16 text-center">
          <p className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-violet">
            Pricing
          </p>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            料金プラン
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted">
            必要な分だけの都度チャージか、使い放題の月額サブスクリプション。
          </p>
        </div>

        <div className="grid gap-8 sm:grid-cols-2">
          {pricingPlans.map((plan) => (
            <div
              key={plan.id}
              className={`relative flex flex-col rounded-2xl p-8 ${
                plan.highlighted
                  ? "border-gradient bg-surface/60 glow-pink"
                  : "border border-border bg-surface/40"
              }`}
            >
              {plan.highlighted && (
                <span className="absolute top-6 right-6 flex items-center gap-1 rounded-full bg-neon-pink/10 px-3 py-1 text-xs font-mono font-medium text-neon-pink">
                  <Sparkles size={12} />
                  おすすめ
                </span>
              )}

              <h3 className="text-lg font-bold text-muted">{plan.name}</h3>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-4xl font-bold tracking-tight text-gradient">
                  {plan.price}
                </span>
                {plan.period && (
                  <span className="font-mono text-sm text-muted">
                    {plan.period}
                  </span>
                )}
              </div>
              <p className="mt-4 text-sm leading-relaxed text-muted">
                {plan.description}
              </p>

              <ul className="mt-6 flex-1 space-y-2.5">
                {plan.features.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-start gap-2.5 text-sm text-foreground/80"
                  >
                    <Check size={16} className="mt-0.5 shrink-0 text-neon-pink" />
                    {feature}
                  </li>
                ))}
              </ul>

              <button
                type="button"
                onClick={() => handlePurchase(plan.name)}
                className="mt-8 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3.5 text-sm font-semibold text-white transition-all hover:opacity-90"
              >
                {plan.cta}
              </button>
            </div>
          ))}
        </div>

        <p className="mt-8 text-center text-xs text-muted">
          決済は Stripe を利用予定です。価格はすべて税込表示です。
        </p>
      </div>
    </section>
  );
}
