-- 超解像（画像・動画・バッチ）: 入力ファイルをブラウザから直接ここへ
-- アップロードし（Vercel サーバーレス関数のリクエストボディ上限 約4.5MB を
-- 回避 — CLAUDE.md §6 参照）、API route には storage path だけを渡す。
-- lora_datasets バケットと同じ設計（20260847000000_lora_datasets_bucket.sql）。
-- Modal worker 側の実処理上限（動画: 60秒/1800フレーム、画像: 75MP 等）が
-- 実質的な上限になるため、バケット自体の file_size_limit は緩めに取る。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'upscale-uploads',
  'upscale-uploads',
  false,
  524288000, -- 500 MB
  array['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'video/mp4', 'video/quicktime']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 全オブジェクトは "<user_id>/<uuid>-<filename>" の下に置く。ユーザーは
-- 自分のフォルダのみ触れる。サービスロール（Modal worker / Next server）は
-- RLS を完全にバイパスする。

drop policy if exists "upscale_uploads insert own" on storage.objects;
create policy "upscale_uploads insert own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'upscale-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "upscale_uploads select own" on storage.objects;
create policy "upscale_uploads select own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'upscale-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "upscale_uploads delete own" on storage.objects;
create policy "upscale_uploads delete own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'upscale-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
