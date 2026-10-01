"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, X, Zap } from "lucide-react";
import { Pricing } from "@/components/Pricing";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits } from "@/hooks/useProfileCredits";

// クレジット不足の案内の中身（2026-10-01）。料金表（Pricing。都度チャージと月額プランの両方が並ぶ）を Studio の上に重ねて出し、
// 購入は埋め込み決済（@polar-sh/checkout/embed、Pricing 側）。ページを離れず・タブも増えず・作業中の内容が消えない。
// 入口は 1 つ（ホスト判断 2026-10-01: 都度と月額でボタンを分けるより、料金表で比べて選ぶ方が迷わない）。
// 購入後の残高は webhook → profiles 更新 → useProfileCredits の realtime 購読で、この画面にもそのまま反映される。
export function TopupActions({ cost, onClose }: { cost: number; onClose: () => void }) {
  const { user } = useSupabaseUser();
  const { credits } = useProfileCredits(user);
  const [purchased, setPurchased] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  const enough = (credits ?? 0) >= cost;

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
        onClick={() => setPlansOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-background transition-all hover:opacity-90"
      >
        <Zap size={16} />
        クレジットを購入する
      </button>
      <p className="text-center text-[11px] leading-relaxed text-muted">
        都度チャージと月額プランから選べます。この画面のまま購入でき、今の設定は消えません。
      </p>
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
