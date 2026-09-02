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
  { name: "RTX PRO 6000", vram: "48GB", bandwidth: "0.96TB/s", hourly: 3.03, offload: true },
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
// Short job — one 2.5-minute video generation.
const SHORT_JOB: EffRow[] = [
  { gpu: "B300", duration: "2分30秒", usd: "$0.296", jpy: "約44円" },
  { gpu: "B200", duration: "2分32秒", usd: "$0.264", jpy: "約40円" },
  { gpu: "A100 80G", duration: "5分10秒", usd: "$0.215", jpy: "約32円" },
  { gpu: "RTX 6000", duration: "8分20秒", usd: "$0.421", jpy: "約63円", note: "オフロードで割高" },
  { gpu: "L40S", duration: "9分00秒", usd: "$0.293", jpy: "約44円", note: "同額で激遅" },
];

// Long job — one LoRA training run, 2000 steps.
const LONG_JOB: EffRow[] = [
  { gpu: "B300", duration: "30分", usd: "$3.550", jpy: "約533円" },
  { gpu: "B200", duration: "32分", usd: "$3.333", jpy: "約500円", note: "実質最安", best: true },
  { gpu: "H100", duration: "1時間05分", usd: "$4.279", jpy: "約642円", note: "割高" },
  { gpu: "A100 80G", duration: "1時間50分", usd: "$4.583", jpy: "約687円", note: "割高" },
  { gpu: "L40S", duration: "4時間00分", usd: "$7.800", jpy: "約1,170円", note: "2倍以上割高" },
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
            title="実効コスト比較 ① 短時間ジョブ（動画生成 2.5分・B300基準）"
            subtitle="所要時間が短いジョブは、時給が安いGPUでも総額が逆転しやすい。"
            rows={SHORT_JOB}
          />
          <EffectiveCostTable
            title="実効コスト比較 ② 長時間ジョブ（LoRA学習 2000 steps・B300基準）"
            subtitle="長時間ジョブほど「遅い＝高い」が顕著。B200が実質最安。"
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
          </p>
        </div>
      )}
    </div>
  );
}
