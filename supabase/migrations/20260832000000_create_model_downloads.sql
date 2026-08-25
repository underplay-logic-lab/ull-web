-- Tracks async remote-model downloads spawned from the admin Storage tab's
-- "⚡ Modalへ直接ダウンロード" button (see ModalStorageTab.tsx /
-- download_model_async in scripts/modal_wan_animate.py). The POST that
-- kicks off a download now returns immediately after inserting a 'pending'
-- row here and spawning the Modal function; the row is then updated
-- in-place (status/progress_percent) as the download streams, so the admin
-- UI's "📥 ダウンロードタスク一覧" panel can poll this table instead of
-- blocking on the original multi-GB request/response cycle.
create table if not exists public.model_downloads (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  save_path text not null,
  status text not null default 'pending' check (status in ('pending', 'downloading', 'completed', 'failed')),
  progress_percent smallint not null default 0 check (progress_percent between 0 and 100),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists model_downloads_created_at_idx on public.model_downloads (created_at desc);

alter table public.model_downloads enable row level security;

-- No policies for anon/authenticated: only the service role (admin API
-- routes under /api/admin, and the Modal ModalStorage backend using the
-- same service-role key to report progress) may read or write this table.
