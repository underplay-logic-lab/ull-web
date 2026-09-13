-- 特化ワークフロー（custom-workflows）の生成物が一切永続化されていなかった
-- 欠陥を修正。/api/studio/custom-workflows/generate は同期処理でブラウザへ
-- base64を返すだけで、Multi-Angle/超解像と違いサーバー側に何も残していな
-- かった（ユーザーがダウンロードし忘れると復元不能）。angle-results /
-- upscale-results と同じ形の公開バケットを新設し、生成成功時にアップロード
-- する（route.ts側で実施）。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'custom-workflow-results',
  'custom-workflow-results',
  true,
  104857600, -- 100MB（動画出力もあるため upscale-results 同様の上限）
  array['image/png', 'image/webp', 'image/jpeg', 'video/mp4', 'video/webm']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Modal 経由ではなく Next.js の service role が直接アップロードするので、
-- 書き込み用の authenticated ポリシーは不要（angle-results/upscale-results
-- と同じ運用: サービスロールのみ書き込み、公開URLとして誰でも閲覧可）。

notify pgrst, 'reload schema';
