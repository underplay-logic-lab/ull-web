-- LoRA 学習の課金方式を「係数の掛け算」から「推定GPU秒 × クレジット単価」へ
-- 移行する（2026-09-20）。
--
-- 旧式: ceil(lora_per_step × モデル係数 × 解像度係数 × バッチ係数 × rank係数 × steps)
-- 新式: ceil( (prep_load + prep_per_image×枚数 + steps × s/it × 解像度 × バッチ)
--             × credits_per_gpu_second )
--
-- 移行の理由:
--  (a) 学習設定を変えるたびに係数を人手で校正し直す必要があり、「設定が
--      固まらないと価格を決められない」という手詰まりになっていた。新式は
--      設定が変われば推定秒が動くので価格が自動追従する。
--  (b) arch 間の実原価差（最大16倍）を モデル係数 1.0 / 3.0 の2段では表現
--      できず、SDXL 以外のほぼ全 arch が原価割れしていた。
--  (c) データセット枚数に比例する準備時間（latent キャッシュ）を一切課金
--      できておらず、step 数の小さいジョブほど赤字が深くなっていた。
--
-- 式の実体・arch 別 s/it テーブルは src/lib/pricing/loraRuntime.ts。課金
-- （loraPricing.ts）と損切り（pricing/costGuard.server.ts）が同じ関数を呼ぶ
-- ようになったので、CLAUDE.md §3 の「課金式を変えたら cost-guard への影響を
-- 必ず確認」という事故クラスは構造的に解消されている。
--
-- ⚠️ 単価（credits_per_gpu_second）は「原価ベース」ではなく「移行時点の価格を
-- おおむね据え置く」値にしてある。原価ベース（実測 s/it・現行 GPU tier・
-- 3倍markup・credit_to_jpy 1.66）なら ai-toolkit 0.565 / sd-scripts 0.147。
-- つまり現状は原価の約1.4倍でしか課金できていない。GPU tier の実機比較
-- （Stage 1）で s/it と tier を確定させてから、この2つの数字を上げて着地
-- させること。

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('lora_credits_per_gpu_second',      0.08, 'LoRA クレジット単価（ai-toolkit）',      'lora_formula', 'C/GPU秒', '推定GPU秒に掛けて消費クレジットを出す単価。ai-toolkit ワーカーで回る全 arch（SDXL以外）。', true),
  ('lora_credits_per_gpu_second_sdxl', 0.07, 'LoRA クレジット単価（sd-scripts / SDXL）', 'lora_formula', 'C/GPU秒', '同上。SDXL系（illustrious / juggernaut）は sd-scripts ワーカーで回るため別単価。',            true),
  ('lora_prep_load_s',                 300,  'LoRA 準備時間（固定分）',                'lora_formula', 's',       'コンテナ起動 + モデルロードの固定オーバーヘッド（枚数に依らない）。⚠️未実測の暫定値。',      true),
  ('lora_prep_per_image_s',            20,   'LoRA 準備時間（1枚あたり）',             'lora_formula', 's/枚',    'latent キャッシュ等、データセット枚数に比例する準備時間。⚠️未実測の暫定値。',                true),
  ('lora_res_scale_exponent',          1.0,  'LoRA 解像度スケール指数',                'lora_formula', '×',       's/it = 基準値 × (解像度²/1024²)^これ。1.0 で画素数に正比例。⚠️未実測の暫定値。',            true)
on conflict (key) do nothing;

-- 未知 arch の s/it は損切り専用だったが、新式では課金そのものの入力になり
-- クライアント（見積り表示）にも渡す必要があるため公開＋カテゴリ移動。
update public.pricing_knobs
set category = 'lora_formula',
    label = 'LoRA 未知 arch の s/it',
    description = 'loraRuntime.ts の arch 別実測テーブルに無いモデルの 1 イテレーション所要秒',
    is_public = true,
    updated_at = now()
where key = 'lora_spi_baseline_default';

-- 旧「係数の掛け算」方式の残骸。行は残置（admin の表示から消すと DB との
-- 対応が崩れるため）し、非公開＋ラベルで廃止と分かるようにする。
update public.pricing_knobs
set label = label || '（廃止・未使用）',
    description = '（廃止）2026-09-20 に推定GPU秒ベースへ移行。src/lib/pricing/loraRuntime.ts 参照。',
    is_public = false,
    updated_at = now()
where key in (
  'lora_per_step',
  'lora_mult_model_heavy',
  'lora_mult_res_1024',
  'lora_mult_res_1280',
  'lora_mult_batch_2',
  'lora_mult_batch_4',
  'lora_mult_rank_64'
)
and label not like '%（廃止・未使用）';
