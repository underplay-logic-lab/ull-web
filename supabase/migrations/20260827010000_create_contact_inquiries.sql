-- Durable record of every /api/contact submission, written BEFORE the
-- best-effort Resend notification email is attempted — so a Resend/SMTP
-- failure (e.g. an unverified sending domain) never loses an inquiry, only
-- the notification. email_sent lets an admin spot inquiries whose
-- notification failed and needs manual follow-up.
create table if not exists public.contact_inquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text,
  service text,
  message text not null,
  email_sent boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists contact_inquiries_created_at_idx
  on public.contact_inquiries (created_at desc);

alter table public.contact_inquiries enable row level security;

-- Contains PII from anonymous site visitors — service role (the /api/contact
-- route, via supabaseAdmin) only, no anon/authenticated policies at all.
create policy "contact_inquiries_service_role_all"
  on public.contact_inquiries
  for all
  to service_role
  using (true)
  with check (true);
