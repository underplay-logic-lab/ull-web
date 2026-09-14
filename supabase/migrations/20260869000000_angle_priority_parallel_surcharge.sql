-- Multi-Angle Studio: 「実行中でも並列で今すぐ実行」を選んだ場合の追加料金knob。
--
-- 既定（無料）の「順番待ち」は、実行中のジョブが完了して温かいコンテナが
-- 空くのを待ってから自動的に次を発火する（コールドスタート追加コストなし）。
-- 「並列実行」を選ぶと、待たずに新しいコンテナのコールドスタートを1回追加で
-- 発生させるため、その原価を上乗せする。
--
-- 概算: angle_cold_start_grace_s(600s, 実測ベース) × gpu_jpy_per_hour_b300
-- (¥1125/h) ÷ credit_to_jpy(1.66) ≈ 113C（原価） × 3倍markup(director系の
-- 導出と同じ慣例) ≈ 340C。実測ではなく理論値なので、実際の利用が増えたら
-- admin の Pricing タブで調整すること。

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('angle_priority_parallel_surcharge', 340, 'Multi-Angle 並列実行 追加料金', 'feature_credits', 'C', '実行中のジョブを待たず並列で今すぐ実行する場合の追加コールドスタート分の上乗せ。', true)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
