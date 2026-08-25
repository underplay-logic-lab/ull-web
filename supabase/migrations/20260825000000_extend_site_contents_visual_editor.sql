-- Extends site_contents with the additional keys the Visual Inline Editor's
-- media/link editing and section reordering need. No schema change: these
-- are just new rows in the existing key/value table (value stays TEXT —
-- page_sections_order stores a small JSON array as a string, parsed by
-- src/lib/siteContents.ts's parsePageSectionsOrder()).
insert into public.site_contents (key, value, section, label) values
  ('hero_cta_primary_href', '#studio', 'hero', 'メインCTAリンク先'),
  ('hero_cta_secondary_href', '#products', 'hero', 'サブCTAリンク先'),
  ('hero_visual_url', '', 'hero', 'ヒーロービジュアル画像URL（空欄で非表示）'),
  ('page_sections_order', '[{"id":"hero","visible":true},{"id":"studio","visible":true},{"id":"pricing","visible":true},{"id":"products","visible":true},{"id":"contact","visible":true},{"id":"articles","visible":false}]', 'general', 'トップページのセクション表示順序（JSON、Visual Editor管理用）')
on conflict (key) do nothing;
