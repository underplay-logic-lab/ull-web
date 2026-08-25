-- Admin-facing governance/monitoring record of per-feature credit cost and
-- GPU-second unit cost, edited from /admin's pricing tab. Informational only:
-- the credit cost actually enforced at generation time still lives in
-- src/lib/data.ts (e.g. WAN_ANIMATE_GENERATION_COST) and is not read from
-- this table.
create table if not exists public.studio_pricing (
  key text primary key,
  label text not null,
  credits integer not null default 0,
  unit_cost_usd numeric(10, 6) not null default 0,
  description text,
  updated_at timestamptz not null default now()
);

alter table public.studio_pricing enable row level security;

-- No policies for anon/authenticated: only the service role (admin API
-- routes under /api/admin) may read or write this table.

insert into public.studio_pricing (key, label, credits, unit_cost_usd, description)
values
  ('wan_animate_preset', 'プリセット動画生成 (720p / 5秒)', 10, 0.00055, '標準プリセット適用時の基本消費クレジット'),
  ('wan_animate_custom', 'カスタム動画生成 (720p / 5秒)', 15, 0.00055, '自前動画アップロード時の消費クレジット'),
  ('wan_animate_pro_10s', 'PRO 長尺高画質 (1080p / 10秒)', 25, 0.00055, '10秒長尺生成時の消費クレジット')
on conflict (key) do nothing;
