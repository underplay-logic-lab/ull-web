-- Admin-managed inventory of Studio motion/style presets (title, category,
-- reference video, thumbnail, display order, active flag). Managed from
-- /admin; not yet wired into the public Studio UI, which still reads its
-- preset list from src/lib/data.ts.
create table if not exists public.studio_presets (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null,
  video_url text not null,
  thumbnail_url text,
  priority integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists studio_presets_priority_idx on public.studio_presets (priority desc);

alter table public.studio_presets enable row level security;

-- No policies for anon/authenticated: only the service role (admin API
-- routes under /api/admin) may read or write this table.
