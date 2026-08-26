-- Backing infrastructure for the Polar.sh (Merchant of Record) checkout —
-- see src/app/api/checkout/polar/route.ts and
-- src/app/api/webhooks/polar/route.ts. Stripe's checkout/webhook/portal
-- routes are being retired in favor of this.

-- Idempotency guard for the webhook: Polar (like most webhook providers)
-- can and will redeliver the same event on a retry (a slow response, a
-- transient 5xx, etc.). The webhook handler INSERTs the order id here
-- before crediting anything; a unique-violation on a duplicate delivery
-- means "already processed" and it skips crediting again rather than
-- double-granting credits for one purchase.
create table if not exists public.polar_processed_orders (
  order_id text primary key,
  user_id uuid references auth.users(id) on delete set null,
  credits_granted integer not null,
  created_at timestamptz not null default now()
);

alter table public.polar_processed_orders enable row level security;

create policy "Service role has full access to polar_processed_orders"
  on public.polar_processed_orders
  for all
  to service_role
  using (true)
  with check (true);

-- Atomically credits a profile — a single UPDATE...RETURNING inside this
-- function rather than the webhook route reading profiles.credits and
-- writing back a computed sum, so a webhook-granted credit can never race
-- with (and silently clobber) a concurrent daily-bonus credit or another
-- purchase. Mirrors extend_gpu_warm()'s same rationale in
-- supabase/migrations/20260833000000_create_gpu_warm_status.sql.
create or replace function public.increment_profile_credits(p_user_id uuid, p_amount integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_credits integer;
begin
  update public.profiles
  set credits = credits + p_amount
  where id = p_user_id
  returning credits into v_new_credits;

  return v_new_credits;
end;
$$;

revoke all on function public.increment_profile_credits(uuid, integer) from public;
grant execute on function public.increment_profile_credits(uuid, integer) to service_role;
