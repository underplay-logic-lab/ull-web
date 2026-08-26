-- Async job-queue backing for long-running GPU generations. The Cinematic
-- Video (MiniMax H3) generate route used to block the whole HTTP request on
-- the Modal call until the render finished (up to ~10 minutes), which is
-- liable to get cut off by Cloudflare/Vercel's ~100s edge timeout on long
-- renders or under concurrent load. The generate route now inserts a
-- 'queued' row here and returns its id immediately; the frontend polls
-- GET /api/jobs/[id] instead. modal_wan_animate_blackwell.py's spawned
-- worker PATCHes this row directly via Supabase's REST API (same
-- service-role-credential pattern model_downloads already uses for
-- download progress) once it actually finishes, success or failure — there
-- is no Next.js request left alive to do that update from by then.
create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  workflow_type text not null check (workflow_type in ('cinematic', 'wan', 'custom')),
  inputs jsonb not null default '{}',
  -- Credits already debited for this job when it was created — needed so a
  -- failure (detected Modal-side, well after the debiting request has
  -- returned) can refund the exact right amount without re-deriving it from
  -- `inputs`.
  credits_cost integer not null default 0,
  video_url text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists generation_jobs_user_id_idx on public.generation_jobs (user_id, created_at desc);

alter table public.generation_jobs enable row level security;

-- Owners can read their own job while polling for its status.
create policy "Users can read their own generation jobs"
  on public.generation_jobs
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Every write goes through the service-role client: the generate route on
-- creation, and modal_wan_animate_blackwell.py directly (via REST, using
-- the same credentials model_downloads' Modal functions already have) once
-- the spawned job actually finishes.
create policy "Service role has full access to generation jobs"
  on public.generation_jobs
  for all
  to service_role
  using (true)
  with check (true);
