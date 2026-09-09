-- Admin-editable pricing / cost-guard knobs — one numeric value per key.
--
-- Replaces the hardcoded credit prices, LoRA formula coefficients and cost-
-- guard thresholds that were scattered across src/lib/loraPricing.ts,
-- src/lib/angleStudio.ts, src/lib/cinematicPricing.ts, the /api/generate*
-- routes and modal_lora_worker.py. The Next API reads these at request time
-- (src/lib/pricing/knobs.server.ts), computes the cost-guard seconds and
-- passes them to the Modal workers via the job payload, so a price change in
-- /admin's Pricing tab takes effect without a redeploy.
--
-- DEFAULT_KNOBS in src/lib/pricing/knobDefaults.ts is the code-side fallback
-- and MUST stay in sync with the seed values below.
--
-- The existing studio_pricing table (Wan Animate) is left untouched.

create table if not exists public.pricing_knobs (
  key         text primary key,
  value       numeric not null,
  label       text not null,
  category    text not null,   -- 'feature_credits' | 'lora_formula' | 'cost_guard' | 'rates'
  unit        text,
  description text,
  is_public   boolean not null default false,
  updated_at  timestamptz not null default now()
);

alter table public.pricing_knobs enable row level security;

-- No anon/authenticated policies: only the service role (API routes under
-- /api/admin and the server-only pricing lib) may read or write this table.
-- Public knobs reach the browser through /api/studio/pricing, not RLS.

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('image_generate',            1,     '画像生成',                       'feature_credits', 'C',       '1枚あたりの消費クレジット（/api/generate）',                     true),
  ('angle_turbo_per_angle',     1,     'Multi-Angle 🚀 Turbo',           'feature_credits', 'C/構図',  '1構図あたりの消費クレジット（8ステップ）',                       true),
  ('angle_pro_per_angle',       2,     'Multi-Angle 💎 Pro',             'feature_credits', 'C/構図',  '1構図あたりの消費クレジット（40ステップ）',                      true),
  ('cinematic_speed',           1,     'Cinematic Speed Mode',           'feature_credits', 'C',       '1本あたりの消費クレジット（4ステップ / 512px）',                 true),
  ('cinematic_standard',        2,     'Cinematic Standard Mode',        'feature_credits', 'C',       '1本あたりの消費クレジット（4ステップ / 768px）',                 true),
  ('cinematic_cinema_master',   5,     'Cinematic Cinema Master',        'feature_credits', 'C',       '1本あたりの消費クレジット（20ステップ / 1024px）',               true),
  ('lora_per_step',             0.1,   'LoRA 基本単価',                  'lora_formula',    'C/step',  'ceil(単価 × 各係数 × steps) の基本単価',                         true),
  ('lora_mult_model_heavy',     3.0,   'LoRA モデル係数（動画系）',      'lora_formula',    '×',       'minimax_h3 / wan21 / hunyuan など動画 DiT の倍率。それ以外 1.0。', true),
  ('lora_mult_res_1024',        1.5,   'LoRA 解像度係数（≥1024px）',     'lora_formula',    '×',       'データセット最大解像度が 1024〜1279px のときの倍率',             true),
  ('lora_mult_res_1280',        2.0,   'LoRA 解像度係数（≥1280px）',     'lora_formula',    '×',       'データセット最大解像度が 1280px 以上のときの倍率',               true),
  ('lora_mult_batch_2',         1.5,   'LoRA バッチ係数（実効≥2）',      'lora_formula',    '×',       'batch_size × grad_accum が 2〜3 のときの倍率',                   true),
  ('lora_mult_batch_4',         2.0,   'LoRA バッチ係数（実効≥4）',      'lora_formula',    '×',       'batch_size × grad_accum が 4 以上のときの倍率',                  true),
  ('lora_mult_rank_64',         1.2,   'LoRA Rank 係数（≥64）',          'lora_formula',    '×',       'network.linear（LoRA dim）が 64 以上のときの倍率',               true),
  ('angle_time_per_credit_s',   10,    'Angle 損切り：1C あたり猶予秒',  'cost_guard',      's/C',     'max_allowed_time = 消費C × これ + コールドスタート猶予',         false),
  ('angle_cold_start_grace_s',  300,   'Angle 損切り：コールドスタート猶予', 'cost_guard',  's',       'コンテナ起動 + torch.compile ウォームアップの固定猶予',          false),
  ('lora_cost_guard_multiplier', 1.4,  'LoRA 損切り：余裕倍率',          'cost_guard',      '×',       'クレジット按分秒 × これ = 予測壁時計の停止閾値。1.0 で厳格。',   false),
  ('lora_margin_target',        0.7,   'LoRA 損切り：粗利ターゲット',    'cost_guard',      '率',      '0.7 = GPU 原価を売上の 70% までに抑える（粗利 30%）',            false),
  ('lora_floor_prep_s',         2700,  'LoRA 損切り：prep 下駄秒',       'cost_guard',      's',       '純学習時間に加算する latent キャッシュ / チェックポイント余裕',  false),
  ('lora_safety_limit_s',       18000, 'LoRA 損切り：0C ジョブ上限',     'cost_guard',      's',       'クレジット 0（生 YAML パース不能）ジョブの絶対上限秒',           false),
  ('lora_spi_baseline_default', 2.5,   'LoRA 損切り：未知 arch の s/it', 'cost_guard',      's/it',    'arch 別実測テーブルに無いモデルの 1 イテレーション所要秒',       false),
  ('credit_to_jpy',             1.66,  'クレジット売上単価',            'rates',           '円/C',    '最安サブスク単価。損益計算・Cost Simulator の売上換算に使用。',  false),
  ('gpu_jpy_per_hour_b300',     1125,  'GPU 時給（B300）',              'rates',           '円/h',    'LoRA 損切りのクレジット按分秒の分母',                            false),
  ('usd_jpy_rate',              150,   '為替レート（USD/JPY）',         'rates',           '円/$',    'Cost Simulator の Modal 原価（USD 建て）換算レートの既定値',     false)
on conflict (key) do nothing;
