-- 人ごとの機能の許可（2026-10-09）。
--
-- 一般公開しない機能（顔入れ替えの「髪型ごと」・Qwen Image 2.1 のお試し枠・将来の法人機能など）を、
-- admin が指定した人にだけ開ける。行があれば許可（expires_at を過ぎたら無効）。admin（ADMIN_EMAILS）は行が無くても全部使える。
-- 機能の一覧はコード側（src/lib/features.ts）が正。ここでは feature を自由な文字列で持つ。
-- 判定はサーバー（service_role）が行う。利用者は自分の行だけ読める（タブの出し分け用）。書き込みは admin API だけ。

create table if not exists public.user_feature_grants (
  user_id uuid not null references public.profiles(id) on delete cascade,
  feature text not null,
  note text,
  granted_by text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, feature)
);

create index if not exists user_feature_grants_feature_idx on public.user_feature_grants (feature);

alter table public.user_feature_grants enable row level security;

drop policy if exists "user_feature_grants_select_own" on public.user_feature_grants;
create policy "user_feature_grants_select_own" on public.user_feature_grants
  for select to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on table public.user_feature_grants to service_role;
grant select on table public.user_feature_grants to authenticated;
