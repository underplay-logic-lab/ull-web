"use client";

import { Mail, AlertTriangle, ArrowRight, Loader2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { TOPUP_PRICE_BY_TIER, type SubscriptionTier } from "@/hooks/useProfileCredits";

// Kept for the receipt/invoice note and as a secondary contact point —
// self-service plan changes and cancellation now go through the Polar
// customer portal (see /api/portal/polar), not support.
const SUPPORT_EMAIL = "support@ullstudio.com";

const FULL_PRICE = TOPUP_PRICE_BY_TIER.free;

const TIER_LABEL: Record<SubscriptionTier, string> = {
  free: "Free",
  entry: "Entry",
  standard: "Standard",
  pro: "Pro",
  master: "Master",
};

// "manage"   → opened from the "サブスクリプションの管理・解約" button; confirm
//              sends the user to the Polar customer portal.
// "downgrade"→ opened when a paid member picks a lower-ranked plan; confirm
//              proceeds to that plan's checkout.
type WarningMode = "manage" | "downgrade";

type CancellationWarningModalProps = {
  open: boolean;
  onClose: () => void;
  // Runs only when the user explicitly accepts the warning.
  onConfirm: () => void;
  tier: SubscriptionTier;
  mode: WarningMode;
  // Target plan label, shown in "downgrade" mode (e.g. "月額エントリー").
  targetPlanName?: string;
  // Already reserved to cancel — warning about perks they've already lost
  // reads as broken, so the copy switches to how to get them back.
  cancelAtPeriodEnd?: boolean;
  // Disables the confirm button while the portal URL is being fetched.
  loading?: boolean;
};

export function CancellationWarningModal({
  open,
  onClose,
  onConfirm,
  tier,
  mode,
  targetPlanName,
  cancelAtPeriodEnd = false,
  loading = false,
}: CancellationWarningModalProps) {
  const currentTopupPrice = TOPUP_PRICE_BY_TIER[tier];

  if (!open || typeof document === "undefined") return null;

  const title =
    mode === "downgrade" ? "⚠️ プラン変更前のご確認" : "⚠️ 解約・プラン変更手続きの前に";

  const confirmLabel =
    mode === "downgrade" ? "承知のうえ変更手続きへ進む" : "承知のうえ管理画面へ進む";

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
          <h3 className="text-lg font-bold text-foreground">{title}</h3>
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
          {mode === "downgrade"
            ? `現在の ${TIER_LABEL[tier]} プランから${targetPlanName ? `「${targetPlanName}」` : "下位プラン"}へ変更しようとしています。`
            : "サブスクリプションの管理・解約画面（プラン変更・お支払い方法の変更・解約）へ移動します。"}
        </p>

        <div className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="flex items-center gap-1.5 text-xs font-bold text-amber-400">
            <AlertTriangle size={14} className="shrink-0" />
            【ご注意】継続特典について
          </p>
          {cancelAtPeriodEnd ? (
            <p className="mt-2 text-xs leading-relaxed text-foreground/80">
              現在、解約予約中のため優待特典（割引・ログインボーナス）は一時停止されています。
              {TIER_LABEL[tier]}優待はサブスクリプションを再開次第すぐに復活します。
            </p>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-foreground/80">
              プランの解約・ダウングレードを行うと、会員限定の「追加チャージ優待（¥{currentTopupPrice} ➔ 定価¥
              {FULL_PRICE}）」や「毎日のログインボーナス（現在の付与額）」等の継続特典が、
              即日または次回請求日をもって停止・変更されます。
            </p>
          )}
          <p className="mt-2 text-xs leading-relaxed text-muted">
            ※ ご購入済みの保有クレジット残高は有効期限までそのままご利用いただけます。
          </p>
        </div>

        <button
          type="button"
          onClick={onConfirm}
          disabled={loading}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              移動中...
            </>
          ) : (
            <>
              {confirmLabel}
              <ArrowRight size={16} />
            </>
          )}
        </button>

        <button
          type="button"
          onClick={onClose}
          className="mt-3 flex w-full items-center justify-center text-xs text-muted transition-colors hover:text-foreground"
        >
          やめておく（このまま継続する）
        </button>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-muted">
          <Mail size={12} />
          請求書・領収書（PDF）が必要な場合は
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline transition-colors hover:text-foreground">
            {SUPPORT_EMAIL}
          </a>
        </p>
      </div>
    </div>,
    document.body,
  );
}
