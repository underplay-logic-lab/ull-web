-- 超解像スタジオ: 複数画像バッチ処理。
--
-- - upscale_jobs に batch_id / batch_index / batch_total を追加（すべて
--   nullable — 既存の単発ジョブは null のまま、バッチ機能に無影響）。
--   batch_id で同じバッチの行を束ね、batch_index/batch_total で進捗表示
--   （「3/8 完了」等）ができるようにする。
-- - 新 knob upscale_batch_max_seconds: 1バッチの推定合計処理秒数（コールド
--   スタート猶予は1回分だけ）の上限。超えるバッチは API 側で受け付けない。
--   src/lib/pricing/knobDefaults.ts の KNOB_META と同期。

alter table public.upscale_jobs
  add column if not exists batch_id uuid,
  add column if not exists batch_index integer,
  add column if not exists batch_total integer;

create index if not exists upscale_jobs_batch_id_idx
  on public.upscale_jobs (batch_id)
  where batch_id is not null;

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('upscale_batch_max_seconds', 1800, '超解像 バッチ：合計処理秒数の上限', 'cost_guard', 's',
   '1バッチの推定合計処理秒数がこれを超えたら受け付けない。', false)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
