-- Records per-job generation activity (Wan Animate 2, prompt optimization, etc.)
-- for user-facing history and internal usage stats.
create table if not exists public.generation_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_type text not null,
  prompt_input text,
  prompt_optimized text,
  execution_time_ms integer,
  credits_consumed integer,
  status text not null check (status in ('success', 'failed')),
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists generation_logs_user_id_idx on public.generation_logs (user_id);
create index if not exists generation_logs_created_at_idx on public.generation_logs (created_at desc);

alter table public.generation_logs enable row level security;

-- Users can read only their own log rows.
create policy "generation_logs_select_own"
  on public.generation_logs
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Only the service role (server-side API routes) may insert. The service
-- role's Postgres role already bypasses RLS by default; this policy makes
-- that intent explicit and keeps anon/authenticated writes blocked.
create policy "generation_logs_insert_service_role"
  on public.generation_logs
  for insert
  to service_role
  with check (true);
