-- 2026-09-24: Gemini（有料枠）の利用トークンを機能・ユーザー・モデル別に残す。
--
-- 目的: LoRA のキャプション解析などの AI 原価が 1 データセットあたりいくらかを出し、
-- LoRA の価格式（推定GPU秒）に入れるべきかを判断する。円換算はしない（単価はモデルと
-- 時期で変わるので、集計時に Google の料金表を当てる）。
-- 書き込みは src/lib/geminiText.ts の recordGeminiUsage（service_role）だけ。
-- クライアントからは読ませない（anon / authenticated には付与しない）。

create table if not exists public.ai_usage_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid,
  feature text not null,
  model text not null,
  prompt_tokens integer,
  output_tokens integer,
  thought_tokens integer,
  total_tokens integer,
  images integer
);

create index if not exists ai_usage_logs_created_at_idx on public.ai_usage_logs (created_at desc);
create index if not exists ai_usage_logs_user_created_idx on public.ai_usage_logs (user_id, created_at desc);

alter table public.ai_usage_logs enable row level security;

-- 2026-10-30 以降、Supabase は新規テーブルへ Data API の権限を自動付与しない（CLAUDE.md §4）。
grant select, insert, update, delete on public.ai_usage_logs to service_role;
