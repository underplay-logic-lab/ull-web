-- Baseline schema for public.profiles, written retroactively.
--
-- This table predates this repo's supabase/migrations/ convention and was
-- never captured as a migration — it (and its streak/credit columns) exist
-- in production but nowhere in version control. This file exists so the
-- schema is finally tracked in Git, not to be run against a database that
-- already has the table (CREATE TABLE IF NOT EXISTS is a no-op there; see
-- the policy handling below for why the RLS section is still safe to run).
--
-- Column list, types, defaults, and NOT NULL constraints below were read
-- directly off production via PostgREST's OpenAPI schema
-- (GET {SUPABASE_URL}/rest/v1/ with the service-role key), not guessed.
-- The auth.users foreign key on `id` is NOT independently verified against
-- production (no Postgres/Management-API access was available to inspect
-- actual constraint definitions) — it's the standard Supabase pattern every
-- other table in this repo uses, applied here on the same assumption.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  credits integer not null default 10,
  credits_expire_at timestamptz default (now() + interval '180 days'),
  subscription_tier text not null default 'free',
  cancel_at_period_end boolean not null default false,
  streak_count integer not null default 0,
  last_login_bonus_at date,
  stripe_customer_id text,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

alter table public.profiles enable row level security;

-- RLS policy bodies are NOT directly readable via PostgREST or the anon/
-- service-role REST API — there is no pg_policies access without a direct
-- Postgres connection or Supabase Management API token, neither available
-- here. The two policies below are reconstructed from *observed behavior*
-- and actual call-site usage, not read off production directly:
--   - An anon-key, unauthenticated select against /rest/v1/profiles
--     returned 200 with an empty array (not a permission error) against a
--     table known to have rows — consistent with RLS being enabled and
--     scoping rows to auth.uid().
--   - Every client-side read goes through the browser's authenticated
--     Supabase client scoped to the caller's own id (see
--     src/hooks/useProfileCredits.ts, `.eq("id", user.id)`, plus a realtime
--     postgres_changes subscription filtered the same way).
--   - Every write (insert/update) in the codebase goes through
--     supabaseAdmin (the service-role client) — src/lib/profile.ts,
--     src/app/api/daily-bonus/route.ts, src/app/api/generate/cinematic/route.ts,
--     etc. No client-side insert/update against profiles exists anywhere
--     in src/.
-- If production's actual policies differ from this, this file will not
-- match — treat it as a best-effort baseline to build future migrations
-- on top of, not a verified export.
drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

drop policy if exists "Service role has full access to profiles" on public.profiles;
create policy "Service role has full access to profiles"
  on public.profiles
  for all
  to service_role
  using (true)
  with check (true);
