-- 曲づくり（2026-10-06）: generation_jobs に workflow_type 'song' を足し、予約（順番待ち）の種類 'song' を足す。
--
-- 曲づくりのジョブは Director と同じ generation_jobs に入る（ワーカーは modal_ace_worker.py の run_job）。
-- 予約の仕組みは 20260895000000_studio_server_queue.sql と同じ（同じ人・同じ種類で動いているものが無ければ reserved の古い順 1 件を起動）。
-- 新しいテーブルは作らないので GRANT の追加は無い。完了ログ（generation_logs）は既存のトリガーが workflow_type のまま記録する。

-- 1. workflow_type に 'song' ---------------------------------------------------
alter table public.generation_jobs
  drop constraint if exists generation_jobs_workflow_type_check;
alter table public.generation_jobs
  add constraint generation_jobs_workflow_type_check
  check (workflow_type in ('cinematic', 'wan', 'custom', 'lora_training', 'director', 'song'));

-- 2. 予約の起動引数の種類に 'song' ---------------------------------------------
alter table public.studio_dispatch_specs drop constraint if exists studio_dispatch_specs_kind_check;
alter table public.studio_dispatch_specs
  add constraint studio_dispatch_specs_kind_check
  check (kind in ('angle', 'upscale_image', 'upscale_video', 'director', 'song'));

-- 3. 次の 1 件を取り出す: 'director' と同じ形で 'song' を足す ---------------------
create or replace function public.claim_next_reserved_job(p_kind text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_busy boolean;
  v_since timestamptz := now() - interval '6 hours';
begin
  perform pg_advisory_xact_lock(hashtext('studio_queue:' || p_kind || ':' || p_user_id::text));

  if p_kind = 'angle' then
    select exists (
      select 1 from angle_jobs
       where user_id = p_user_id and status in ('pending', 'processing') and created_at > v_since
    ) into v_busy;
    if v_busy then return null; end if;
    select id into v_id from angle_jobs
     where user_id = p_user_id and status = 'reserved'
     order by created_at limit 1 for update skip locked;
    if v_id is null then return null; end if;
    update angle_jobs set status = 'pending' where id = v_id;

  elsif p_kind in ('upscale_image', 'upscale_video') then
    select exists (
      select 1 from upscale_jobs
       where user_id = p_user_id and status in ('pending', 'processing') and created_at > v_since
         and media_type = case when p_kind = 'upscale_video' then 'video' else 'image' end
    ) into v_busy;
    if v_busy then return null; end if;
    select id into v_id from upscale_jobs
     where user_id = p_user_id and status = 'reserved'
       and media_type = case when p_kind = 'upscale_video' then 'video' else 'image' end
     order by created_at limit 1 for update skip locked;
    if v_id is null then return null; end if;
    update upscale_jobs set status = 'pending' where id = v_id;

  elsif p_kind in ('director', 'song') then
    select exists (
      select 1 from generation_jobs
       where user_id = p_user_id and workflow_type = p_kind
         and status in ('queued', 'processing') and created_at > v_since
    ) into v_busy;
    if v_busy then return null; end if;
    select id into v_id from generation_jobs
     where user_id = p_user_id and workflow_type = p_kind and status = 'reserved'
     order by created_at limit 1 for update skip locked;
    if v_id is null then return null; end if;
    update generation_jobs set status = 'queued' where id = v_id;

  else
    raise exception 'unknown kind: %', p_kind;
  end if;

  return v_id;
end;
$$;

revoke all on function public.claim_next_reserved_job(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_next_reserved_job(text, uuid) to service_role;

-- 4. 完了・失敗で次を起動するトリガー: generation_jobs は 'director' と 'song' -----------
create or replace function public.studio_queue_kick()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_has boolean := false;
  v_url text;
  v_secret text;
begin
  if not (new.status in ('completed', 'failed', 'cancelled', 'failed_timeout')
          and old.status is distinct from new.status) then
    return new;
  end if;

  begin
    if tg_table_name = 'angle_jobs' then
      v_kind := 'angle';
      select exists (select 1 from angle_jobs where user_id = new.user_id and status = 'reserved') into v_has;
    elsif tg_table_name = 'upscale_jobs' then
      v_kind := case when new.media_type = 'video' then 'upscale_video' else 'upscale_image' end;
      select exists (
        select 1 from upscale_jobs
         where user_id = new.user_id and status = 'reserved' and media_type = new.media_type
      ) into v_has;
    elsif tg_table_name = 'generation_jobs' then
      if new.workflow_type not in ('director', 'song') then return new; end if;
      v_kind := new.workflow_type;
      select exists (
        select 1 from generation_jobs
         where user_id = new.user_id and workflow_type = new.workflow_type and status = 'reserved'
      ) into v_has;
    end if;
    if not v_has then return new; end if;

    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'studio_queue_advance_url';
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'studio_queue_secret';
    if v_url is null or v_secret is null then return new; end if;

    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('kind', v_kind, 'userId', new.user_id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
      timeout_milliseconds := 10000
    );
  exception when others then
    -- ワーカーの状態更新は絶対に止めない（起動は画面側・日次の掃除でも拾う）。
    raise warning 'studio_queue_kick failed: %', sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.studio_queue_kick() from public, anon, authenticated;
