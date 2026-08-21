"use client";

import { createPortal } from "react-dom";
import { Check, Gift, Lock, Sparkles, X } from "lucide-react";

// Free-tier only — paid subscribers get a toast instead (see Header.tsx),
// since their flat daily bonus has no 7-day cycle to visualize.
export type LoginStreakData = {
  bonus: number;
  streak: number;
  dayInCycle: number;
  tier: "free";
};

type LoginStreakModalProps = {
  data: LoginStreakData | null;
  onClose: () => void;
};

const STREAK_CYCLE_LENGTH = 7;
const FREE_DAY_BONUS: Record<number, number> = { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 8 };

export function LoginStreakModal({ data, onClose }: LoginStreakModalProps) {
  if (!data || typeof document === "undefined") return null;

  const dayInCycle = data.dayInCycle;
  const isFinalDay = dayInCycle === STREAK_CYCLE_LENGTH;

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
          <h3 className="text-lg font-bold text-foreground">
            🔥 【オープン記念】7日間ログインボーナス！
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

        <div className="mt-6 grid grid-cols-7 gap-1.5 sm:gap-2">
          {Array.from({ length: STREAK_CYCLE_LENGTH }, (_, i) => i + 1).map((day) => {
            const isToday = day === dayInCycle;
            const isDone = day < dayInCycle;
            const isFinal = day === STREAK_CYCLE_LENGTH;

            return (
              <div
                key={day}
                className={`flex flex-col items-center justify-center gap-1 rounded-xl border p-1.5 text-center sm:p-2 ${
                  isToday
                    ? "border-neon-pink bg-neon-pink/10 shadow-[0_0_12px_rgba(255,42,133,0.3)]"
                    : isDone
                      ? "border-emerald-500/40 bg-emerald-500/10"
                      : "border-border bg-background/60 opacity-60"
                }`}
              >
                <span className="font-mono text-[9px] text-muted sm:text-[10px]">{day}日目</span>
                {isDone ? (
                  <Check size={16} className="text-emerald-400" />
                ) : isToday ? (
                  isFinal ? (
                    <Gift size={16} className="text-neon-pink" />
                  ) : (
                    <Sparkles size={16} className="text-neon-pink" />
                  )
                ) : (
                  <Lock size={13} className="text-muted" />
                )}
                <span
                  className={`font-mono text-[9px] sm:text-[10px] ${
                    isFinal ? "font-bold text-neon-pink" : "text-foreground/70"
                  }`}
                >
                  +{FREE_DAY_BONUS[day]}C
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-5 rounded-xl border border-neon-pink/30 bg-neon-pink/10 p-4 text-center">
          {isFinalDay ? (
            <p className="text-sm font-bold text-neon-pink">
              🎁 +{data.bonus} Credits 特大ボーナス!
            </p>
          ) : (
            <p className="text-sm font-bold text-foreground">
              本日のボーナス +{data.bonus}C 獲得！
            </p>
          )}
        </div>

        <p className="mt-3 text-center text-xs text-muted">
          {isFinalDay
            ? "次のサイクルもログインを継続してさらにお得に！"
            : `7日目の特大ボーナスまで あと ${STREAK_CYCLE_LENGTH - dayInCycle} 日！`}
        </p>

        <button
          type="button"
          onClick={onClose}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90"
        >
          画像生成をはじめる
        </button>
      </div>
    </div>,
    document.body,
  );
}
