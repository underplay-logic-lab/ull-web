import type { KnobKey, PricingKnobs } from "@/lib/pricing/knobDefaults";

// 実稼働ログ（管理画面「実稼働ログ & 粗利監視」タブ）の原価・粗利計算用
// （2026-09-18導入）。各 Modal ワーカーが generation_logs へ渡す gpu_tier
// 文字列（torch.cuda.get_device_name() 由来の実機名、または GPU_REQUEST の
// 表記）は表記ゆれがあるため、部分一致で正規化してから knobDefaults.ts の
// per-tier レートを引く。新しいGPUを使うようになったらここに1行追加する。
//
// GPU時給はUSD建てのknobで持ち、円換算は usd_jpy_rate を経由して都度計算する
// （2026-09-18、円を直接ハードコードする旧設計から修正 — 為替が動いた時に
// 触る箇所を usd_jpy_rate 一つに集約するため。ホスト指摘）。
const GPU_TIER_PATTERNS: { pattern: RegExp; knobKey: KnobKey; label: string }[] = [
  { pattern: /b300/i, knobKey: "gpu_usd_per_hour_b300", label: "B300" },
  { pattern: /b200/i, knobKey: "gpu_usd_per_hour_b200", label: "B200" },
  { pattern: /h200/i, knobKey: "gpu_usd_per_hour_h200", label: "H200" },
  { pattern: /h100/i, knobKey: "gpu_usd_per_hour_h100", label: "H100" },
  { pattern: /rtx.?pro.?6000/i, knobKey: "gpu_usd_per_hour_rtx_pro_6000", label: "RTX PRO 6000" },
  // 80GB表記を先に見る（無指定の "a100" は 40GB 扱いにフォールバック）。
  { pattern: /a100.*80|80.*a100/i, knobKey: "gpu_usd_per_hour_a100_80gb", label: "A100 80GB" },
  { pattern: /a100/i, knobKey: "gpu_usd_per_hour_a100_40gb", label: "A100 40GB" },
  { pattern: /l40s/i, knobKey: "gpu_usd_per_hour_l40s", label: "L40S" },
  { pattern: /a10g?\b/i, knobKey: "gpu_usd_per_hour_a10", label: "A10" },
  { pattern: /\bl4\b/i, knobKey: "gpu_usd_per_hour_l4", label: "L4" },
  { pattern: /\bt4\b/i, knobKey: "gpu_usd_per_hour_t4", label: "T4" },
];

export function normalizeGpuTier(raw: string | null | undefined): { label: string; knobKey: KnobKey } | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  for (const { pattern, knobKey, label } of GPU_TIER_PATTERNS) {
    if (pattern.test(trimmed)) return { label, knobKey };
  }
  return null;
}

/** 1時間あたりのGPU原価（円、usd_jpy_rate換算後）。未知/空のtierは null
 * （呼び出し側は job_type単位のフラット単価にフォールバックすること）。 */
export function gpuHourlyRateJpy(tier: string | null | undefined, knobs: PricingKnobs): number | null {
  const norm = normalizeGpuTier(tier);
  if (!norm) return null;
  const usdRate = knobs[norm.knobKey];
  if (typeof usdRate !== "number" || !Number.isFinite(usdRate)) return null;
  return usdRate * knobs.usd_jpy_rate;
}

/** 実行時間(ms)とGPU tierから実原価（円）を算出する。tierが不明な場合は
 * null（呼び出し側でjob_type別のフラット単価にフォールバックすること）。 */
export function estimateJobCostJpy(executionTimeMs: number | null | undefined, tier: string | null | undefined, knobs: PricingKnobs): number | null {
  // 'none' = GPU を起動する前に終わったジョブ（2026-09-25、migration 20260890000000）。原価 0。
  if ((tier ?? "").trim().toLowerCase() === "none") return 0;
  // 'cpu<コア数>' = CPU だけの処理（2026-09-26、構図判定 WD タガー）。コア数 × CPU 単価 × 時間。
  const cpu = /^cpu(\d+(?:\.\d+)?)$/i.exec((tier ?? "").trim());
  if (cpu) {
    const ms = typeof executionTimeMs === "number" && Number.isFinite(executionTimeMs) ? executionTimeMs : 0;
    return (ms / 1000 / 3600) * Number(cpu[1]) * knobs.cpu_usd_per_core_hour * knobs.usd_jpy_rate;
  }
  const rate = gpuHourlyRateJpy(tier, knobs);
  if (rate == null) return null;
  const ms = typeof executionTimeMs === "number" && Number.isFinite(executionTimeMs) ? executionTimeMs : 0;
  return (ms / 1000 / 3600) * rate;
}
