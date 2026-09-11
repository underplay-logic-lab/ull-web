-- 超解像スタジオ: 倍率ラダーを ×2/×3/×4/8K → ×2/×4/×8（2の冪のみ）に再編し、
-- ×4/×8 を内部で ×2 刻みの多段カスケード（SeedVR2 を複数回通す）にする。
--
-- - ×3 と絶対プリセット「8K」は廃止（upscale_jobs.preset は text 列のまま。
--   既存の 'x3' / '8k' 行があっても型は変わらないのでそのまま残る）。
-- - 理由: B300 実測（yukipas.png, 2026-09-11）で「単発直行よりカスケードの
--   方が高画質」と確認済み。カスケードは前段の出力をそのまま次段の入力に
--   使うため、2の冪の倍率でないと段が綺麗に割れない（×3 は ×2 の繰り返しで
--   作れない）。ローンチ前で ×3 の実利用データも無いため、単純なラダーに
--   倒した。
-- - 新 knob: カスケードで伸びる実 GPU 秒をクレジットに反映する係数。
--   upscale_cascade_mult_2stage（×4 モード = ×2→×4 の2段、既定1.3）
--   upscale_cascade_mult_3stage（×8 モード = ×2→×4→×8 の3段、既定1.5。
--   B300 実測: 単発108.77s vs カスケード157.46s = 1.45倍、少し余裕を見た）。
--   src/lib/pricing/knobDefaults.ts の KNOB_META と同期。

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('upscale_cascade_mult_2stage', 1.3, '超解像 カスケード係数（2段）', 'feature_credits', '×',
   '×4 モード（×2→×4 の2段カスケード）に乗せる追加係数。', true),
  ('upscale_cascade_mult_3stage', 1.5, '超解像 カスケード係数（3段）', 'feature_credits', '×',
   '×8 モード（×2→×4→×8 の3段カスケード）に乗せる追加係数。', true)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
