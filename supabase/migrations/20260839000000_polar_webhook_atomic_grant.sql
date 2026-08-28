-- Emergency hardening for the Polar order.paid webhook
-- (src/app/api/webhooks/polar/route.ts).
--
--   1. The prior flow issued three separate writes from the route (the
--      idempotency claim INSERT, the credit RPC, and a tier UPDATE). A
--      failure after the claim left the order recorded as processed but
--      uncredited, and Polar retries then no-opped. grant_polar_order_credits()
--      does the claim + credit grant + tier update in one function / one
--      transaction: all of it commits or none of it does.
--
--   2. This file is idempotent and self-contained so it can be pasted
--      straight into the Supabase SQL Editor where the earlier Polar
--      migrations were never applied (a missing table / function was the
--      actual cause of the webhook 500s).
--
-- Function bodies use the $polar$ dollar-quote tag (not $$) and carry no
-- inline comments, so nothing can prematurely close the body or confuse the
-- PL/pgSQL statement scanner.

-- ---------------------------------------------------------------------------
-- Idempotency ledger for processed Polar orders
-- ---------------------------------------------------------------------------
create table if not exists public.polar_processed_orders (
  order_id text primary key,
  user_id uuid references auth.users(id) on delete set null,
  credits_granted integer not null,
  created_at timestamptz not null default now()
);

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
-- increment_profile_credits: kept for backward compatibility. Adds credits
-- and rolls the 180-day validity window forward.
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
-- grant_polar_order_credits: the single entry point the webhook now calls.
-- Idempotent per order_id; claim + credit grant + optional tier update all
-- happen inside this one function's transaction.
--   p_tier NULL     -> one-time top-up: credits + expiry only
--   p_tier NOT NULL -> subscription: also set subscription_tier and clear
--                      any stale cancel_at_period_end reservation
-- Returns: {"status":"granted","credits":<new balance>}
--       or {"status":"already_processed"}
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
