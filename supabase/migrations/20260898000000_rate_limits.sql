-- 回数の制限（レート制限、2026-10-09・セキュリティ点検）。
--
-- 料金を取らずに有料の外部 AI（Gemini）を呼ぶ API（LoRA Studio のキャプション・キャプション指示・翻訳・特徴タグ）に
-- 回数の上限が無く、無料登録のアカウントで繰り返し叩かれると請求がこちらに来た。
-- hit_rate_limit: 「人 × 種類 × 時間の枠」の回数をその場で 1 回だけ数えて、上限以内なら true を返す。
-- 同時に叩かれても数え漏れない（insert … on conflict do update の 1 文）。サーバー（service_role）だけが実行できる。

create table if not exists public.rate_limit_hits (
  user_id uuid not null,
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (user_id, bucket, window_start)
);

alter table public.rate_limit_hits enable row level security;
-- ポリシーは作らない（一般の利用者からは読めない・書けない）。サーバーは service_role で RLS を通らない。
grant select, insert, update, delete on table public.rate_limit_hits to service_role;

create index if not exists rate_limit_hits_window_start_idx on public.rate_limit_hits (window_start);

create or replace function public.hit_rate_limit(p_user_id uuid, p_bucket text, p_window_s integer, p_max integer)
returns boolean
language plpgsql
set search_path = public
as $hit$
declare
  v_window timestamptz;
  v_hits integer;
begin
  if p_window_s is null or p_window_s < 1 or p_max is null or p_max < 1 then
    raise exception 'hit_rate_limit: invalid window % / max %', p_window_s, p_max;
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s);

  insert into public.rate_limit_hits as r (user_id, bucket, window_start, hits)
  values (p_user_id, p_bucket, v_window, 1)
  on conflict (user_id, bucket, window_start) do update set hits = r.hits + 1
  returning r.hits into v_hits;

  -- 古い枠の掃除（100 回に 1 回だけ・1 日より前）。
  if random() < 0.01 then
    delete from public.rate_limit_hits where window_start < now() - interval '1 day';
  end if;

  return v_hits <= p_max;
end;
$hit$;

revoke all on function public.hit_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(uuid, text, integer, integer) to service_role;
