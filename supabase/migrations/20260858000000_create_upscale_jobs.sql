-- 超解像スタジオ（SeedVR2）: 非同期ジョブキュー。
--
-- angle_jobs / generation_jobs と同じ構造。/api/studio/upscale/generate が
-- 'pending' 行を insert → クレジット引き落とし → modal_seedvr2_worker.py の
-- upscale_dispatch を叩いて即 return。ブラウザは upscale_jobs を owner RLS で
-- 直接ポーリング。worker が完了時に status / result_url / metadata を
-- Supabase REST（service-role）で直接 PATCH する（Next のリクエストは
-- その頃には生きていない）。
--
-- 1 ジョブ = 1 枚（v1 は画像のみ・動画は別 PR）。

create table if not exists public.upscale_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  -- 使用したアップスケーラー（upscaleStudio.ts の UPSCALER_REGISTRY のキー）。
  model_key text not null default 'seedvr2_7b',
  -- 解像度プリセット id（'hd' | '2k' | 'qhd' …）。デバッグ / 表示用。
  preset text not null default '2k',
  -- 完成画像の公開 Storage URL（upscale-results バケット）。未完なら null。
  result_url text,
  -- 引き落とし済みクレジット（Modal 側で検知した失敗の返金に使う）。
  credits_cost integer not null default 0,
  -- worker が書く: vram_used_gb / vram_peak_gb / elapsed_time / out_width /
  -- out_height / model_key / preset など。
  metadata jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists upscale_jobs_user_id_idx
  on public.upscale_jobs (user_id, created_at desc);

create or replace function public.touch_upscale_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists upscale_jobs_touch_updated_at on public.upscale_jobs;
create trigger upscale_jobs_touch_updated_at
  before update on public.upscale_jobs
  for each row execute function public.touch_upscale_jobs_updated_at();

alter table public.upscale_jobs enable row level security;

-- Owners poll their own job.
drop policy if exists "Users can read their own upscale jobs" on public.upscale_jobs;
create policy "Users can read their own upscale jobs"
  on public.upscale_jobs
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Every write is service-role (the generate route on creation, the Modal
-- worker directly as the job finishes).
drop policy if exists "Service role has full access to upscale jobs" on public.upscale_jobs;
create policy "Service role has full access to upscale jobs"
  on public.upscale_jobs
  for all
  to service_role
  using (true)
  with check (true);

-- Public bucket for finished upscaled images. Only the Modal worker writes
-- here (service role, bypasses RLS); the browser reads the public URL the job
-- row hands it. Same 14-day content lifecycle as other generated media.
-- 50 MB/image: a QHD portrait PNG (~9MP) can reach ~30 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'upscale-results',
  'upscale-results',
  true,
  52428800,
  array['image/png', 'image/webp', 'image/jpeg']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 超解像スタジオの pricing_knobs（src/lib/pricing/knobDefaults.ts の KNOB_META
-- と同期）。
insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('upscale_per_mp',              3,   '超解像（100万画素あたり）',        'feature_credits', 'C/MP', '出力の100万画素あたりの消費クレジット（× モデル係数）',            true),
  ('upscale_min_credits',         8,   '超解像 最低クレジット',            'feature_credits', 'C',    '1枚あたりの消費クレジット下限（コールドスタート償却）',            true),
  ('upscale_time_per_credit_s',   4,   '超解像 損切り：1C あたり猶予秒',   'cost_guard',      's/C',  'max_allowed_time = 消費C × これ + コールドスタート猶予',           false),
  ('upscale_cold_start_grace_s',  180, '超解像 損切り：コールドスタート猶予', 'cost_guard',   's',    'ComfyUI 起動 + SeedVR2 重みロード + 初回 forward の固定猶予',      false)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
