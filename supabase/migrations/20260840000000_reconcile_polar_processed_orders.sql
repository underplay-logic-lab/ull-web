-- Reconcile the pre-existing (diverged) public.polar_processed_orders table
-- and re-assert the Polar credit-grant functions.
--
-- The table already existed in this project's database from an early draft
-- with a different, incompatible shape (a synthetic `id` PK, a NOT NULL
-- `credits_added` column, and more), so `create table if not exists` never
-- corrected it and grant_polar_order_credits() failed at runtime — first
-- 42703 (credits_granted missing), then 23502 (credits_added NOT NULL).
--
-- This file reflects exactly what was applied to production by hand via the
-- Supabase SQL Editor on 2026-08-28, verified working (order.paid redelivery
-- returned 200 and credited the buyer). It deliberately contains no
-- anonymous DO blocks and no double-quoted identifiers: a paste that mangled
-- straight quotes into smart quotes kept breaking the SQL Editor run.
--
-- The table holds only the Polar-order idempotency ledger and had no real
-- data (Polar had not gone live), so it is dropped and recreated cleanly.
-- CASCADE does not drop the functions below — a PL/pgSQL body that queries a
-- table by name is not a tracked dependency.

drop table if exists public.polar_processed_orders cascade;

create table public.polar_processed_orders (
  order_id        text primary key,
  user_id         uuid,
  credits_granted integer not null,
  created_at      timestamptz not null default now()
);

alter table public.polar_processed_orders enable row level security;

create policy polar_processed_orders_svc
  on public.polar_processed_orders
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- increment_profile_credits: adds credits and rolls the 180-day validity
-- window forward. Kept for backward compatibility; the webhook itself now
-- calls grant_polar_order_credits().
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

-- ---------------------------------------------------------------------------
-- grant_polar_order_credits: single entry point for the order.paid webhook.
-- Idempotency claim (on order_id) + credit grant + 180-day expiry roll-
-- forward + optional subscription_tier update, all in one transaction.
--   p_tier NULL     -> one-time top-up: credits + expiry only
--   p_tier NOT NULL -> subscription: also set subscription_tier and clear
--                      any stale cancel_at_period_end reservation
-- Returns {"status":"granted","credits":<new balance>}
--      or {"status":"already_processed"}
-- ---------------------------------------------------------------------------
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
