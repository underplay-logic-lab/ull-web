-- Admin-managed key/value store for editable marketing copy on the top
-- page (Hero, Studio section header/description, Pricing section header,
-- footer address). Unlike studio_presets/studio_pricing, this table is
-- read directly by anonymous/authenticated clients (RLS policy below) —
-- same rationale as studio_custom_workflows: no per-user data involved.
create table if not exists public.site_contents (
  key text primary key,
  value text not null,
  section text not null,
  label text not null,
  updated_at timestamptz not null default now()
);

create index if not exists site_contents_section_idx on public.site_contents (section);

alter table public.site_contents enable row level security;

-- Public, read-only: every row, to anon and authenticated alike.
create policy "Public can read all site contents"
  on public.site_contents
  for select
  to anon, authenticated
  using (true);

-- The service-role client (supabaseAdmin, used by every /api/admin/* route)
-- bypasses RLS entirely already; this policy just makes the intended access
-- model explicit rather than relying on that bypass alone.
create policy "Service role has full access to site contents"
  on public.site_contents
  for all
  to service_role
  using (true)
  with check (true);

-- Seed: the current hardcoded top-page copy, so the site's rendered output
-- is unchanged until an admin edits a row from /admin.
insert into public.site_contents (key, value, section, label) values
  ('hero_badge', 'AI Generation & Automation Lab', 'hero', 'バッジ文言'),
  ('hero_title_line1', 'スマホ・Mac・低スペックPCから', 'hero', 'メイン見出し 1行目'),
  ('hero_title_line2', 'ブラウザで手軽に動く', 'hero', 'メイン見出し 2行目'),
  ('hero_title_line3', '商用AI画像・動画生成スタジオ', 'hero', 'メイン見出し 3行目'),
  ('hero_subtitle', '最新モデルをクラウドGPUで高速生成。独自AI環境の構築受託・自動化相談も受付中。', 'hero', 'サブ見出し'),
  ('hero_signup_banner', '新規アカウント登録で即時10クレジット無料進呈（クレカ登録不要）', 'hero', '登録特典バナー'),
  ('hero_cta_primary', 'Studioを試す', 'hero', 'メインCTAボタン'),
  ('hero_cta_secondary', 'ツールをダウンロード', 'hero', 'サブCTAボタン'),
  ('studio_eyebrow', 'Studio', 'studio', 'セクションラベル'),
  ('studio_title', 'AI Generation Studio', 'studio', 'セクション見出し'),
  ('studio_desc_wan_animate', 'キャラクター画像とモーションを指定するだけ。Wan Animate 2 が高品質なアニメーション動画を生成します。', 'studio', '説明文（Wan Animate 2タブ）'),
  ('studio_desc_custom', '管理者が登録した専用ワークフローを選択し、必要な入力を指定するだけで実行できます。', 'studio', '説明文（特化ワークフロータブ）'),
  ('studio_desc_maintenance', '画像生成機能は現在メンテナンス中です。次期アップデートをお待ちください。', 'studio', '説明文（画像生成タブ）'),
  ('pricing_eyebrow', 'Pricing', 'pricing', 'セクションラベル'),
  ('pricing_title', '料金プラン', 'pricing', 'セクション見出し'),
  ('pricing_subtitle', '必要な分だけの都度チャージか、毎月クレジットが自動付与される月額プラン。', 'pricing', 'セクション説明文'),
  ('footer_address', '〒150-0043 東京都渋谷区道玄坂1丁目10番8号 渋谷道玄坂東急ビル2F−C', 'general', 'フッター住所'),
  ('footer_copyright', '© 2026 ULL (Underplay Logic Lab). All rights reserved.', 'general', 'コピーライト表記')
on conflict (key) do nothing;
