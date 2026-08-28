-- Real per-job execution timing + a lightweight queue-stats function that
-- backs the Studio "現在何人待ちか / あと約何分" queue monitor.
--
-- started_at / completed_at are stamped by the spawned Modal worker
-- (modal_wan_animate_blackwell.py) when it flips a job to 'processing' /
-- 'completed'. They may stay NULL on rows written before the worker was
-- redeployed — generation_job_queue_stats ignores those rows and falls
-- back to a 28s default when it has no sample at all.
alter table public.generation_jobs
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz;

-- Queue-position counting: COUNT of queued/processing jobs created before a
-- given timestamp.
create index if not exists generation_jobs_status_created_idx
  on public.generation_jobs (status, created_at);

-- The "recent completed jobs" execution-time sample.
create index if not exists generation_jobs_completed_at_idx
  on public.generation_jobs (completed_at desc)
  where status = 'completed';

-- Returns, for the job created at p_created_at:
--   queue_position        - queued/processing jobs created before it
--   avg_execution_seconds - mean (completed_at - started_at) over the last
--                           10 completed jobs, or 28 when there's no data.
-- Plain SQL (not plpgsql) + single-level dollar quoting to keep it trivial.
create or replace function public.generation_job_queue_stats(p_created_at timestamptz)
returns table (queue_position bigint, avg_execution_seconds numeric)
language sql
stable
as $fn$
  select
    (
      select count(*)
      from public.generation_jobs
      where status in ('queued', 'processing')
        and created_at < p_created_at
    ),
    (
      select coalesce(round(avg(extract(epoch from (completed_at - started_at)))::numeric, 1), 28)
      from (
        select started_at, completed_at
        from public.generation_jobs
        where status = 'completed'
          and started_at is not null
          and completed_at is not null
          and completed_at > started_at
        order by completed_at desc
        limit 10
      ) recent
    );
$fn$;

grant execute on function public.generation_job_queue_stats(timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
