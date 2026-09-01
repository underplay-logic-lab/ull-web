// Multi-dimensional dynamic price for one LoRA training run.
//
// The old model charged by step count alone (200→50C … 5000→500C). That
// under-priced heavy configs badly — a 3000-step MiniMax H3 run at 1280px
// with batch 4 and rank 64 costs multiples of a 3000-step SDXL run at 512px
// but paid the same flat rate. This computes credits from the parameters
// that actually drive GPU-seconds:
//
//   credits = ceil( 0.1 * modelMult * resolutionMult * batchMult * rankMult * steps )
//
// Used by BOTH the LoRA Studio UI (live "消費クレジット" label) and
// /api/studio/lora/train (the authoritative debit), fed the same parsed
// ai-toolkit config object so the two can never disagree.

// Per-step base rate, in credits.
export const LORA_CREDIT_PER_STEP = 0.1;

// Model archs whose per-step compute is materially higher — the video DiT
// backbones. Everything else (SDXL / FLUX / SD3 / SD1.5 …) is 1.0x.
export const HEAVY_LORA_ARCHES: ReadonlySet<string> = new Set([
  "minimax_h3",
  "wan21",
  "wan2_1",
  "wan22",
  "hunyuan",
  "hunyuan_video",
  "cogvideox",
  "ltxv",
  "ltx2",
  "mochi",
]);

// Absolute ceiling — charged server-side when a raw YAML can't be parsed at
// all (the UI already blocks submit in that case, so this is pure defence).
// = 0.1 * 3.0 * 2.0 * 2.0 * 1.2 * 5000
export const LORA_CREDIT_WORST_CASE = 7200;

export type LoraPriceBreakdown = {
  steps: number;
  perStep: number;
  modelMult: number;
  resolutionMult: number;
  batchMult: number;
  rankMult: number;
  maxResolution: number;
  effectiveBatch: number;
  linearRank: number;
  arch: string;
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
  opts: { archFallback?: string } = {},
): LoraPriceBreakdown {
  const proc = pickProcess(yamlObj);
  const model = asObject(proc.model);
  const train = asObject(proc.train);
  const network = asObject(proc.network);
  const datasets = Array.isArray(proc.datasets) ? proc.datasets : [];

  // steps — train.steps, or a bare process-level steps as a fallback.
  const steps = Math.max(0, Math.round(asNumber(train.steps) ?? asNumber(proc.steps) ?? 0));

  // model coefficient — the YAML's own arch, else the caller's fallback
  // (the dropdown pick — the worker resolves arch from it when the YAML's
  // model block omits it, so pricing must too or heavy runs under-pay).
  const arch = (String(model.arch ?? "").trim() || (opts.archFallback ?? "")).toLowerCase();
  const modelMult = HEAVY_LORA_ARCHES.has(arch) ? 3.0 : 1.0;

  // resolution coefficient — the largest edge requested across every dataset
  // (resolution is usually a list like [512, 768, 1024], sometimes a scalar).
  let maxResolution = 0;
  for (const ds of datasets) {
    const r = asObject(ds).resolution;
    for (const v of Array.isArray(r) ? r : [r]) {
      const n = asNumber(v);
      if (n !== null && n > maxResolution) maxResolution = n;
    }
  }
  const resolutionMult = maxResolution >= 1280 ? 2.0 : maxResolution >= 1024 ? 1.5 : 1.0;

  // batch coefficient — effective batch = batch_size * grad-accum
  const effectiveBatch =
    Math.max(1, asNumber(train.batch_size) ?? 1) *
    Math.max(1, asNumber(train.gradient_accumulation_steps) ?? 1);
  const batchMult = effectiveBatch >= 4 ? 2.0 : effectiveBatch >= 2 ? 1.5 : 1.0;

  // rank coefficient — network.linear (LoRA dim)
  const linearRank = asNumber(network.linear) ?? 0;
  const rankMult = linearRank >= 64 ? 1.2 : 1.0;

  // Round away IEEE-754 noise (0.1 * 3 * 2000 === 600.0000000000001) before
  // the ceil so a clean 600 doesn't become 601.
  const raw = LORA_CREDIT_PER_STEP * modelMult * resolutionMult * batchMult * rankMult * steps;
  const credits = Math.ceil(Math.round(raw * 1e6) / 1e6);

  return {
    steps,
    perStep: LORA_CREDIT_PER_STEP,
    modelMult,
    resolutionMult,
    batchMult,
    rankMult,
    maxResolution,
    effectiveBatch,
    linearRank,
    arch,
    credits,
  };
}

// The one number both the UI and the debit use.
export function calculateLoraCredits(
  yamlObj: unknown,
  opts?: { archFallback?: string },
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

// Human-readable one-liner of the multipliers, for the UI hint.
export function loraPriceMultiplierSummary(b: LoraPriceBreakdown): string {
  const parts = [`${b.perStep} C/step`, `${b.steps} steps`];
  if (b.modelMult !== 1) parts.push(`モデル ×${b.modelMult}`);
  if (b.resolutionMult !== 1) parts.push(`解像度 ×${b.resolutionMult}`);
  if (b.batchMult !== 1) parts.push(`バッチ ×${b.batchMult}`);
  if (b.rankMult !== 1) parts.push(`Rank ×${b.rankMult}`);
  return parts.join(" ・ ");
}
