-- ULL Multi-Angle Studio: async job queue.
--
-- The angle generate route used to relay the whole Modal call synchronously
-- (up to several minutes for a Pro batch), which Vercel's 300s function cap
-- and any browser navigation could sever mid-flight. It now inserts a
-- 'pending' row here, .spawn()s the Modal worker and returns this row's id
-- immediately; the browser polls angle_jobs directly (owner RLS) for
-- completed_angles / images. modal_angle_worker.py PATCHes this row (and
-- calls append_angle_result) straight through Supabase's REST API with the
-- service-role key as each angle finishes — no Next.js request is alive by
-- then. Mirrors generation_jobs (LoRA training) exactly.

create table if not exists public.angle_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  mode text not null default 'turbo' check (mode in ('turbo', 'pro')),
  total_angles integer not null default 0,
  completed_angles integer not null default 0,
  -- Ordered array of public Storage URLs (angle-results bucket), generation
  -- order. Parallel to `labels` (日本語 construction labels set at creation).
  images jsonb not null default '[]'::jsonb,
  labels jsonb not null default '[]'::jsonb,
  -- Credits already debited when the job was created — needed so a failure
  -- detected Modal-side (long after the debiting request returned) refunds
  -- the exact amount without re-deriving it.
  credits_cost integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists angle_jobs_user_id_idx
  on public.angle_jobs (user_id, created_at desc);

-- Bump updated_at on every UPDATE (the worker also sets it explicitly, this
-- is a backstop).
create or replace function public.touch_angle_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists angle_jobs_touch_updated_at on public.angle_jobs;
create trigger angle_jobs_touch_updated_at
  before update on public.angle_jobs
  for each row execute function public.touch_angle_jobs_updated_at();

alter table public.angle_jobs enable row level security;

-- Owners poll their own job.
drop policy if exists "Users can read their own angle jobs" on public.angle_jobs;
create policy "Users can read their own angle jobs"
  on public.angle_jobs
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Every write is service-role: the generate route on creation, and
-- modal_angle_worker.py directly (REST, service-role key) as angles finish.
drop policy if exists "Service role has full access to angle jobs" on public.angle_jobs;
create policy "Service role has full access to angle jobs"
  on public.angle_jobs
  for all
  to service_role
  using (true)
  with check (true);

-- Atomic "one angle finished": append its URL, bump the counter, and lift
-- 'pending' -> 'processing' on the first one. No-ops once the job is
-- completed / failed (e.g. a late retry).
create or replace function public.append_angle_result(
  p_job_id uuid,
  p_image_url text,
  p_label text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.angle_jobs
     set images = images || to_jsonb(p_image_url),
         completed_angles = completed_angles + 1,
         status = case when status = 'pending' then 'processing' else status end,
         updated_at = now()
   where id = p_job_id
     and status in ('pending', 'processing');
$$;

revoke all on function public.append_angle_result(uuid, text, text) from public;
grant execute on function public.append_angle_result(uuid, text, text) to service_role;

-- Public bucket for finished angle images. Only the Modal worker writes here
-- (service role, bypasses RLS); the browser just reads the public URLs the
-- job row hands it. Same 14-day content lifecycle as other generated media.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'angle-results',
  'angle-results',
  true,
  10485760, -- 10 MB per image
  array['image/png', 'image/webp', 'image/jpeg']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

notify pgrst, 'reload schema';
