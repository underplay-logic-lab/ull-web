"use client";

import { Mail, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { TOPUP_PRICE_BY_TIER, type SubscriptionTier } from "@/hooks/useProfileCredits";

// Support inbox for subscription management now that the self-service
// Stripe Customer Portal (/api/stripe/portal) is retired — see
// src/app/api/stripe/portal/route.ts. Same address as the tokushoho
// (特定商取引法に基づく表記) page's contact point.
const SUPPORT_EMAIL = "support@ullstudio.com";

type CancellationWarningModalProps = {
  open: boolean;
  onClose: () => void;
  tier: SubscriptionTier;
  // Already reserved to cancel (Customer Portal "cancel at period end").
  // Warning someone in this state about losing perks they've already lost
  // reads as broken, not cautious — the copy below switches to explaining
  // how to get them back instead.
  cancelAtPeriodEnd?: boolean;
};

const FULL_PRICE = TOPUP_PRICE_BY_TIER.free;

const TIER_LABEL: Record<SubscriptionTier, string> = {
  free: "Free",
  entry: "Entry",
  standard: "Standard",
  pro: "Pro",
  master: "Master",
};

// What support can help with when someone reaches out — shown up front so
// someone here only for a receipt or an upgrade isn't greeted with
// cancellation-flavored copy before they even see what's possible.
const SUPPORT_CAPABILITIES = [
  "領収書・請求書（PDF）の発行（インボイス・確定申告対応）",
  "プランのアップグレード・変更のご相談",
  "お支払い方法の更新・解約手続き",
];

export function CancellationWarningModal({ open, onClose, tier, cancelAtPeriodEnd = false }: CancellationWarningModalProps) {
  const currentTopupPrice = TOPUP_PRICE_BY_TIER[tier];

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      data-source-file="src/components/CancellationWarningModal.tsx"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border-gradient bg-surface p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-lg font-bold text-foreground">📋 サブスクリプション・契約管理</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="shrink-0 text-muted transition-colors hover:text-foreground"
          >
            <X size={20} />
          </button>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-foreground/90">
          現在、契約管理はサポート窓口での対応となっております。以下のご相談を承ります：
        </p>

        <ul className="mt-3 space-y-2">
          {SUPPORT_CAPABILITIES.map((item) => (
            <li key={item} className="flex items-start gap-2 text-sm text-foreground/80">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-neon-violet" />
              {item}
            </li>
          ))}
        </ul>

        <div className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="flex items-center gap-1.5 text-xs font-bold text-amber-400">
            <AlertTriangle size={14} className="shrink-0" />
            【ご注意】
          </p>
          {cancelAtPeriodEnd ? (
            <p className="mt-2 text-xs leading-relaxed text-foreground/80">
              現在、解約予約中のため優待特典（割引・ログインボーナス）は一時停止されています。サブスクリプションの再開をご希望の場合はサポート窓口までご連絡ください。{TIER_LABEL[tier]}優待は再開次第すぐに復活します。
            </p>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-foreground/80">
              プランの解約やダウングレードを行った場合、会員限定の「追加チャージ優待（¥{currentTopupPrice} ➔ 定価¥{FULL_PRICE}）」や「毎日のログインボーナス」等の継続特典が即日停止・変更されますのでご留意ください。
            </p>
          )}
          <p className="mt-2 text-xs leading-relaxed text-muted">
            ※ ご購入済みの保有クレジット残高は有効期限までそのままご利用いただけます。
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            ※ 請求書・領収書（PDF）が必要な場合は、サポート窓口までお申し付けください。
          </p>
        </div>

        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90"
        >
          <Mail size={16} />
          サポート窓口へ連絡する
        </a>

        <button
          type="button"
          onClick={onClose}
          className="mt-3 flex w-full items-center justify-center text-xs text-muted transition-colors hover:text-foreground"
        >
          キャンセル
        </button>
      </div>
    </div>,
    document.body,
  );
}
