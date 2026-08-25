"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Flame, Loader2, Snowflake, X, Zap } from "lucide-react";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useGpuWarmStatus } from "@/hooks/useGpuWarmStatus";
import { extendGpuWarm, type GpuWarmApiError } from "@/lib/gpuWarmApi";
import { WARM_EXTEND_COST } from "@/lib/gpuWarm";
import { LoginModal } from "@/components/LoginModal";

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

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
      data-source-file="src/components/studio/GpuWarmBadge.tsx"
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

// Global "🔥 火入れ" status badge shown above the Studio tab switcher
// (Studio.tsx) — gpu_warm_status is one shared row everyone contributes to
// and watches together, so this lives above the per-tab generation
// components rather than being duplicated inside each one.
export function GpuWarmBadge() {
  const { user } = useSupabaseUser();
  const { credits } = useProfileCredits(user);
  const { warmUntil, setWarmUntil } = useGpuWarmStatus();

  // Local 1s ticker driving the countdown display — warmUntil itself only
  // changes on an actual extend (via Realtime or the optimistic update
  // below), not every second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const [extending, setExtending] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [insufficientOpen, setInsufficientOpen] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const remainingMs = warmUntil ? new Date(warmUntil).getTime() - now : 0;
  const isWarm = remainingMs > 0;

  const handleExtend = async () => {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    setExtending(true);
    setErrorNotice(null);
    try {
      const result = await extendGpuWarm();
      // Applied immediately rather than waiting on the Realtime round-trip
      // — same "don't wait on Postgres realtime for the actor's own
      // action" reasoning as broadcastCreditsUpdate.
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
    <div className="mt-5 flex flex-col items-center gap-2">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-xs font-medium ${
          isWarm
            ? "border-orange-500/40 bg-orange-500/10 text-orange-400"
            : "border-border bg-surface/40 text-muted"
        }`}
      >
        {isWarm ? (
          <>
            <Flame size={13} />
            {`GPU加熱中: ${formatCountdown(remainingMs)}（次回生成は爆速）`}
          </>
        ) : (
          <>
            <Snowflake size={13} />
            GPU待機中（初回ロードに3〜4分かかります）
          </>
        )}
      </span>

      <button
        type="button"
        onClick={handleExtend}
        disabled={extending}
        className="inline-flex items-center gap-1.5 rounded-full border border-neon-pink/40 bg-neon-pink/10 px-3 py-1 text-xs font-medium text-neon-pink transition-colors hover:bg-neon-pink/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {extending ? <Loader2 size={13} className="animate-spin" /> : <Flame size={13} />}
        {`火をくべる / 1分延長（${WARM_EXTEND_COST} credit）`}
      </button>

      {errorNotice && <p className="text-[11px] text-red-400">{errorNotice}</p>}

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
