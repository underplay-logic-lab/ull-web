-- 2026-09-30: 納品ツールのライセンス（手元で動かすツールを「その人の PC だけ」で動かす）。
--
-- licenses            … 発行したライセンス 1 件 = 相手 1 人 × ツール 1 本。キーは sha256 だけを持つ（原文は発行時に一度だけ表示）。
-- license_activations … そのライセンスで認証した PC（HWID）。max_devices まで。解除（revoked_at）すると枠が空く。
-- 読み書きは Next の API（service_role）だけ。クライアント（supabase-js）からは触らせない。
-- 仕組みの説明は src/lib/license/license.server.ts。

create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  product text not null,
  licensee text not null,
  contact text,
  note text,
  key_hash text not null unique,
  key_hint text not null,
  max_devices integer not null default 1 check (max_devices >= 1),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists licenses_created_at_idx on public.licenses (created_at desc);

create table if not exists public.license_activations (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.licenses (id) on delete cascade,
  hwid text not null,
  method text not null default 'online' check (method in ('online', 'manual')),
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (license_id, hwid)
);

create index if not exists license_activations_license_idx on public.license_activations (license_id);

alter table public.licenses enable row level security;
alter table public.license_activations enable row level security;

-- 2026-10-30 以降、Supabase は新規テーブルへ Data API の権限を自動付与しない（CLAUDE.md §4）。
grant select, insert, update, delete on public.licenses to service_role;
grant select, insert, update, delete on public.license_activations to service_role;
