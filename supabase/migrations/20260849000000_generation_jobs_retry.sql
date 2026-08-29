-- LoRA Studio: auto-failover for jobs stuck "pending" on Modal (GPU
-- exhaustion / scheduler lag). The client watches for a job that stays
-- 'queued' beyond PENDING_TIMEOUT_MS (10s) and auto-cancels + re-dispatches
-- it, up to 2 retries; past that it closes as 'failed_timeout' and
-- 100%-refunds.

alter table public.generation_jobs
  drop constraint if exists generation_jobs_status_check;

alter table public.generation_jobs
  add constraint generation_jobs_status_check
  check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled', 'failed_timeout'));

alter table public.generation_jobs
  add column if not exists retry_count integer not null default 0,
  add column if not exists modal_call_id text,
  add column if not exists parent_job_id uuid,
  -- guards the refund path against a double-credit if the timeout action
  -- fires more than once.
  add column if not exists refunded boolean not null default false;

notify pgrst, 'reload schema';
