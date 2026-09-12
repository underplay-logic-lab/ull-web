-- 動画超解像を「入力×倍率」から「HD/2K/4K の絶対解像度プリセット」に変更。
-- 解像度が上がるほど実処理コスト（VRAM・時間）が増えるのに、旧版は
-- フレーム数だけで課金しており解像度差が反映されていなかった欠陥を修正する。
-- src/lib/pricing/knobDefaults.ts の KNOB_META と同期。

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('upscale_video_mult_res_2k', 2.25, '動画超解像 2Kプリセット係数', 'feature_credits', '×', '2Kプリセット選択時にper_frameへ掛ける係数（HD=1.0基準）', true),
  ('upscale_video_mult_res_4k', 2.9,  '動画超解像 4Kプリセット係数', 'feature_credits', '×', '4Kプリセット選択時にper_frameへ掛ける係数（HD=1.0基準）', true)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
