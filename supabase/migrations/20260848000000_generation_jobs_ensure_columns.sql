-- Defensive backfill — some environments have a public.generation_jobs that
-- predates (or was created without) the full column set from
-- 20260835000000_create_generation_jobs.sql, which surfaces at runtime as
-- PostgREST "Could not find the 'credits_cost' column ... in the schema
-- cache". Re-assert every column the app writes; all idempotent.

alter table public.generation_jobs
  add column if not exists credits_cost integer not null default 0,
  add column if not exists inputs jsonb not null default '{}'::jsonb,
  add column if not exists video_url text,
  add column if not exists error_message text;

notify pgrst, 'reload schema';
