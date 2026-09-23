"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, Cpu, Zap } from "lucide-react";

// ---------------------------------------------------------------------------
// Static GPU selection reference for admins. Pure display — no data source,
// no fetch. Kept in sync by hand with the Modal GPU price list + our own
// benchmark notes; update the three arrays below when either changes.
// ---------------------------------------------------------------------------

type GpuSpec = {
  name: string;
  vram: string;
  bandwidth: string;
  hourly: number;
  // true when VRAM ≤ 48GB — large models spill to CPU over the PCIe bus,
  // stretching wall-clock time several-fold ("cost inversion").
  offload: boolean;
};

// Basic spec + hourly rate, all 11 tiers, most → least capable.
const GPU_SPECS: GpuSpec[] = [
  { name: "B300", vram: "275GB", bandwidth: "8.0TB/s", hourly: 7.1, offload: false },
  { name: "B200", vram: "180GB", bandwidth: "8.0TB/s", hourly: 6.25, offload: false },
  { name: "H200", vram: "141GB", bandwidth: "4.8TB/s", hourly: 4.54, offload: false },
  { name: "H100", vram: "80GB", bandwidth: "3.35TB/s", hourly: 3.95, offload: false },
  // Blackwell 世代の 96GB GDDR7（2026-09-23 訂正: 旧 Ada の RTX 6000 と混同して 48GB になっていた）。
  { name: "RTX PRO 6000", vram: "96GB", bandwidth: "1.6TB/s", hourly: 3.03, offload: false },
  { name: "A100 80GB", vram: "80GB", bandwidth: "2.04TB/s", hourly: 2.5, offload: false },
  { name: "A100 40GB", vram: "40GB", bandwidth: "1.55TB/s", hourly: 2.1, offload: true },
  { name: "L40S", vram: "48GB", bandwidth: "0.86TB/s", hourly: 1.95, offload: true },
  { name: "A10", vram: "24GB", bandwidth: "0.60TB/s", hourly: 1.1, offload: true },
  { name: "L4", vram: "24GB", bandwidth: "0.30TB/s", hourly: 0.8, offload: true },
  { name: "T4", vram: "16GB", bandwidth: "0.32TB/s", hourly: 0.59, offload: true },
];

type EffRow = {
  gpu: string;
  duration: string;
  usd: string;
  jpy: string;
  note?: string;
  // the genuine total-cost winner for this job class
  best?: boolean;
};

// Effective cost = hourly × actual wall-clock (not the sticker hourly).
// 2026-09-23: 以前の行は推定値で実測と食い違っていた（L40S「4時間」等）ので、
// 実測（docs/gpu-benchmarks.md）に差し替え。USD/JPY 170。
// Short job — 静止画超解像 ×2（6.55MP 出力、cold 起動込み）。§1 の 3 tier 実測。
const SHORT_JOB: EffRow[] = [
  { gpu: "RTX PRO 6000", duration: "30秒（wall 86秒）", usd: "$0.072", jpy: "約12円", note: "最安・最速", best: true },
  { gpu: "L40S", duration: "58秒（wall 136秒）", usd: "$0.074", jpy: "約12.5円" },
  { gpu: "B300", duration: "49秒（wall 99秒）", usd: "$0.195", jpy: "約33円", note: "cold JIT が支配的で粗利ゼロ" },
];

// Long job — LoRA 学習 anima 2,000step・220枚（§14.21/§14.26 の s/it と prep から算出）。
const LONG_JOB: EffRow[] = [
  { gpu: "RTX PRO 6000", duration: "18分", usd: "$0.91", jpy: "約155円", note: "B300 より速くて 60% 安い", best: true },
  { gpu: "B300", duration: "19分", usd: "$2.26", jpy: "約384円" },
  { gpu: "H200（ltx2 の例）", duration: "41分", usd: "$3.08", jpy: "約524円", note: "ltx2 は B300 と同速で 36% 安" },
  { gpu: "B300（ltx2 の例）", duration: "41分", usd: "$4.81", jpy: "約818円" },
];

