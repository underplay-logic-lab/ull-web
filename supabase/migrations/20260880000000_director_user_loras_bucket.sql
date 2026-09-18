-- ULL Cinematic Director: ユーザーが外部で用意した MiniMax H3 LoRA
-- (.safetensors) を持ち込んで適用できるようにする（2026-09-18、ホスト要望
-- ——LoRA Studio 学習済みLoRAは 14日で自動パージされる（CLAUDE.md §3）が、
-- 外部から持ち込むLoRAは「生成物」ではなく参照画像と同じ「入力データ」
-- なので、そもそもそのポリシーの対象外にし、期限を設けない）。
--
-- lora_datasets / upscale-uploads バケットと同じ設計。.safetensors は
-- ブラウザ上で標準MIMEタイプを持たないため application/octet-stream で
-- アップロードされる想定。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'director-user-loras',
  'director-user-loras',
  false,
  2147483648, -- 2GB（MiniMax H3 LoRAの想定サイズに余裕を持たせた上限）
  array['application/octet-stream']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 全オブジェクトは "<user_id>/<uuid>-<filename>" の下に置く。ユーザーは
-- 自分のフォルダのみ触れる。サービスロール（Next server / Modal worker）は
-- RLS を完全にバイパスする。

drop policy if exists "director_user_loras insert own" on storage.objects;
create policy "director_user_loras insert own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'director-user-loras'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "director_user_loras select own" on storage.objects;
create policy "director_user_loras select own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'director-user-loras'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "director_user_loras delete own" on storage.objects;
create policy "director_user_loras delete own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'director-user-loras'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

notify pgrst, 'reload schema';
