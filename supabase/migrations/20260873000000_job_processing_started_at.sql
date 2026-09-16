-- generation_logs.execution_time_ms（Modal原価計算の元になる秒数）が
-- ジョブ行の created_at（＝キュー投入時刻）基準だと、他ジョブの順番待ち
-- 時間まで丸ごと含んでしまい、Modal累計推定原価が実際のGPU課金より
-- 過大に出る（ホスト指摘、2026-09-16）。
--
-- 各ジョブテーブルに processing_started_at を追加し、status が
-- pending/queued -> processing に変わった瞬間（＝実際にGPUコンテナで
-- ジョブ関数が動き始めた瞬間。CLAUDE.md §6の「コールドスタート専用表示」
-- が使っているのと同じ遷移）を記録する。ここを execution_time_ms の起点に
-- することで「他ジョブの順番待ち」は除外しつつ、コールドスタート
-- （GPU起動＋モデルロード）は実際にGPU課金が発生している時間なので
-- そのまま含める。

alter table public.angle_jobs
  add column if not exists processing_started_at timestamptz;

alter table public.upscale_jobs
  add column if not exists processing_started_at timestamptz;

alter table public.generation_jobs
  add column if not exists processing_started_at timestamptz;

-- angle_jobs: 既存の updated_at タッチ関数を拡張 -----------------------

create or replace function public.touch_angle_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  if old.status = 'pending' and new.status = 'processing' and new.processing_started_at is null then
    new.processing_started_at = now();
  end if;
  return new;
end;
$$;

-- upscale_jobs: 同様 -----------------------------------------------------

create or replace function public.touch_upscale_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  if old.status = 'pending' and new.status = 'processing' and new.processing_started_at is null then
    new.processing_started_at = now();
  end if;
  return new;
end;
$$;

-- generation_jobs: 専用の updated_at タッチトリガーが無かったので新設 ----

create or replace function public.mark_generation_jobs_processing_started()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'queued' and new.status = 'processing' and new.processing_started_at is null then
    new.processing_started_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists generation_jobs_mark_processing_started on public.generation_jobs;
create trigger generation_jobs_mark_processing_started
  before update on public.generation_jobs
  for each row execute function public.mark_generation_jobs_processing_started();

-- 20260871000000 の完了ログ関数を、processing_started_at 基準に更新 -----
-- （NULL のまま completed/failed になったジョブ ＝ processing を経由せず
-- pending/queued のまま終わったケースは created_at にフォールバック）。

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
      greatest(0, extract(epoch from (now() - coalesce(new.processing_started_at, new.created_at))) * 1000)::integer,
      new.credits_cost,
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
      user_id, job_type, execution_time_ms, credits_consumed, status, error_message
    ) values (
      new.user_id,
      case when new.media_type = 'video' then 'upscale_video' else 'upscale_image' end,
      greatest(0, extract(epoch from (now() - coalesce(new.processing_started_at, new.created_at))) * 1000)::integer,
      new.credits_cost,
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
      user_id, job_type, execution_time_ms, credits_consumed, status, error_message
    ) values (
      new.user_id,
      new.workflow_type,
      greatest(0, extract(epoch from (now() - coalesce(new.processing_started_at, new.created_at))) * 1000)::integer,
      new.credits_cost,
      case when new.status = 'completed' then 'success' else 'failed' end,
      new.error_message
    );
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';
