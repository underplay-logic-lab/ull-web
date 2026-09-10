// Single source of truth for every tunable pricing / cost-guard number in the
// product. Each knob has a hardcoded DEFAULT here (== the value that used to be
// scattered across loraPricing.ts / angleStudio.ts / cinematicPricing.ts /
// modal_lora_worker.py / the angle route) and, at runtime, an admin-editable
// override row in the `pricing_knobs` table (see knobs.server.ts).
//
// This file has NO imports and NO "server-only" guard: the client bundles it
// as the fallback the Studio tabs show before /api/studio/pricing responds,
// and the migration seeds `pricing_knobs` from KNOB_META below.

export type KnobCategory = "feature_credits" | "lora_formula" | "cost_guard" | "rates";

export type KnobKey =
  // --- feature_credits (public) ---
  | "image_generate"
  | "angle_turbo_per_angle"
  | "angle_pro_per_angle"
  | "angle_ref_multiplier_per_sub"
  | "cinematic_speed"
  | "cinematic_standard"
  | "cinematic_cinema_master"
  | "upscale_per_mp"
  | "upscale_min_credits"
  // --- lora_formula (public) ---
  | "lora_per_step"
  | "lora_mult_model_heavy"
  | "lora_mult_res_1024"
  | "lora_mult_res_1280"
  | "lora_mult_batch_2"
  | "lora_mult_batch_4"
  | "lora_mult_rank_64"
  // --- cost_guard (server-only) ---
  | "angle_time_per_credit_s"
  | "angle_cold_start_grace_s"
  | "upscale_time_per_credit_s"
  | "upscale_cold_start_grace_s"
  | "lora_cost_guard_multiplier"
  | "lora_margin_target"
  | "lora_floor_prep_s"
  | "lora_safety_limit_s"
  | "lora_spi_baseline_default"
  // --- rates (server-only) ---
  | "credit_to_jpy"
  | "gpu_jpy_per_hour_b300"
  | "usd_jpy_rate";

export type PricingKnobs = Record<KnobKey, number>;

type KnobMeta = {
  value: number;
  label: string;
  category: KnobCategory;
  unit: string;
  description: string;
  /** Exposed to the browser via GET /api/studio/pricing. */
  isPublic: boolean;
};

