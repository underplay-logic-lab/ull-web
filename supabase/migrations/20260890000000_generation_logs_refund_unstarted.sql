-- 実稼働ログ（generation_logs）の原価・売上のずれを直す（2026-09-25、ホスト要望）。
--
-- 日次サマリーで「粗利 -302%・原価割れ 0 件」が出た件の原因:
--   1. 始まっていないジョブ（pending のまま中止・GPU 起動前に失敗）の実行時間を
--      coalesce(processing_started_at, created_at) で「作成からの経過時間」にしていた。
--      2026-09-24 に中止した超解像 64 件が 1 件 441〜876 秒・計 15.4 時間と記録された。
--   2. gpu_tier が無いと 'standard' になり、読み出し側が job_type 別の予備単価
--      （超解像は B300 相当 $0.002083/秒）で計算していた。
--   3. 返金したジョブの credits_cost をそのまま売上に数えていた。
--
-- 直し方:
--   - 始まっていない（processing_started_at が null）なら実行時間 0・gpu_tier 'none'
--     （読み出し側 src/lib/pricing/gpuRates.ts で原価 0 として扱う）。
--   - 返金済み（metadata.refunded = true）なら credits_consumed 0。失敗の後から返金される
--     （admin の中止・recover）こともあるので、job_id を持たせて後からでも 0 に直す。
--   - 既存の行を補正する（下の backfill）。

alter table public.generation_logs add column if not exists job_id uuid;
create index if not exists generation_logs_job_id_idx on public.generation_logs (job_id);

-- angle_jobs（Multi-Angle）----------------------------------------------------
create or replace function public.log_angle_job_completion()
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
      'multi_angle',
      case when new.processing_started_at is null then 0
           else greatest(0, extract(epoch from (now() - new.processing_started_at)) * 1000)::integer end,
      case when coalesce(new.metadata->>'refunded', '') = 'true' then 0 else new.credits_cost end,
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

-- upscale_jobs（超解像）--------------------------------------------------------
create or replace function public.log_upscale_job_completion()
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
      case when new.media_type = 'video' then 'upscale_video' else 'upscale_image' end,
      case when new.processing_started_at is null then 0
           else greatest(0, extract(epoch from (now() - new.processing_started_at)) * 1000)::integer end,
      case when coalesce(new.metadata->>'refunded', '') = 'true' then 0 else new.credits_cost end,
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

-- generation_jobs（LoRA / Director 等）----------------------------------------
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
      case when coalesce(new.metadata->>'refunded', '') = 'true' then 0 else new.credits_cost end,
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

-- 既存の行の補正（backfill）---------------------------------------------------

-- 2026-09-24 に admin が中止した超解像 64 件（pending のまま・全額返金済み）。
-- 63 件は始まっておらず、走っていた 1 件も中止までの経過時間しか残っていないので、まとめて 0 にする。
update public.generation_logs
set execution_time_ms = 0, gpu_tier = 'none', credits_consumed = 0
where job_type = 'upscale_image'
  and error_message = '管理者による中止（全額返金）';

-- GPU を起動する前に失敗した LoRA（データセット前処理の失敗。GPU 課金なし）。
update public.generation_logs
set execution_time_ms = 0, gpu_tier = 'none'
where job_type = 'lora_training'
  and error_message like '%GPU は起動しません%';

-- 返金済みのジョブ。job_id が無い旧行は、同じユーザー・同じ料金・同じエラー文で対応を取る
-- （2026-09-25 に実データで 1 対 1、または返金済み同士の組でしか当たらないことを確認済み）。
update public.generation_logs l
set credits_consumed = 0
from public.generation_jobs j
where coalesce(j.metadata->>'refunded', '') = 'true'
  and l.job_type = j.workflow_type
  and l.user_id = j.user_id
  and l.credits_consumed = j.credits_cost
  and coalesce(l.error_message, '') = coalesce(j.error_message, '');

-- SDXL（sd-scripts）は 2026-09-23 16:51 JST まで L40S で、ワーカーがまだ gpu_tier を書いていなかった。
update public.generation_logs
set gpu_tier = 'L40S'
where job_type = 'lora_training'
  and status = 'success'
  and gpu_tier = 'standard'
  and created_at >= '2026-09-22T00:00:00Z'
  and created_at < '2026-09-23T07:51:58Z';

notify pgrst, 'reload schema';
