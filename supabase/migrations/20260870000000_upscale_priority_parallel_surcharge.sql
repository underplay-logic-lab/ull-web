-- 超解像スタジオ: 「実行中でも並列で今すぐ実行」を選んだ場合の追加料金knob。
-- angle_priority_parallel_surcharge（20260869マイグレーション）と同じ設計。
--
-- 概算: upscale_cold_start_grace_s(180s, 実測ベース) × gpu_jpy_per_hour_b300
-- (¥1125/h) ÷ credit_to_jpy(1.66) ≈ 34C（原価） × 3倍markup ≈ 100C。
-- 理論値なので、実際の利用が増えたら admin の Pricing タブで調整すること。

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('upscale_priority_parallel_surcharge', 100, '超解像 並列実行 追加料金', 'feature_credits', 'C', '実行中のジョブを待たず並列で今すぐ実行する場合の追加コールドスタート分の上乗せ。', true)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
