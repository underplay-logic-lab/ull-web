-- Polar subscription activation: the four monthly tiers (entry/standard/
-- pro/master) now check out through the same Polar flow as the one-time
-- top-up. See src/lib/polar.ts (POLAR_PRODUCT_CONFIG) and
-- src/app/api/webhooks/polar/route.ts.
--
-- This migration only changes increment_profile_credits: every credit
-- grant (top-up OR subscription first-payment/renewal) must also roll the
-- 180-day validity window forward, the same way the retired Stripe
-- webhook's grantCredits() did. Previously the function bumped `credits`
-- alone, so a purchase's credits could silently lapse on the old
-- credits_expire_at. subscription_tier / cancel_at_period_end are handled
-- by the webhook with plain UPDATEs (single-column writes that don't race
-- with the daily-bonus credit UPDATE), not here.

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
  set credits = credits + p_amount,
      -- Roll the rolling 180-day window forward from now, matching the
      -- "購入日から180日間有効" marketing copy and the daily-bonus route's
      -- own expiry-extension behaviour.
      credits_expire_at = now() + interval '180 days',
      updated_at = now()
  where id = p_user_id
  returning credits into v_new_credits;

  return v_new_credits;
end;
$$;

revoke all on function public.increment_profile_credits(uuid, integer) from public;
grant execute on function public.increment_profile_credits(uuid, integer) to service_role;
