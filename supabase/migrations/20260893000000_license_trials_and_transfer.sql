-- 2026-09-30: 納品ツールのライセンスに「試用」と「自分で移し替え」を足す（ホスト判断: オンライン専用・試用 7 日・移し替えは 30 日に 1 回）。
--
-- license_trials            … キー無しの試用。ツール × PC（HWID）ごとに 1 回だけ。期限はサーバーの時刻で判定する。
-- licenses.last_transfer_at … 最後に自分で PC を移し替えた時刻（30 日に 1 回の制限に使う）。
-- 読み書きは Next の API（service_role）だけ。仕組みは src/lib/license/license.server.ts。

create table if not exists public.license_trials (
  id uuid primary key default gen_random_uuid(),
  product text not null,
  hwid text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  unique (product, hwid)
);

create index if not exists license_trials_started_at_idx on public.license_trials (started_at desc);

alter table public.license_trials enable row level security;

alter table public.licenses add column if not exists last_transfer_at timestamptz;

-- 2026-10-30 以降、Supabase は新規テーブルへ Data API の権限を自動付与しない（CLAUDE.md §4）。
grant select, insert, update, delete on public.license_trials to service_role;
