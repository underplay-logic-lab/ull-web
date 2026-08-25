"use client";

import { Zap } from "lucide-react";
import type { GpuTier } from "@/lib/gpuTier";

type GpuTierSelectorProps = {
  value: GpuTier;
  onChange: (tier: GpuTier) => void;
  baseCost: number;
  addonCost: number;
};

// Shared Standard(L40S)/ULTRA(B300) picker used by every Studio feature
// that offers a GPU tier choice (Wan Animate 2, Custom Workflows) — keeps
// the card markup and pricing display in one place instead of duplicated
// per feature.
export function GpuTierSelector({ value, onChange, baseCost, addonCost }: GpuTierSelectorProps) {
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted">
        <Zap size={12} />
        GPUアクセラレーション
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onChange("standard")}
          className={`flex flex-col gap-1 rounded-xl border px-4 py-3 text-left transition-colors ${
            value === "standard"
              ? "border-neon-pink bg-neon-pink/5"
              : "border-border bg-background hover:border-neon-violet/40"
          }`}
        >
          <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            ⚪ Standard (NVIDIA L40S 48GB / 35秒)
          </span>
          <span className="font-mono text-[11px] text-muted">{baseCost} Credits（基本）</span>
        </button>
        <button
          type="button"
          onClick={() => onChange("ultra")}
          className={`flex flex-col gap-1 rounded-xl border px-4 py-3 text-left transition-colors ${
            value === "ultra"
              ? "border-neon-violet bg-neon-violet/10"
              : "border-border bg-background hover:border-neon-violet/40"
          }`}
        >
          <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            🟣 ULTRA (世界最強 NVIDIA B300 288GB / 8秒)
          </span>
          <span className="font-mono text-[11px] text-neon-violet">
            +{addonCost} Credits（合計{baseCost + addonCost}C）
          </span>
        </button>
      </div>
    </div>
  );
}
