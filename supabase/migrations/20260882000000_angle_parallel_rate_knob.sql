-- Multi-Angle「今すぐ並列実行」の上乗せを「固定 340C」から「通常料金 × 率 + 固定」へ
-- （2026-09-23、ホスト最終決定: 率 1.0 + 固定 50C）。
--   上乗せ = ceil(通常料金 × angle_priority_parallel_rate) + angle_priority_parallel_surcharge
-- 目的は原価回収ではなく混雑料金（枠の占有時間はジョブの大きさに比例するので率で取る）。
-- 既存の固定分は 340 → 50（コールドスタート実費の markup 分）。
-- コード側の SSOT は src/lib/pricing/knobDefaults.ts。

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('angle_priority_parallel_rate', 1.0, 'Multi-Angle 並列実行 上乗せ率', 'feature_credits', '×', '並列実行時に通常料金へ掛けて上乗せする割合（1.0 = 通常料金と同額を追加 = 合計 2 倍）。固定分と合算。', true)
on conflict (key) do nothing;

update public.pricing_knobs
set value = 50,
    label = 'Multi-Angle 並列実行 固定追加料金',
    description = '並列実行時に 1 ジョブへ一律で足す固定分。率（angle_priority_parallel_rate）と合算。0 で比例分のみ。'
where key = 'angle_priority_parallel_surcharge';
