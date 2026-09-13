-- ULL Cinematic Director: タイムライン型（複数シーン）動画生成。
-- generation_jobs を再利用（新規テーブルは作らない — angle_jobs/upscale_jobs
-- と違い、単発の動画1本という generation_jobs の既存形状にそのまま収まる）。
-- workflow_type に 'director' を追加するだけで、既存の非同期ジョブ報告・
-- 返金・キュー統計・/api/jobs/[id] のポーリングをすべてそのまま使い回せる。

alter table public.generation_jobs
  drop constraint if exists generation_jobs_workflow_type_check;

alter table public.generation_jobs
  add constraint generation_jobs_workflow_type_check
  check (workflow_type in ('cinematic', 'wan', 'custom', 'lora_training', 'director'));

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('director_per_second', 0.6, 'Cinematic Director（秒あたり）', 'feature_credits', 'C/秒', '合計尺1秒あたりの消費クレジット（credits = ceil(これ × 合計秒数)）', true),
  ('director_min_credits', 5, 'Cinematic Director 最低課金', 'feature_credits', 'C', '1本あたりの最低消費クレジット（秒課金の下限）', true)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
