-- 実稼働ログの Modal 原価集計（/api/admin/logs の「Modal累計推定原価」カード）
-- が常に $0 になっていた問題を修正する。
--
-- 原因: /api/admin/logs は generation_logs.job_type と studio_pricing.key を
-- 突き合わせて unit_cost_usd（$/秒）を引き、execution_time_ms 秒数に掛けて
-- Modal 累計推定原価を算出するが、20260871000000 のトリガーが書き込む
-- job_type（multi_angle / upscale_image / upscale_video / lora_training /
-- director）に対応する studio_pricing の行が一つも無かった。
--
-- 単価は Modal の B300 課金レートそのもの（pricing_knobs の
-- gpu_jpy_per_hour_b300 = ¥1125/h、usd_jpy_rate = ¥150/$ から算出:
-- $7.50/h ÷ 3600 秒 = $0.002083/秒）を採用する。CLAUDE.md §1 の通り
-- Multi-Angle / 超解像(SeedVR2) / LoRA / Director はいずれも本番は
-- Blackwell(B300) 専用ワーカーであり、GPU 稼働 1 秒あたりの原価はどの機能
-- でも共通（B300 の課金レートそのものなので、機能ごとの実機ベンチマークを
-- 待たずに確定できる値）。
--
-- credits 列（1回あたりの固定クレジット、wan_animate 系向けの設計）は
-- 今回の4機能には当てはまらない（すべて構図数/MP数/フレーム数/ステップ数
-- 連動の動的課金 — CLAUDE.md §3）ため 0 のまま参考値なしとする。実際の
-- 消費クレジットは generation_logs.credits_consumed に生成時点の値が
-- そのまま記録される。

insert into public.studio_pricing (key, label, credits, unit_cost_usd, description)
values
  ('multi_angle',   'Multi-Angle Studio（構図生成）', 0, 0.002083, 'B300 GPU秒単価（¥1125/h ÷ ¥150/$ ÷ 3600s）。動的課金のため credits は参考値なし。'),
  ('upscale_image', '超解像スタジオ（画像）',         0, 0.002083, 'B300 GPU秒単価（同上）。動的課金のため credits は参考値なし。'),
  ('upscale_video', '超解像スタジオ（動画）',         0, 0.002083, 'B300 GPU秒単価（同上）。動的課金のため credits は参考値なし。'),
  ('lora_training', 'LoRA Studio（学習）',            0, 0.002083, 'B300 GPU秒単価（同上）。動的課金のため credits は参考値なし。'),
  ('director',      'Cinematic Director（動画生成）', 0, 0.002083, 'B300 GPU秒単価（同上）。動的課金のため credits は参考値なし。')
on conflict (key) do update
  set label = excluded.label,
      unit_cost_usd = excluded.unit_cost_usd,
      description = excluded.description,
      updated_at = now();
