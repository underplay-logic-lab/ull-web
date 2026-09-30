-- 2026-10-01 ローンチ日のセキュリティ点検（Supabase Security Advisor）で見つかった穴を塞ぐ。
--
-- 【重大】SECURITY DEFINER の関数に、既定で PUBLIC（＝ anon / authenticated）の EXECUTE が付いていた。
-- 公開用の anon キーだけで /rest/v1/rpc/increment_profile_credits 等を呼べ、誰でも自分にクレジットを足せた
-- （anon で実行できることを無害な引数で確認済み: 200 が返った）。
-- 呼び出し元はすべてサーバー側（Next の supabaseAdmin・Modal ワーカーの service_role・DB 内の他の関数・トリガー）
-- なので、anon / authenticated から取り上げて service_role だけに渡す。
-- トリガー関数は、EXECUTE の権限を見るのはトリガー作成時だけなので、取り上げても発火には影響しない。

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.increment_profile_credits(uuid, integer)',
    'public.grant_polar_order_credits(text, uuid, integer, text)',
    'public.append_angle_result(uuid, text, text)',
    'public.extend_gpu_warm(uuid, integer)',
    'public.handle_new_user()',
    'public.log_angle_job_completion()',
    'public.log_upscale_job_completion()',
    'public.log_generation_job_completion()'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- 関数の search_path を固定する（Security Advisor: function_search_path_mutable）。
-- 呼び出し側の search_path を差し替えて、関数内の名前を別のスキーマのものにすり替える攻撃を防ぐ。
alter function public.handle_new_user() set search_path = public, pg_temp;
alter function public.generation_job_queue_stats(timestamptz) set search_path = public, pg_temp;
alter function public.touch_angle_jobs_updated_at() set search_path = public, pg_temp;
alter function public.touch_upscale_jobs_updated_at() set search_path = public, pg_temp;
alter function public.mark_generation_jobs_processing_started() set search_path = public, pg_temp;

-- 旧 GPU ウォーム延長（2026-09-12 廃止）のテーブルに、ログインした誰でも全行を書き換えられるポリシーが残っていた。
-- 今は書き込むのはサーバー側（service_role は RLS を通らない）だけなので、ポリシーごと外す。
drop policy if exists "Allow authenticated update to gpu_warm_status" on public.gpu_warm_status;

notify pgrst, 'reload schema';
