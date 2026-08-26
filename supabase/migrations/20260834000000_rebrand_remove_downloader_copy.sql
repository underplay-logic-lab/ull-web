-- Rebrand cleanup: drops the individual/freelance-dev voice ("受託",
-- "特注ワークフロー...") from the public-facing copy in favor of a
-- straight SaaS support tone, and removes every remaining trace of the
-- retired "Model Downloader" product (Products.tsx / DownloadButton.tsx
-- were deleted from the app — nothing renders these keys anymore).
update public.site_contents
  set value = '最新モデルをクラウドGPUで高速生成。新規登録で今すぐ10クレジット無料進呈。'
  where key = 'hero_subtitle';

update public.site_contents
  set value = '© 2026 ULL Studio. Powered by Underplay Logic Engine.'
  where key = 'footer_copyright';

-- The secondary Hero CTA ("ツールをダウンロード") existed solely to link to
-- the now-removed Products/downloader section — nothing left to configure.
delete from public.site_contents where key in ('hero_cta_secondary', 'hero_cta_secondary_href');
