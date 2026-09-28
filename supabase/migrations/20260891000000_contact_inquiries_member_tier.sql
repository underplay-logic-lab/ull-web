-- 会員特典「リクエスト・技術的なご相談の受付（上位プランから優先して検討）」（2026-09-28 ホスト判断）。
-- ログイン中に /api/contact から送られた問い合わせに、送信者と送信時点のプランを残す。admin の「問い合わせ」
-- タブはこの member_tier の高い順 → 新しい順に並べる。handled_at は対応済みの印（admin が付け外しする）。
-- 既存テーブルへの列追加なので GRANT は不要（service_role のみのポリシーのまま。PII を含むため anon/authenticated には出さない）。
alter table public.contact_inquiries
  add column if not exists user_id uuid references auth.users (id) on delete set null,
  add column if not exists member_tier text,
  add column if not exists handled_at timestamptz;

create index if not exists contact_inquiries_open_idx
  on public.contact_inquiries (handled_at, created_at desc);
