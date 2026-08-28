-- Reconcile a pre-existing public.polar_processed_orders table whose schema
-- predates / diverges from 20260836000000_polar_payments.sql.
--
-- Symptom this fixes:
--   ERROR: 42703: column "credits_granted" of relation
--   "polar_processed_orders" does not exist   (from grant_polar_order_credits)
--
-- `create table if not exists` is a no-op when the table already exists, so
-- it never adds the missing columns. Everything below is additive and
-- re-runnable: no DROP TABLE, no data loss.
--
-- Deliberately avoids anonymous DO blocks and double-quoted identifiers so a
-- paste that mangles straight quotes into smart quotes can't break it
-- (that was the "syntax error at or near Service" on the old policy name).

-- 1. Table + columns ---------------------------------------------------------
create table if not exists public.polar_processed_orders (
  order_id text primary key
);

alter table public.polar_processed_orders add column if not exists order_id        text;
alter table public.polar_processed_orders add column if not exists user_id         uuid;
alter table public.polar_processed_orders add column if not exists credits_granted integer;
alter table public.polar_processed_orders add column if not exists created_at      timestamptz not null default now();

-- 2. Unique index on order_id so `on conflict (order_id)` resolves ----------
create unique index if not exists polar_processed_orders_order_id_key
  on public.polar_processed_orders (order_id);

-- 3. FK user_id -> auth.users (drop-then-add = idempotent) -----------------
alter table public.polar_processed_orders
  drop constraint if exists polar_processed_orders_user_id_fkey;
alter table public.polar_processed_orders
  add constraint polar_processed_orders_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete set null;

-- 4. RLS + service-role policy (unquoted policy name) ----------------------
alter table public.polar_processed_orders enable row level security;

drop policy if exists polar_processed_orders_service_role on public.polar_processed_orders;

create policy polar_processed_orders_service_role
  on public.polar_processed_orders
  for all
  to service_role
  using (true)
  with check (true);

-- 5. Functions (re-assert latest definitions) ------------------------------
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

-- 6. Refresh the PostgREST schema cache -----------------------------------
notify pgrst, 'reload schema';