// Order here is the order the admin Pricing tab renders rows within a section.
export const KNOB_META: Record<KnobKey, KnobMeta> = {
  // ---------------------------------------------------------------- feature
  image_generate: {
    value: 1,
    label: "画像生成",
    category: "feature_credits",
    unit: "C",
    description: "1枚あたりの消費クレジット（/api/generate）",
    isPublic: true,
  },
  // 2026-09-09: turbo/pro の 2 モード廃止。angle_turbo_per_angle は未使用（DB 行は
  // 残置・admin 非表示化は任意）。単価は angle_pro_per_angle に一本化。
  angle_turbo_per_angle: {
    value: 2,
    label: "Multi-Angle Turbo（廃止・未使用）",
    category: "feature_credits",
    unit: "C/構図",
    description: "（廃止）turbo/pro 統合前の名残。課金は angle_pro_per_angle を使用。",
    isPublic: false,
  },
  angle_pro_per_angle: {
    // 2026-09-09: 12C ≈ ¥20/構図（credit_to_jpy 1.66）。B300 実測でコールドスタート
    // + 1構図(60s)でも黒字になる下限。最低 3 構図（MIN_ANGLES）と併せて原価割れを
    // 防ぐ。値は /admin の Pricing で調整可（¥25 なら 15C 等）。
    value: 12,
    label: "Multi-Angle（1構図）",
    category: "feature_credits",
    unit: "C/構図",
    description: "1構図あたりの消費クレジット（40ステップ / 最低3構図）",
    isPublic: true,
  },
  angle_ref_multiplier_per_sub: {
    // Multi-Reference（Pro）: サブ参照 1 枚ごとに per-構図 単価へ加える係数。
    // 係数 = 1 + これ × サブ枚数。B300 実測でサブ 3 枚 = 生成時間 ×3.0
    // （per-step 463ms→1373ms）→ 0.7 で係数 3.1、粗利 ~69% を維持。
    // per-構図 単価 = ceil(angle_pro_per_angle × 係数)。
    value: 0.7,
    label: "Multi-Angle サブ参照 加算係数",
    category: "feature_credits",
    unit: "×/枚",
    description: "サブ参照1枚ごとに 1構図単価へ乗せる係数（係数 = 1 + これ×枚数）。0で無料。",
    isPublic: true,
  },
  cinematic_speed: {
    value: 1,
    label: "Cinematic Speed Mode",
    category: "feature_credits",
    unit: "C",
    description: "1本あたりの消費クレジット（4ステップ / 512px）",
    isPublic: true,
  },
  cinematic_standard: {
    value: 2,
    label: "Cinematic Standard Mode",
    category: "feature_credits",
    unit: "C",
    description: "1本あたりの消費クレジット（4ステップ / 768px）",
    isPublic: true,
  },
  cinematic_cinema_master: {
    value: 5,
    label: "Cinematic Cinema Master",
    category: "feature_credits",
    unit: "C",
    description: "1本あたりの消費クレジット（20ステップ / 1024px）",
    isPublic: true,
  },
  upscale_per_mp: {
    // 超解像スタジオ（SeedVR2）: 出力の 100 万画素あたりの消費クレジット。
    // credits = max(upscale_min_credits, ceil(これ × 出力MP × モデル係数))。
    // B300 実測: 出力 ~5MP を warm ~20s / cold ~60s。3 C/MP で 2K プリセット
    // （~5MP）≈ 15C ≈ ¥25、cold 原価 ~¥19・warm ~¥6 → 黒字。
    value: 3,
    label: "超解像（100万画素あたり）",
    category: "feature_credits",
    unit: "C/MP",
    description: "出力の100万画素あたりの消費クレジット（× モデル係数）",
    isPublic: true,
  },
  upscale_min_credits: {
    // 小さい出力（HD プリセット等）でもコールドスタートを償却できる下限。
    value: 8,
    label: "超解像 最低クレジット",
    category: "feature_credits",
    unit: "C",
    description: "1枚あたりの消費クレジット下限（コールドスタート償却）",
    isPublic: true,
  },
  // ------------------------------------------------------------- lora_formula
  lora_per_step: {
    value: 0.1,
    label: "LoRA 基本単価",
    category: "lora_formula",
    unit: "C/step",
    description: "ceil(単価 × 各係数 × steps) の基本単価",
    isPublic: true,
  },
  lora_mult_model_heavy: {
    value: 3.0,
    label: "LoRA モデル係数（動画系）",
    category: "lora_formula",
    unit: "×",
    description: "minimax_h3 / wan21 / hunyuan など動画 DiT の倍率。それ以外は 1.0。",
    isPublic: true,
  },
  lora_mult_res_1024: {
    value: 1.5,
    label: "LoRA 解像度係数（≥1024px）",
    category: "lora_formula",
    unit: "×",
    description: "データセット最大解像度が 1024〜1279px のときの倍率",
    isPublic: true,
  },
  lora_mult_res_1280: {
    value: 2.0,
    label: "LoRA 解像度係数（≥1280px）",
    category: "lora_formula",
    unit: "×",
    description: "データセット最大解像度が 1280px 以上のときの倍率",
    isPublic: true,
  },
  lora_mult_batch_2: {
    value: 1.5,
    label: "LoRA バッチ係数（実効≥2）",
    category: "lora_formula",
    unit: "×",
    description: "batch_size × grad_accum が 2〜3 のときの倍率",
    isPublic: true,
  },
  lora_mult_batch_4: {
    value: 2.0,
    label: "LoRA バッチ係数（実効≥4）",
    category: "lora_formula",
    unit: "×",
    description: "batch_size × grad_accum が 4 以上のときの倍率",
    isPublic: true,
  },
  lora_mult_rank_64: {
    value: 1.2,
    label: "LoRA Rank 係数（≥64）",
    category: "lora_formula",
    unit: "×",
    description: "network.linear（LoRA dim）が 64 以上のときの倍率",
    isPublic: true,
  },
  // -------------------------------------------------------------- cost_guard
  angle_time_per_credit_s: {
    value: 10,
    label: "Angle 損切り：1C あたり猶予秒",
    category: "cost_guard",
    unit: "s/C",
    description: "max_allowed_time = 消費C × これ + コールドスタート猶予",
    isPublic: false,
  },
  angle_cold_start_grace_s: {
    // コールド時の初回 forward は Qwen の RoPE 複素演算が Inductor 非対応で
    // eager フォールバックし、B300 でも ~500s かかる（一過性）。旧 300 だと
    // コールドの大ジョブが生成前に損切り自爆しうるため 600 に引き上げ。
    value: 600,
    label: "Angle 損切り：コールドスタート猶予",
    category: "cost_guard",
    unit: "s",
    description: "コンテナ起動 + モデルロード + 初回 forward warmup の固定猶予",
    isPublic: false,
  },
  upscale_time_per_credit_s: {
    value: 4,
    label: "超解像 損切り：1C あたり猶予秒",
    category: "cost_guard",
    unit: "s/C",
    description: "max_allowed_time = 消費C × これ + コールドスタート猶予",
    isPublic: false,
  },
  upscale_cold_start_grace_s: {
    // ComfyUI 起動 + SeedVR2 7B（16.5GB）ロード + 初回 forward warmup。
    // B300 実測でコールド 1 枚目 ~40-60s。
    value: 180,
    label: "超解像 損切り：コールドスタート猶予",
    category: "cost_guard",
    unit: "s",
    description: "ComfyUI 起動 + SeedVR2 重みロード + 初回 forward の固定猶予",
    isPublic: false,
  },
  lora_cost_guard_multiplier: {
    value: 1.4,
    label: "LoRA 損切り：余裕倍率",
    category: "cost_guard",
    unit: "×",
    description: "クレジット按分秒 × これ = 予測壁時計の停止閾値。1.0 で厳格な損益分岐。",
    isPublic: false,
  },
  lora_margin_target: {
    value: 0.7,
    label: "LoRA 損切り：粗利ターゲット",
    category: "cost_guard",
    unit: "率",
    description: "0.7 = GPU 原価を売上の 70% までに抑える（粗利 30%）",
    isPublic: false,
  },
  lora_floor_prep_s: {
    value: 2700,
    label: "LoRA 損切り：prep 下駄秒",
    category: "cost_guard",
    unit: "s",
    description: "純学習時間に加算する latent キャッシュ / チェックポイント余裕",
    isPublic: false,
  },
  lora_safety_limit_s: {
    value: 18000,
    label: "LoRA 損切り：0C ジョブ上限",
    category: "cost_guard",
    unit: "s",
    description: "クレジット 0（生 YAML パース不能）ジョブの絶対上限秒",
    isPublic: false,
  },
  lora_spi_baseline_default: {
    value: 2.5,
    label: "LoRA 損切り：未知 arch の s/it",
    category: "cost_guard",
    unit: "s/it",
    description: "arch 別実測テーブルに無いモデルの 1 イテレーション所要秒",
    isPublic: false,
  },
  // -------------------------------------------------------------------- rates
  credit_to_jpy: {
    value: 1.66,
    label: "クレジット売上単価",
    category: "rates",
    unit: "円/C",
    description: "最安サブスク単価。損益計算・Cost Simulator の売上換算に使用。",
    isPublic: false,
  },
  gpu_jpy_per_hour_b300: {
    value: 1125,
    label: "GPU 時給（B300）",
    category: "rates",
    unit: "円/h",
    description: "LoRA 損切りのクレジット按分秒の分母",
    isPublic: false,
  },
  usd_jpy_rate: {
    value: 150,
    label: "為替レート（USD/JPY）",
    category: "rates",
    unit: "円/$",
    description: "Cost Simulator の Modal 原価（USD 建て）換算レートの既定値",
    isPublic: false,
  },
};

