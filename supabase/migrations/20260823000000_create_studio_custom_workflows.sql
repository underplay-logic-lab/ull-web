-- Admin-managed registry of "特化ワークフロー" (Custom Workflows): a ComfyUI
-- API-format graph (workflow_json) plus a declarative list of user-facing
-- input parameters (input_schema) that the Studio UI renders dynamically.
-- Unlike studio_presets/studio_pricing, this table IS read directly by
-- anonymous/authenticated clients (RLS policy below) since the public
-- /api/studio/custom-workflows route only needs is_active rows and there is
-- no per-user data involved.
create table if not exists public.studio_custom_workflows (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null,
  description text,
  category text not null default 'image',
  workflow_json jsonb not null,
  input_schema jsonb not null default '[]',
  credits_cost integer not null default 15,
  priority integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists studio_custom_workflows_priority_idx
  on public.studio_custom_workflows (priority desc);

create index if not exists studio_custom_workflows_active_idx
  on public.studio_custom_workflows (is_active)
  where is_active;

alter table public.studio_custom_workflows enable row level security;

-- Public, read-only: only active rows, to anon and authenticated alike.
-- workflow_json is still present on these rows but the public API route
-- (src/app/api/studio/custom-workflows/route.ts) never selects that column.
create policy "Public can read active custom workflows"
  on public.studio_custom_workflows
  for select
  to anon, authenticated
  using (is_active = true);

-- The service-role client (supabaseAdmin, used by every /api/admin/* route)
-- bypasses RLS entirely already; this policy just makes the intended access
-- model explicit rather than relying on that bypass alone.
create policy "Service role has full access to custom workflows"
  on public.studio_custom_workflows
  for all
  to service_role
  using (true)
  with check (true);