function EffectiveCostTable({ title, subtitle, rows }: { title: string; subtitle: string; rows: EffRow[] }) {
  return (
    <div>
      <h4 className="text-xs font-bold text-foreground">{title}</h4>
      <p className="mb-2 text-[11px] text-muted">{subtitle}</p>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[420px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-surface/60 text-[11px] uppercase tracking-wide text-muted">
              <th className="px-3 py-2 font-medium">GPU</th>
              <th className="px-3 py-2 font-medium">実質所要時間</th>
              <th className="px-3 py-2 font-medium">実効コスト</th>
              <th className="px-3 py-2 font-medium">円換算</th>
              <th className="px-3 py-2 font-medium">備考</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.gpu}
                className={`border-b border-border/60 last:border-0 ${
                  r.best ? "bg-neon-pink/5" : "hover:bg-surface-hover/40"
                }`}
              >
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold text-foreground">
                  {r.best && "★ "}
                  {r.gpu}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted">{r.duration}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-foreground">{r.usd}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted">{r.jpy}</td>
                <td className="px-3 py-2 text-[11px] text-muted">
                  {r.note ? (
                    <span className={r.best ? "text-neon-pink" : "text-amber-400"}>
                      {r.best ? "★ " : "※ "}
                      {r.note}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function GpuCostReferenceCard() {
  // Collapsed by default — a reference admins open when they need it.
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-2xl border-gradient bg-surface/40 p-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
          <Cpu size={16} className="text-neon-violet" />
          GPU実効コスト・スペック比較リファレンス
        </h3>
        <ChevronDown size={16} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {!open && (
        <p className="mt-2 text-[11px] text-muted">
          時給原価だけでは判断できない「実効コストの逆転現象」の早見表。GPU選定の根拠として常設。
        </p>
      )}

      {open && (
        <div className="mt-5 flex flex-col gap-6">
          {/* 1. Base spec + hourly rate */}
          <div>
            <h4 className="mb-2 text-xs font-bold text-foreground">基本スペック ＆ 時給原価（全11種）</h4>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[480px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface/60 text-[11px] uppercase tracking-wide text-muted">
                    <th className="px-3 py-2 font-medium">GPU</th>
                    <th className="px-3 py-2 font-medium">VRAM</th>
                    <th className="px-3 py-2 font-medium">帯域</th>
                    <th className="px-3 py-2 font-medium">時給原価</th>
                    <th className="px-3 py-2 font-medium">VRAM常駐</th>
                  </tr>
                </thead>
                <tbody>
                  {GPU_SPECS.map((g) => {
                    const recommended = g.name === "B300" || g.name === "B200";
                    return (
                      <tr
                        key={g.name}
                        className={`border-b border-border/60 last:border-0 ${
                          recommended ? "bg-neon-pink/5" : "hover:bg-surface-hover/40"
                        }`}
                      >
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold text-foreground">
                          {recommended && "★ "}
                          {g.name}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted">{g.vram}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted">{g.bandwidth}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-foreground">
                          ${g.hourly.toFixed(2)}/h
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-[11px]">
                          {g.offload ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-400">
                              <AlertTriangle size={11} />
                              CPUオフロード
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-neon-violet/10 px-2 py-0.5 font-medium text-neon-violet">
                              <Zap size={11} />
                              100%常駐
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* 2. Effective-cost comparison (B300 baseline) */}
          <EffectiveCostTable
            title="実効コスト比較 ① 短時間ジョブ（静止画超解像 ×2・6.55MP・cold 込み実測）"
            subtitle="短いジョブは起動と初回 JIT が支配的。B300 は時給に加えて cold が遅く、単発では粗利が出ない。"
            rows={SHORT_JOB}
          />
          <EffectiveCostTable
            title="実効コスト比較 ② 長時間ジョブ（LoRA 学習 2,000 steps・実測 s/it から算出）"
            subtitle="VRAM が収まる限り安い tier が勝つ arch が多い（anima は RTX PRO 6000 の方が速い）。Blackwell が常に最速ではない。"
            rows={LONG_JOB}
          />

          {/* 3. Rationale memo */}
          <div className="rounded-xl border border-neon-violet/30 bg-neon-violet/5 p-4">
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold text-neon-violet">
              <AlertTriangle size={13} />
              B300 / B200 統一の根拠
            </h4>
            <ul className="flex list-disc flex-col gap-1.5 pl-4 text-[11px] leading-relaxed text-muted">
              <li>
                <span className="text-foreground">48GB以下のGPU</span>は
                CPUオフロード（PCIeバス転送）により所要時間が数倍に伸び、
                時給が安くてもトータル原価が高くなる<span className="text-amber-400">完全なコスト逆転</span>が発生する。
              </li>
              <li>
                <span className="text-foreground">B300 / B200</span>は
                100% VRAM常駐 ＋ 8TB/s帯域により
                <span className="text-neon-pink">「最も速く、トータル原価も最安」</span>となる。
              </li>
            </ul>
          </div>

          <p className="text-[10px] text-muted opacity-70">
            ※ 数値は Modal の GPU 料金表 ＋ 自社ベンチマークに基づく参考値。料金・実測が変わったら本カード（
            <span className="font-mono">src/components/admin/GpuCostReferenceCard.tsx</span>）を更新。
          
                ※ これは動画生成（数十〜数百 GB のモデル常駐）の話。LoRA 学習と超解像は VRAM が収まる
                最安 tier を arch ごとに実測で選んでいる（docs/gpu-benchmarks.md §1・§14.26）。
              </p>
        </div>
      )}
    </div>
  );
}