export const DEFAULT_KNOBS: PricingKnobs = Object.fromEntries(
  (Object.entries(KNOB_META) as [KnobKey, KnobMeta][]).map(([k, m]) => [k, m.value]),
) as PricingKnobs;

export const PUBLIC_KNOB_KEYS: KnobKey[] = (Object.entries(KNOB_META) as [KnobKey, KnobMeta][])
  .filter(([, m]) => m.isPublic)
  .map(([k]) => k);

// Merge a partial override map (from the DB or the /api/studio/pricing
// response) onto the hardcoded defaults. Non-finite / missing values fall
// through to the default so a bad row can never zero-out a price.
export function resolveKnobs(overrides?: Partial<Record<string, number>> | null): PricingKnobs {
  const out = { ...DEFAULT_KNOBS };
  if (overrides) {
    for (const key of Object.keys(DEFAULT_KNOBS) as KnobKey[]) {
      const v = overrides[key];
      if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    }
  }
  return out;
}

// Worst-case LoRA credit ceiling — recomputed from the defaults so it tracks
// any change to the seed values (0.1 * 3.0 * 2.0 * 2.0 * 1.2 * 5000 = 7200).
export function loraCreditWorstCase(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  const LORA_MAX_STEPS = 5000;
  return Math.ceil(
    knobs.lora_per_step *
      knobs.lora_mult_model_heavy *
      knobs.lora_mult_res_1280 *
      knobs.lora_mult_batch_4 *
      knobs.lora_mult_rank_64 *
      LORA_MAX_STEPS,
  );
}
