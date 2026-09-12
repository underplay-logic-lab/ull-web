-- 動画アップスケール v1（最小スコープ: 単一動画・倍率×2固定・カスケードなし）。
--
-- 既存の upscale_jobs テーブル / upscale-results バケットを画像・動画で
-- 共用する。media_type で判別し、modal_seedvr2_worker.py の
-- run_upscale_video_job が動画用フィールド（in_duration / in_fps /
-- in_frame_count / has_audio 等）を metadata に書く。

alter table public.upscale_jobs
  add column if not exists media_type text not null default 'image'
    check (media_type in ('image', 'video'));

-- 動画は画像よりずっと大きくなりうる（6秒 720p 級で数十MB）ので mime と
-- サイズ上限を拡張する。バケット自体は画像と共用（14日自動パージも共通）。
update storage.buckets
  set file_size_limit = 314572800, -- 300MB
      allowed_mime_types = array['image/png', 'image/webp', 'image/jpeg', 'video/mp4']
  where id = 'upscale-results';

-- 動画アップスケールの pricing_knobs（src/lib/pricing/knobDefaults.ts の
-- KNOB_META と同期）。値は実測前の保守的初期値 — GPU 実測後に admin の
-- Pricing タブから調整する想定。
insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('upscale_video_per_frame',         2,   '動画超解像（1フレームあたり）',            'feature_credits', 'C/frame', '出力フレーム数あたりの消費クレジット（× モデル係数）',             true),
  ('upscale_video_min_credits',       20,  '動画超解像 最低クレジット',                'feature_credits', 'C',       '1本あたりの消費クレジット下限（コールドスタート償却）',             true),
  ('upscale_video_time_per_credit_s', 6,   '動画超解像 損切り：1C あたり猶予秒',       'cost_guard',      's/C',     'max_allowed_time = 消費C × これ + コールドスタート猶予',           false),
  ('upscale_video_cold_start_grace_s',240, '動画超解像 損切り：コールドスタート猶予',   'cost_guard',      's',       'ComfyUI起動+SeedVR2重みロード+VHSノード初回実行の固定猶予',        false)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
