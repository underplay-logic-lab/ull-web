-- Cinematic Director の生成動画が Storage に一切永続化されていなかった欠陥を
-- 修正。run_custom_workflow の async パスは video_url に base64 を直接埋め込む
-- だけで（"videos are never durably stored server-side" という旧
-- CinematicVideoTab.tsx 時代の注意書きに合わせた名残）、custom-workflow-results
-- と同じ「アップロード失敗しない限り Storage が正」という頑健な形になって
-- いなかった。angle-results / upscale-results / custom-workflow-results と
-- 同じ形の公開バケットを新設し、director-results として 14日自動パージ
-- （modal_retention_purge.py の DEFAULT_BUCKETS）の対象に含める。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'director-results',
  'director-results',
  true,
  104857600, -- 100MB（動画出力、upscale-results/custom-workflow-results と同じ上限）
  array['video/mp4']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Modal のサービスロールが直接アップロードするので、angle-results/
-- upscale-results と同様に書き込み用の authenticated ポリシーは不要
-- （サービスロールのみ書き込み、公開URLとして誰でも閲覧可）。

notify pgrst, 'reload schema';
