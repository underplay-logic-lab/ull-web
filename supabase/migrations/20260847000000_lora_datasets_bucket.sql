-- LoRA Studio: a private Storage bucket for training datasets. The browser
-- uploads images straight here (bypassing Vercel's 4.5 MB request body cap),
-- then only the resulting object paths are POSTed to /api/studio/lora/train.
-- The Modal worker downloads them back out with the service-role key.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lora_datasets',
  'lora_datasets',
  false,
  52428800, -- 50 MB per image
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Every object lives under "<user_id>/<dataset_id>/<file>". Users may only
-- touch their own top-level folder; the service role (Modal worker) bypasses
-- RLS entirely.
drop policy if exists "lora_datasets insert own" on storage.objects;
create policy "lora_datasets insert own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'lora_datasets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "lora_datasets select own" on storage.objects;
create policy "lora_datasets select own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'lora_datasets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "lora_datasets delete own" on storage.objects;
create policy "lora_datasets delete own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'lora_datasets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
