-- 実稼働ログ & 粗利監視（管理画面）: generation_logs.gpu_tier は
-- 20260826000000 で列自体は追加済みだったが、20260871000000 /
-- 20260873000000 の完了ログトリガーがどれもこの列を書き込んでおらず、
-- 常定値 'standard' のままだった（2026-09-18、ホスト要望で調査・修正）。
-- angle_jobs / upscale_jobs / generation_jobs の各ワーカーは、完了時の
-- metadata PATCH に gpu_tier（torch.cuda.get_device_name() 由来の実機名を
-- 正規化した文字列）を含めるよう変更済み（modal_angle_worker.py /
-- modal_seedvr2_worker.py / modal_lora_worker.py / modal_wan_animate_blackwell.py）
-- ので、トリガー側もそこから拾って generation_logs.gpu_tier へコピーする。
-- gpu_tier が無い（旧ジョブ・書き込み前のワーカー）場合は 'standard' の
-- ままにして、読み出し側（/api/admin/logs）のフォールバック計算に委ねる。

create or replace function public.log_angle_job_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('completed', 'failed') and old.status is distinct from new.status then
    insert into public.generation_logs (
      user_id, job_type, execution_time_ms, credits_consumed, gpu_tier, status, error_message
    ) values (
      new.user_id,
      'multi_angle',
      greatest(0, extract(epoch from (now() - coalesce(new.processing_started_at, new.created_at))) * 1000)::integer,
      new.credits_cost,
      coalesce(new.metadata->>'gpu_tier', 'standard'),
      case when new.status = 'completed' then 'success' else 'failed' end,
      new.error_message
    );
  end if;
  return new;
end;
$$;

create or replace function public.log_upscale_job_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('completed', 'failed') and old.status is distinct from new.status then
    insert into public.generation_logs (
      user_id, job_type, execution_time_ms, credits_consumed, gpu_tier, status, error_message
    ) values (
      new.user_id,
      case when new.media_type = 'video' then 'upscale_video' else 'upscale_image' end,
      greatest(0, extract(epoch from (now() - coalesce(new.processing_started_at, new.created_at))) * 1000)::integer,
      new.credits_cost,
      coalesce(new.metadata->>'gpu_tier', 'standard'),
      case when new.status = 'completed' then 'success' else 'failed' end,
      new.error_message
    );
  end if;
  return new;
end;
$$;

create or replace function public.log_generation_job_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('completed', 'failed') and old.status is distinct from new.status then
    insert into public.generation_logs (
      user_id, job_type, execution_time_ms, credits_consumed, gpu_tier, status, error_message
    ) values (
      new.user_id,
      new.workflow_type,
      greatest(0, extract(epoch from (now() - coalesce(new.processing_started_at, new.created_at))) * 1000)::integer,
      new.credits_cost,
      coalesce(new.metadata->>'gpu_tier', 'standard'),
      case when new.status = 'completed' then 'success' else 'failed' end,
      new.error_message
    );
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';
