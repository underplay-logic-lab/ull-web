-- Adds Standard/ULTRA GPU tier support to Wan Animate 2: a per-log tier
-- column, an admin-editable credit surcharge for the ULTRA tier, and a
-- lightweight table tracking in-flight generations so the admin "GPU task
-- manager" can show accurate running-job counts per tier (see
-- src/app/api/admin/modal/logs/route.ts).

alter table public.generation_logs
  add column if not exists gpu_tier text not null default 'standard';

insert into public.studio_pricing (key, label, credits, unit_cost_usd, description)
values
  (
    'wan_animate_gpu_ultra_addon',
    'ULTRA GPU (B300) 追加料金',
    40,
    0.0025,
    'Standardティアの基本料金に追加加算されるULTRA GPU利用料'
  )
on conflict (key) do nothing;

create table if not exists public.active_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_type text not null,
  gpu_tier text not null,
  started_at timestamptz not null default now()
);

create index if not exists active_generation_jobs_gpu_tier_idx
  on public.active_generation_jobs (gpu_tier);

alter table public.active_generation_jobs enable row level security;

-- Only the service role (server-side API routes) reads/writes this table —
-- same posture as generation_logs.
create policy "active_generation_jobs_service_role_all"
  on public.active_generation_jobs
  for all
  to service_role
  using (true)
  with check (true);
