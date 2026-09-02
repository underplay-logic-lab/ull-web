"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Flame, Loader2, X, Zap } from "lucide-react";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useGpuWarmCountdown, formatWarmCountdown } from "@/hooks/useGpuWarmCountdown";
import { extendGpuWarm, type GpuWarmApiError } from "@/lib/gpuWarmApi";
import { WARM_EXTEND_COST, WARM_EXTEND_SECONDS } from "@/lib/gpuWarm";
import { LoginModal } from "@/components/LoginModal";

function InsufficientWarmCreditsModal({
  open,
  onClose,
  credits,
}: {
  open: boolean;
  onClose: () => void;
  credits: number | null;
}) {
  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      data-source-file="src/components/studio/GpuWarmStokeWidget.tsx"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border-gradient bg-surface p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">クレジットが不足しています</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-muted transition-colors hover:text-foreground"
          >
            <X size={20} />
          </button>
        </div>

        <p className="mt-2 text-sm leading-relaxed text-muted">
          GPUウォームの延長には {WARM_EXTEND_COST} クレジット必要です。現在の保有クレジット: {credits ?? 0}
        </p>

        <a
          href="#pricing"
          onClick={onClose}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90"
        >
          <Zap size={16} />
          クレジットをチャージする
        </a>
      </div>
    </div>,
    document.body,
  );
}

// Contextual "🔥 火をくべる" control, meant to sit right next to a tab's own
// generate button (WanAnimateTab / CinematicVideoTab / CustomWorkflowsTab)
// rather than in the shared header (see GpuWarmBadge.tsx). Only ever
// occupies space while the shared GPU is actually warm — collapses via a
// pure-CSS fade the instant the countdown hits 0, so there's never a moment
// where a cold user can see (and accidentally click) an extend button that
// would just spend a credit warming a GPU nobody is about to use yet.
export function GpuWarmStokeWidget() {
  const { user } = useSupabaseUser();
  const { credits } = useProfileCredits(user);
  const { remainingMs, isWarm, setWarmUntil } = useGpuWarmCountdown();

  const [extending, setExtending] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [insufficientOpen, setInsufficientOpen] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const handleExtend = async () => {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    setExtending(true);
    setErrorNotice(null);
    try {
      const result = await extendGpuWarm();
      setWarmUntil(result.warmUntil);
      broadcastCreditsUpdate(user.id, result.remainingCredits);
    } catch (err) {
      const apiError = err as GpuWarmApiError;
      if (typeof apiError.remainingCredits === "number") {
        setInsufficientOpen(true);
      } else {
        setErrorNotice(apiError.message || "延長に失敗しました。");
      }
    } finally {
      setExtending(false);
    }
  };

  return (
    <div
      data-source-file="src/components/studio/GpuWarmStokeWidget.tsx"
      className={`grid overflow-hidden transition-all duration-500 ease-out ${
        isWarm ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      }`}
    >
      <div className="flex min-h-0 flex-wrap items-center justify-center gap-2 pb-1">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-500/40 bg-orange-500/10 px-3 py-1 font-mono text-xs font-medium text-orange-400">
          <Flame size={13} />
          {`GPU稼働中: ${formatWarmCountdown(remainingMs)}（待機時間なしで即生成開始）`}
        </span>

        <button
          type="button"
          onClick={handleExtend}
          disabled={extending}
          className="inline-flex items-center gap-1.5 rounded-full border border-neon-pink/40 bg-neon-pink/10 px-3 py-1 text-xs font-medium text-neon-pink transition-colors hover:bg-neon-pink/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {extending ? <Loader2 size={13} className="animate-spin" /> : <Flame size={13} />}
          {`GPUを維持 / +${WARM_EXTEND_SECONDS}秒延長（${WARM_EXTEND_COST} credit）`}
        </button>

        {errorNotice && <p className="w-full text-center text-[11px] text-red-400">{errorNotice}</p>}
      </div>

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        message="GPUウォームを延長するにはログインしてください。"
      />
      <InsufficientWarmCreditsModal
        open={insufficientOpen}
        onClose={() => setInsufficientOpen(false)}
        credits={credits}
      />
    </div>
  );
}
