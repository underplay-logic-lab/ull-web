-- Reconcile a pre-existing public.polar_processed_orders table whose schema
-- predates / diverges from 20260836000000_polar_payments.sql.
--
-- Symptom this fixes:
--   ERROR: 42703: column "credits_granted" of relation
--   "polar_processed_orders" does not exist
--   (raised from inside grant_polar_order_credits()).
--
-- `create table if not exists` is a no-op when the table already exists, so
-- it never adds the missing columns. This migration brings the table up to
-- the shape grant_polar_order_credits() / the webhook expect using only
-- additive, re-runnable statements — no DROP, no data loss.

-- ---------------------------------------------------------------------------
-- 1. Table + columns
-- ---------------------------------------------------------------------------
create table if not exists public.polar_processed_orders (
  order_id text primary key
);

alter table public.polar_processed_orders
  add column if not exists order_id        text;
alter table public.polar_processed_orders
  add column if not exists user_id         uuid;
alter table public.polar_processed_orders
  add column if not exists credits_granted integer not null default 0;
alter table public.polar_processed_orders
  add column if not exists created_at      timestamptz not null default now();

-- credits_granted is always supplied by the function; the default above only
-- exists so the ADD COLUMN succeeds on a table that already has rows. Drop it
-- to match the canonical schema (no-op if there is no default).
alter table public.polar_processed_orders
  alter column credits_granted drop default;

-- ---------------------------------------------------------------------------
-- 2. order_id must be unique for `on conflict (order_id)` to resolve
-- ---------------------------------------------------------------------------
do $reconcile$
begin
  if exists (
    select 1 from pg_attribute
    where attrelid = 'public.polar_processed_orders'::regclass
      and attname = 'order_id'
      and attnotnull = false
  ) then
    delete from public.polar_processed_orders where order_id is null;
    alter table public.polar_processed_orders alter column order_id set not null;
  end if;

  if not exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    where c.relname = 'polar_processed_orders'
      and c.relnamespace = 'public'::regnamespace
      and i.indisunique
      and i.indnatts = 1
      and i.indkey[0] = (
        select attnum from pg_attribute
        where attrelid = c.oid and attname = 'order_id'
      )
  ) then
    alter table public.polar_processed_orders
      add constraint polar_processed_orders_order_id_key unique (order_id);
  end if;
end
$reconcile$;

-- ---------------------------------------------------------------------------
-- 3. Optional FK user_id -> auth.users (guarded; skipped if any FK exists)
-- ---------------------------------------------------------------------------
do $reconcile$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.polar_processed_orders'::regclass
      and contype = 'f'
  ) then
    alter table public.polar_processed_orders
      add constraint polar_processed_orders_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete set null;
  end if;
end
$reconcile$;

-- ---------------------------------------------------------------------------
-- 4. RLS + service-role policy
-- ---------------------------------------------------------------------------
alter table public.polar_processed_orders enable row level security;

drop policy if exists "Service role has full access to polar_processed_orders"
  on public.polar_processed_orders;

create policy "Service role has full access to polar_processed_orders"
  on public.polar_processed_orders
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- 5. Functions (re-assert latest definitions)
-- ---------------------------------------------------------------------------
create or replace function public.increment_profile_credits(p_user_id uuid, p_amount integer)
returns integer
language plpgsql
security definer
set search_path = public
as $polar$
declare
  v_expiry timestamptz;
  v_new_credits integer;
begin
  v_expiry := now() + interval '180 days';

  update public.profiles
     set credits = credits + p_amount,
         credits_expire_at = v_expiry,
         updated_at = now()
   where id = p_user_id
  returning credits into v_new_credits;

  return v_new_credits;
end;
$polar$;

revoke all on function public.increment_profile_credits(uuid, integer) from public;
grant execute on function public.increment_profile_credits(uuid, integer) to service_role;

create or replace function public.grant_polar_order_credits(
  p_order_id text,
  p_user_id uuid,
  p_amount integer,
  p_tier text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $polar$
declare
  v_expiry timestamptz;
  v_claimed integer;
  v_new_credits integer;
begin
  insert into public.polar_processed_orders (order_id, user_id, credits_granted)
  values (p_order_id, p_user_id, p_amount)
  on conflict (order_id) do nothing
  returning 1 into v_claimed;

  if v_claimed is null then
    return jsonb_build_object('status', 'already_processed');
  end if;

  v_expiry := now() + interval '180 days';

  if p_tier is null then
    update public.profiles
       set credits = credits + p_amount,
           credits_expire_at = v_expiry,
           updated_at = now()
     where id = p_user_id
    returning credits into v_new_credits;
  else
    update public.profiles
       set credits = credits + p_amount,
           credits_expire_at = v_expiry,
           subscription_tier = p_tier,
           cancel_at_period_end = false,
           updated_at = now()
     where id = p_user_id
    returning credits into v_new_credits;
  end if;

  if not found then
    raise exception 'grant_polar_order_credits: no profiles row for user % (order %)', p_user_id, p_order_id
      using errcode = 'P0002';
  end if;

  return jsonb_build_object('status', 'granted', 'credits', v_new_credits);
end;
$polar$;

revoke all on function public.grant_polar_order_credits(text, uuid, integer, text) from public;
grant execute on function public.grant_polar_order_credits(text, uuid, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Refresh the PostgREST schema cache so the RPC is callable right away
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
