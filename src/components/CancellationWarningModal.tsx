"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { TOPUP_PRICE_BY_TIER, type SubscriptionTier } from "@/hooks/useProfileCredits";

type CancellationWarningModalProps = {
  open: boolean;
  onClose: () => void;
  tier: SubscriptionTier;
};

const FULL_PRICE = TOPUP_PRICE_BY_TIER.free;

export function CancellationWarningModal({ open, onClose, tier }: CancellationWarningModalProps) {
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentTopupPrice = TOPUP_PRICE_BY_TIER[tier];

  const handleProceedToPortal = async () => {
    setRedirecting(true);
    setError(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error("ログイン情報が見つかりません。再度ログインしてください。");
      }

      const res = await fetch("/api/stripe/portal", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      const data = await res.json();

      if (!res.ok || !data.url) {
        throw new Error(data?.error || "解約手続きページの作成に失敗しました。");
      }

      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "解約手続きページの作成に失敗しました。");
      setRedirecting(false);
    }
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border-gradient bg-surface p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h3 className="flex items-center gap-2 text-lg font-bold text-foreground">
            <AlertTriangle size={20} className="shrink-0 text-amber-400" />
            サブスクリプションを解約しますか？
          </h3>
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
          解約手続きを行うと、以下の【継続特典】が即日失われます。
        </p>

        <ul className="mt-4 space-y-2.5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-foreground/90">
          <li className="flex items-start gap-2">
            <span className="shrink-0 text-red-400">❌</span>
            毎日のログインボーナスが【即日停止】されます
          </li>
          <li className="flex items-start gap-2">
            <span className="shrink-0 text-red-400">❌</span>
            追加チャージ優待（¥{currentTopupPrice} ➔ 定価¥{FULL_PRICE}）が【即日剥奪】されます
          </li>
        </ul>

        <p className="mt-4 text-xs leading-relaxed text-muted">
          ※ ご購入済みの保有クレジット残高は有効期限までそのままご利用いただけます。
        </p>

        <p className="mt-2 text-xs leading-relaxed text-muted">
          ※ 請求書・領収書（PDF）は【契約管理 ➔ 請求履歴】より24時間いつでもダウンロードいただけます（インボイス・確定申告対応）。
        </p>

        {error && (
          <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90"
        >
          プランを継続して特典を維持する
        </button>

        <button
          type="button"
          onClick={handleProceedToPortal}
          disabled={redirecting}
          className="mt-3 flex w-full items-center justify-center gap-2 text-xs text-red-400/80 underline-offset-2 transition-colors hover:text-red-400 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
        >
          {redirecting ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              手続きページへ移動中...
            </>
          ) : (
            "特典を失っても変更・解約手続きへ進む"
          )}
        </button>
      </div>
    </div>,
    document.body,
  );
}
