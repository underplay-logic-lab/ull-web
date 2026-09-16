-- 実稼働ログ(generation_logs)を非同期ジョブテーブルから自動収集する。
--
-- 背景（2026-09-16、ホスト指摘）: admin の「実稼働ログ & 粗利監視」タブが
-- ほぼ空だった。原因は logGenerationActivity()（generation_logs への insert
-- 関数）を呼んでいたのが「特化ワークフロー」（保留中）と旧 Wan Animate 同期
-- エンドポイント（タブ非表示化済み）だけで、実際によく使われる
-- Multi-Angle / 超解像（画像・動画）/ LoRA / Cinematic Director はどれも
-- 呼んでいなかったこと。これらは全て非同期ジョブ方式
-- （angle_jobs / upscale_jobs / generation_jobs へ pending/queued 行を
-- insert → ブラウザが owner RLS で直接ポーリング → Modal ワーカーが
-- service-role で直接 PATCH）なので、Next.js 側に「成功/失敗が判明する
-- 箇所」自体が存在しない。個々の Python ワーカーに generation_logs への
-- insert を実装させると更新漏れが起きやすいため、DB トリガーで
-- status 変化を一元的に拾う（ワーカー側の変更は一切不要）。

-- angle_jobs（Multi-Angle Studio）----------------------------------------

create or replace function public.log_angle_job_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('completed', 'failed') and old.status is distinct from new.status then
    insert into public.generation_logs (
      user_id, job_type, execution_time_ms, credits_consumed, status, error_message
    ) values (
      new.user_id,
      'multi_angle',
      greatest(0, extract(epoch from (now() - new.created_at)) * 1000)::integer,
      new.credits_cost,
      case when new.status = 'completed' then 'success' else 'failed' end,
      new.error_message
    );
  end if;
  return new;
end;
$$;

drop trigger if exists angle_jobs_log_completion on public.angle_jobs;
create trigger angle_jobs_log_completion
  after update on public.angle_jobs
  for each row execute function public.log_angle_job_completion();

-- upscale_jobs（超解像スタジオ: 画像・動画共用）---------------------------

create or replace function public.log_upscale_job_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('completed', 'failed') and old.status is distinct from new.status then
    insert into public.generation_logs (
      user_id, job_type, execution_time_ms, credits_consumed, status, error_message
    ) values (
      new.user_id,
      case when new.media_type = 'video' then 'upscale_video' else 'upscale_image' end,
      greatest(0, extract(epoch from (now() - new.created_at)) * 1000)::integer,
      new.credits_cost,
      case when new.status = 'completed' then 'success' else 'failed' end,
      new.error_message
    );
  end if;
  return new;
end;
$$;

drop trigger if exists upscale_jobs_log_completion on public.upscale_jobs;
create trigger upscale_jobs_log_completion
  after update on public.upscale_jobs
  for each row execute function public.log_upscale_job_completion();

-- generation_jobs（LoRA 学習・Cinematic Director）-------------------------

create or replace function public.log_generation_job_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('completed', 'failed') and old.status is distinct from new.status then
    insert into public.generation_logs (
      user_id, job_type, execution_time_ms, credits_consumed, status, error_message
    ) values (
      new.user_id,
      new.workflow_type,
      greatest(0, extract(epoch from (now() - new.created_at)) * 1000)::integer,
      new.credits_cost,
      case when new.status = 'completed' then 'success' else 'failed' end,
      new.error_message
    );
  end if;
  return new;
end;
$$;

drop trigger if exists generation_jobs_log_completion on public.generation_jobs;
create trigger generation_jobs_log_completion
  after update on public.generation_jobs
  for each row execute function public.log_generation_job_completion();
