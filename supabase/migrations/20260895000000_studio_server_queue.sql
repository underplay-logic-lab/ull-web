-- 予約（順番待ち）をサーバー側で流す（2026-10-03、ローンチ後の不具合）。
--
-- それまでの予約は画面のメモリにだけあり、前のジョブの完了を画面が見てから送っていた
-- ＝タブを閉じると予約が消えた。予約した時点で課金してジョブ行を 'reserved' で作り、
-- 前のジョブが終わったら DB トリガー（pg_net）→ Next の /api/studio/queue/advance が次を起動する。
--
-- 対象: angle_jobs（Multi-Angle）／upscale_jobs（画像・動画超解像）／generation_jobs（Director）。
-- generation_jobs は 'queued' を「起動済みの待機」に使っているので別名 'reserved' にする。
--
-- ★ 適用後にやること（1 回だけ・SQL Editor で）: トリガーが叩く先と合言葉を Vault に入れる。
--   select vault.create_secret('https://www.ullstudio.com/api/studio/queue/advance', 'studio_queue_advance_url');
--   select vault.create_secret('<Vercel の STUDIO_QUEUE_SECRET と同じ値>', 'studio_queue_secret');
--   入っていなければトリガーは何もしない（画面を開いたとき・画面が完了を見たときの起動だけになる）。

-- 1. 状態に 'reserved' を足す --------------------------------------------------
alter table public.angle_jobs drop constraint if exists angle_jobs_status_check;
alter table public.angle_jobs
  add constraint angle_jobs_status_check
  check (status in ('reserved', 'pending', 'processing', 'completed', 'failed'));

alter table public.upscale_jobs drop constraint if exists upscale_jobs_status_check;
alter table public.upscale_jobs
  add constraint upscale_jobs_status_check
  check (status in ('reserved', 'pending', 'processing', 'completed', 'failed'));

alter table public.generation_jobs drop constraint if exists generation_jobs_status_check;
alter table public.generation_jobs
  add constraint generation_jobs_status_check
  check (status in ('reserved', 'queued', 'processing', 'completed', 'failed', 'cancelled', 'failed_timeout'));

create index if not exists angle_jobs_reserved_idx
  on public.angle_jobs (user_id, created_at) where status = 'reserved';
create index if not exists upscale_jobs_reserved_idx
  on public.upscale_jobs (user_id, created_at) where status = 'reserved';
create index if not exists generation_jobs_reserved_idx
  on public.generation_jobs (user_id, created_at) where status = 'reserved';

-- 2. 起動に要る引数（画像の本体は入れず置き場所だけ）。service_role だけが読む ------------
create table if not exists public.studio_dispatch_specs (
  job_id uuid primary key,
  kind text not null check (kind in ('angle', 'upscale_image', 'upscale_video', 'director')),
  user_id uuid not null references auth.users(id) on delete cascade,
  spec jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.studio_dispatch_specs enable row level security;
revoke all on table public.studio_dispatch_specs from public, anon, authenticated;
grant select, insert, update, delete on table public.studio_dispatch_specs to service_role;

-- 3. 次の 1 件を取り出す（同じ人・同じ種類で動いているものが無ければ、reserved の古い順 1 件を起動中へ）。
--    advisory lock で「同時に 2 か所から呼ばれて 2 件起動する」を防ぐ。
--    動いている扱いは作成から 6 時間以内（ワーカーが落ちて processing のまま残った行で詰まらないように）。
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

  elsif p_kind = 'director' then
    select exists (
      select 1 from generation_jobs
       where user_id = p_user_id and workflow_type = 'director'
         and status in ('queued', 'processing') and created_at > v_since
    ) into v_busy;
    if v_busy then return null; end if;
    select id into v_id from generation_jobs
     where user_id = p_user_id and workflow_type = 'director' and status = 'reserved'
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

-- 4. 完了・失敗したら、その人の予約が残っていれば advance を叩く ------------------------
create extension if not exists pg_net with schema extensions;

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
      if new.workflow_type is distinct from 'director' then return new; end if;
      v_kind := 'director';
      select exists (
        select 1 from generation_jobs
         where user_id = new.user_id and workflow_type = 'director' and status = 'reserved'
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

drop trigger if exists angle_jobs_studio_queue_kick on public.angle_jobs;
create trigger angle_jobs_studio_queue_kick
  after update of status on public.angle_jobs
  for each row execute function public.studio_queue_kick();

drop trigger if exists upscale_jobs_studio_queue_kick on public.upscale_jobs;
create trigger upscale_jobs_studio_queue_kick
  after update of status on public.upscale_jobs
  for each row execute function public.studio_queue_kick();

drop trigger if exists generation_jobs_studio_queue_kick on public.generation_jobs;
create trigger generation_jobs_studio_queue_kick
  after update of status on public.generation_jobs
  for each row execute function public.studio_queue_kick();
