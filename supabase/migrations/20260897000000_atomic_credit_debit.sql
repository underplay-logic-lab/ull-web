-- クレジットの引き落としと返金を「その場で 1 回の操作」にする（2026-10-09・セキュリティ点検）。
--
-- それまでの生成 API（Director・部分修正・曲づくり・Multi-Angle・特化ワークフロー・LoRA 学習・超解像 3 種・Wan Animate）は
-- 「残高を読む → 料金以上か確かめる → 残高 − 料金 を書き込む」の 2 段階だった。同じ人が同時に何本も送ると、
-- 全部が同じ残高を読んで「足りる」と判断し、全部が同じ値を書き込む＝1 本分の料金で何本も作れた（二重使用）。
-- 返金（ワーカー・API の巻き戻し）も「読む → 足して書く」で、途中の引き落としを消してしまうことがあった。
--
-- debit_profile_credits: 残高が料金以上・期限内のときだけ、その場で引く。新しい残高を返す。足りなければ null（何もしない）。
-- refund_profile_credits: その場で足す。有効期限は動かさない（increment_profile_credits は購入用で期限を 180 日延ばす）。
-- どちらもサーバー（service_role）だけが実行できる（CLAUDE.md §4: SECURITY DEFINER は既定で誰でも実行できるので必ず取り消す）。

create or replace function public.debit_profile_credits(p_user_id uuid, p_amount integer)
returns integer
language plpgsql
security definer
set search_path = public
as $debit$
declare
  v_new_credits integer;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'debit_profile_credits: invalid amount %', p_amount;
  end if;

  update public.profiles
     set credits = credits - p_amount,
         updated_at = now()
   where id = p_user_id
     and credits >= p_amount
     and (credits_expire_at is null or credits_expire_at > now())
  returning credits into v_new_credits;

  return v_new_credits;  -- 足りない・期限切れ・ユーザーが無い → null
end;
$debit$;

revoke all on function public.debit_profile_credits(uuid, integer) from public, anon, authenticated;
grant execute on function public.debit_profile_credits(uuid, integer) to service_role;

create or replace function public.refund_profile_credits(p_user_id uuid, p_amount integer)
returns integer
language plpgsql
security definer
set search_path = public
as $refund$
declare
  v_new_credits integer;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'refund_profile_credits: invalid amount %', p_amount;
  end if;

  update public.profiles
     set credits = credits + p_amount,
         updated_at = now()
   where id = p_user_id
  returning credits into v_new_credits;

  return v_new_credits;
end;
$refund$;

revoke all on function public.refund_profile_credits(uuid, integer) from public, anon, authenticated;
grant execute on function public.refund_profile_credits(uuid, integer) to service_role;

-- 点検で見つかった残り（実害は無いが揃える）: トリガー用の関数も一般から実行できないようにする。
revoke all on function public.log_angle_job_completion() from public, anon, authenticated;
revoke all on function public.log_generation_job_completion() from public, anon, authenticated;
revoke all on function public.log_upscale_job_completion() from public, anon, authenticated;
