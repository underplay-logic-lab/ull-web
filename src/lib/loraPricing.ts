// Dynamic price for one LoRA training run.
//
// 2026-09-20: 「係数の掛け算」から「推定GPU秒 × クレジット単価」へ作り直した。
//
//   消費C = ceil( 推定GPU秒 × クレジット単価(ワーカー) )
//   推定GPU秒 = prep(枚数) + steps × s/it(arch, 解像度, 実効バッチ)
//
// 見積もりの実体は src/lib/pricing/loraRuntime.ts にあり、損切り
// （src/lib/pricing/costGuard.server.ts）も同じ関数を呼ぶ。課金式と損切り式が
// 別々に存在していた頃の「片方を変えてもう片方が壊れる」事故クラスはこれで
// 構造的に消えている。
//
// 旧方式（0.1 C/step × モデル × 解像度 × バッチ × rank × steps）を捨てた理由:
//   - 学習設定を変えるたびに係数を人手で校正し直す必要があり、設定が固まる
//     まで価格を決められなかった
//   - arch 間の実原価差（最大16倍）をモデル係数 1.0 / 3.0 の2段では表現
//     できず、SDXL 以外のほぼ全 arch が原価割れしていた
//   - データセット枚数に比例する準備時間（latent キャッシュ）を一切課金
//     できておらず、step 数の小さいジョブほど赤字が深くなっていた
//
// Used by BOTH the LoRA Studio UI (live "消費クレジット" label) and
// /api/studio/lora/train (the authoritative debit), fed the same parsed
// ai-toolkit config object so the two can never disagree.

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";
import {
  loraCreditsPerGpuSecond,
  loraCreditWorstCase,
  loraEstimatedSeconds,
  type LoraWorkerBackend,
} from "@/lib/pricing/loraRuntime";

export {
  LORA_SPI_BASELINE,
  loraCreditWorstCase,
  loraEstimatedSeconds,
  loraWorkerBackend,
} from "@/lib/pricing/loraRuntime";

// Absolute ceiling — charged server-side when a raw YAML can't be parsed at
// all (the UI already blocks submit in that case, so this is pure defence).
// Derived from the container's hard run limit: a job physically cannot burn
// more GPU seconds than that, so it cannot cost more than this.
export const LORA_CREDIT_WORST_CASE = loraCreditWorstCase();

export type LoraPriceBreakdown = {
  steps: number;
  maxResolution: number;
  effectiveBatch: number;
  linearRank: number;
  imageCount: number;
  arch: string;
  backend: LoraWorkerBackend;
  /** 採用した arch 別 s/it（基準解像度・バッチ1）。 */
  spi: number;
  /** 実際の1ステップ所要秒（解像度・実効バッチ込み）。 */
  secondsPerStep: number;
  prepSeconds: number;
  trainSeconds: number;
  /** 課金の元になる推定GPU秒。 */
  totalSeconds: number;
  /** 推定がコンテナのハード上限に当たったか（= 本来完走しない設定）。 */
  cappedByAbsMax: boolean;
  creditsPerGpuSecond: number;
  credits: number;
};

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// An ai-toolkit job config keeps the real knobs under config.process[0].
function pickProcess(yamlObj: unknown): Record<string, unknown> {
  const proc = (asObject(yamlObj).config as { process?: unknown } | undefined)?.process;
  const first = Array.isArray(proc) ? proc[0] : undefined;
  return asObject(first);
}

