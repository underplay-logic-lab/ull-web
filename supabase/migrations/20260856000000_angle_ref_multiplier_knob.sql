-- Multi-Angle Studio Pro（複数参照画像）の課金係数を pricing_knobs に追加。
--
-- サブ参照画像 1 枚ごとに Qwen-Image-Edit-2511 の条件トークンが増え、B300 実測で
-- 1 構図の生成時間が線形に伸びる（サブ3枚 = per-step 463ms→1373ms ≈ ×3.0）。
-- per-構図 の消費クレジットにも同じ係数を乗せて原価割れを防ぐ:
--   1 構図単価 = ceil(angle_pro_per_angle × (1 + angle_ref_multiplier_per_sub × サブ枚数))
--
-- 既定 0.7（サブ3枚で係数 3.1、粗利 ~69% を維持）。/admin の Pricing タブで調整可。
-- コード側の SSOT は src/lib/pricing/knobDefaults.ts の KNOB_META。

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('angle_ref_multiplier_per_sub', 0.7, 'Multi-Angle サブ参照 加算係数', 'feature_credits', '×/枚', 'サブ参照1枚ごとに 1構図単価へ乗せる係数（係数 = 1 + これ×枚数）。0で無料。', true)
on conflict (key) do nothing;
