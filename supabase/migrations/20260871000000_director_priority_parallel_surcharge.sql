-- Cinematic Director: 「実行中でも並列で今すぐ実行」を選んだ場合の追加料金knob。
-- angle/upscale の priority_parallel_surcharge と同じ設計（CLAUDE.md §6）。
--
-- 概算: directorPollDeadlineS() の固定オーバーヘッド分（200s, 実測ベース）
-- × gpu_jpy_per_hour_b300(¥1125/h) ÷ credit_to_jpy(1.66) ≈ 38C（原価）
-- × 3倍markup ≈ 115C。理論値なので、実際の利用が増えたら admin の
-- Pricing タブで調整すること。

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('director_priority_parallel_surcharge', 115, 'Cinematic Director 並列実行 追加料金', 'feature_credits', 'C', '実行中のジョブを待たず並列で今すぐ実行する場合の追加コールドスタート分の上乗せ。', true)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
