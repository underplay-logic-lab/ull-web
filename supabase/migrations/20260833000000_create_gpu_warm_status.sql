-- Global (single-row) GPU "warm" countdown for the 🔥 火入れ (stoke-the-fire)
-- system: an authenticated user spends 1 credit to push this timestamp
-- further into the future via extend_gpu_warm(), and the Studio UI
-- (GpuWarmBadge.tsx) shows a live countdown against it via Realtime. This
-- table only tracks/displays the shared "warm until" value — whether it's
-- wired up to actually keep a Modal container warm is a separate concern.
create table if not exists public.gpu_warm_status (
  id smallint primary key default 1,
  warm_until timestamptz not null default now(),
  last_extended_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint gpu_warm_status_singleton check (id = 1)
);

insert into public.gpu_warm_status (id, warm_until)
values (1, now())
on conflict (id) do nothing;

alter table public.gpu_warm_status enable row level security;

-- Readable by anyone, including signed-out visitors — this is one shared
-- public value (not per-user data), and the Studio badge shows it before
-- login. Only the service role (via extend_gpu_warm() below, called from
-- /api/gpu/warm-extend) can change it.
create policy "gpu_warm_status_select_all"
  on public.gpu_warm_status
  for select
  to anon, authenticated
  using (true);

create policy "gpu_warm_status_service_role_all"
  on public.gpu_warm_status
  for all
  to service_role
  using (true)
  with check (true);

-- Lets the Studio badge's countdown update live for every viewer the
-- instant anyone extends it, the same way useProfileCredits subscribes to
-- profiles — Realtime only broadcasts changes for tables added to this
-- publication.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'gpu_warm_status'
  ) then
    alter publication supabase_realtime add table public.gpu_warm_status;
  end if;
end $$;

-- Atomically extends warm_until by p_seconds from whichever is later, "now"
-- or the current warm_until (stacks on top of remaining warmth rather than
-- resetting it) — a single UPDATE...RETURNING inside this function rather
-- than a read-then-write from the API route, so concurrent "🔥 火をくべる"
-- clicks from different users can never race and drop an extension.
create or replace function public.extend_gpu_warm(p_user_id uuid, p_seconds integer default 60)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_warm_until timestamptz;
begin
  update public.gpu_warm_status
  set warm_until = greatest(warm_until, now()) + make_interval(secs => p_seconds),
      last_extended_by = p_user_id,
      updated_at = now()
  where id = 1
  returning warm_until into v_new_warm_until;

  return v_new_warm_until;
end;
$$;

revoke all on function public.extend_gpu_warm(uuid, integer) from public;
grant execute on function public.extend_gpu_warm(uuid, integer) to service_role;