export function loraPriceBreakdown(
  yamlObj: unknown,
  opts: {
    archFallback?: string;
    /**
     * arch の s/it を直接上書きする（秒/it）。同じ ai-toolkit の arch 文字列を
     * 共有しつつ実体がずっと軽いプリセット向け。loraModels.ts の
     * LoraPreset.spiOverride から渡る。
     */
    spiOverride?: number;
    /**
     * データセットの画像枚数。準備時間（latent キャッシュ）の可変分に効く。
     * 生 YAML にはこの情報が無いので、必ず呼び出し側が実データから渡すこと。
     */
    imageCount?: number;
    /** Live admin-edited knobs; falls back to DEFAULT_KNOBS when omitted. */
    knobs?: PricingKnobs;
  } = {},
): LoraPriceBreakdown {
  const knobs = opts.knobs ?? DEFAULT_KNOBS;
  const proc = pickProcess(yamlObj);
  const model = asObject(proc.model);
  const train = asObject(proc.train);
  const network = asObject(proc.network);
  const datasets = Array.isArray(proc.datasets) ? proc.datasets : [];

  // steps — train.steps, or a bare process-level steps as a fallback.
  const steps = Math.max(0, Math.round(asNumber(train.steps) ?? asNumber(proc.steps) ?? 0));

  // arch — the YAML's own arch, else the caller's fallback (the dropdown pick;
  // the worker resolves arch from it when the YAML's model block omits it, so
  // pricing must too or heavy runs under-pay).
  const arch = (String(model.arch ?? "").trim() || (opts.archFallback ?? "")).toLowerCase();

  // resolution — the largest edge requested across every dataset (resolution
  // is usually a list like [512, 768, 1024], sometimes a scalar).
  let maxResolution = 0;
  for (const ds of datasets) {
    const r = asObject(ds).resolution;
    for (const v of Array.isArray(r) ? r : [r]) {
      const n = asNumber(v);
      if (n !== null && n > maxResolution) maxResolution = n;
    }
  }

  // 1 step で処理する画像枚数 = batch_size × gradient_accumulation。
  //
  // 🚨 2026-09-21 修正: ここは `gradient_accumulation_steps` を掛けていたが、
  // ai-toolkit ではそれは**所要時間を増やさない**キーだった。ソース確認
  // （toolkit/config_modules.py:455-462, BaseSDTrainProcess.py:2518/2549）:
  //   - `gradient_accumulation`       … 1 step の内側ループ回数（既定1）。
  //                                     処理枚数＝所要秒に効く。
  //   - `gradient_accumulation_steps` … optimizer を何 step に1回踏むか（既定1）。
  //                                     処理量は増えない。両者は相互排他。
  // 実測でも「実効バッチ4」を名乗る2ジョブが2倍違った
  //   batch2 + gas2 → 3.45 s/it（実は2枚ぶん） / batch4 → 6.52 s/it（4枚ぶん）
  // 掛けたままだと cost-guard の許容秒も過小に出て、正常なジョブを
  // 原価割れ判定で安全停止させ得る（docs §14.8.1）。
  const effectiveBatch =
    Math.max(1, asNumber(train.batch_size) ?? 1) *
    Math.max(1, asNumber(train.gradient_accumulation) ?? 1);

  // rank は arch 別の係数 k（LORA_RANK_MARGINAL）で s/it に効く。k=0 の arch では価格に影響
  // しない。SDXL は rank 32→64 で実測 +2%（誤差）なので k=0（docs §14.25）。式だけ先に用意。
  const linearRank = asNumber(network.linear) ?? 0;

  const imageCount = Math.max(0, Math.round(opts.imageCount ?? 0));

  const estimate = loraEstimatedSeconds({
    arch,
    steps,
    resolution: maxResolution,
    effectiveBatch,
    imageCount,
    rank: linearRank > 0 ? linearRank : undefined,
    spiOverride: opts.spiOverride,
    knobs,
  });

  const creditsPerGpuSecond = loraCreditsPerGpuSecond(arch, knobs);
  // Round away IEEE-754 noise before the ceil so a clean 600 doesn't become 601.
  const raw = estimate.totalSeconds * creditsPerGpuSecond;
  const credits = Math.ceil(Math.round(raw * 1e6) / 1e6);

  return {
    steps,
    maxResolution,
    effectiveBatch,
    linearRank,
    imageCount,
    arch,
    backend: estimate.backend,
    spi: estimate.spi,
    secondsPerStep: estimate.secondsPerStep,
    prepSeconds: estimate.prepSeconds,
    trainSeconds: estimate.trainSeconds,
    totalSeconds: estimate.totalSeconds,
    cappedByAbsMax: estimate.cappedByAbsMax,
    creditsPerGpuSecond,
    credits,
  };
}

// The one number both the UI and the debit use.
export function calculateLoraCredits(
  yamlObj: unknown,
  opts?: { archFallback?: string; spiOverride?: number; imageCount?: number; knobs?: PricingKnobs },
): number {
  return loraPriceBreakdown(yamlObj, opts).credits;
}

// GUI modes (完全オート / セミオート / エキスパート-スライダー) never build a
// YAML, so synthesise the equivalent ai-toolkit-shaped object and price it
// through the exact same function.
export function guiLoraPricingConfig(input: {
  arch?: string;
  resolution?: number;
  linearRank?: number;
  steps: number;
  batchSize?: number;
  gradAccum?: number;
}): unknown {
  return {
    config: {
      process: [
        {
          model: { arch: input.arch ?? "" },
          network: { linear: input.linearRank ?? 0 },
          train: {
            steps: input.steps,
            batch_size: input.batchSize ?? 1,
            gradient_accumulation_steps: input.gradAccum ?? 1,
          },
          datasets: [{ resolution: [input.resolution ?? 0] }],
        },
      ],
    },
  };
}

function formatMinutes(seconds: number): string {
  const m = seconds / 60;
  if (m < 60) return `約${Math.max(1, Math.round(m))}分`;
  return `約${(m / 60).toFixed(1)}時間`;
}

// Human-readable one-liner for the UI hint. 物理型番・原価は出さない
// （CLAUDE.md §2）— ユーザーに見せるのは「何にどれだけ時間がかかるか」だけ。
export function loraPriceMultiplierSummary(b: LoraPriceBreakdown): string {
  const parts = [`${b.steps} steps`];
  if (b.maxResolution > 0) parts.push(`${b.maxResolution}px`);
  if (b.effectiveBatch !== 1) parts.push(`バッチ ×${b.effectiveBatch}`);
  if (b.imageCount > 0) parts.push(`画像 ${b.imageCount}枚`);
  parts.push(`推定処理時間 ${formatMinutes(b.totalSeconds)}`);
  return parts.join(" ・ ");
}
