-- The "N人待機中" count was inflated by orphaned queued rows from old test
-- runs. Scope generation_job_queue_stats to jobs created in the last hour —
-- anything older that's still 'queued' is a dead row, not a real wait.

drop function if exists public.generation_job_queue_stats(timestamptz);

create function public.generation_job_queue_stats(p_created_at timestamptz)
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
        and created_at > now() - interval '1 hour'
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

-- One-off cleanup: close every job that's been stuck 'queued' for > 1 hour.
update public.generation_jobs
  set status = 'failed_timeout',
      error_message = coalesce(error_message, 'stale queued job auto-closed'),
      completed_at = now()
  where status = 'queued'
    and created_at < now() - interval '1 hour';

notify pgrst, 'reload schema';
