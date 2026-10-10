-- 温まり返金（2026-10-10）を実稼働ログ（generation_logs）の売上に反映する。
--
-- 温まったコンテナで動いたジョブは、完了時にワーカーが基本料のうち読み込み分を返し、
-- generation_jobs.metadata.warm_refund_credits に返した額を残す（完了と同じ 1 回の更新で書く）。
-- これまでの credits_consumed は料金（credits_cost）そのままで、返した分も売上に数えてしまう。
-- → 完了の記録を「料金 − 温まり返金」にする（admin のログ・日次サマリーの利益率が実質の値になる）。
-- 返金済み（失敗・中止）の 0 はこれまでどおり。

create or replace function public.log_generation_job_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('completed', 'failed') and old.status is distinct from new.status then
    insert into public.generation_logs (
      user_id, job_id, job_type, execution_time_ms, credits_consumed, gpu_tier, status, error_message
    ) values (
      new.user_id,
      new.id,
      new.workflow_type,
      case when new.processing_started_at is null then 0
           else greatest(0, extract(epoch from (now() - new.processing_started_at)) * 1000)::integer end,
      case when coalesce(new.metadata->>'refunded', '') = 'true' then 0
           else greatest(0, new.credits_cost - coalesce((new.metadata->>'warm_refund_credits')::integer, 0)) end,
      coalesce(new.metadata->>'gpu_tier', case when new.processing_started_at is null then 'none' else 'standard' end),
      case when new.status = 'completed' then 'success' else 'failed' end,
      new.error_message
    );
  elsif coalesce(new.metadata->>'refunded', '') = 'true' and coalesce(old.metadata->>'refunded', '') <> 'true' then
    update public.generation_logs set credits_consumed = 0 where job_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function public.log_generation_job_completion() from public, anon, authenticated;
grant execute on function public.log_generation_job_completion() to service_role;
