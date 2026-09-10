-- 超解像スタジオ: 倍率(×2/×3/×4) + 8K パワーティアへ再編。
--
-- - upscale_jobs.preset は id 文字列（'x2' | 'x3' | 'x4' | '8k'）を格納する
--   （型は text のまま。既存の '2k' 等の行はそのまま残る）。
-- - 新 knob upscale_mult_power（8K パワーティアの課金係数、既定 1.5）。
--   src/lib/pricing/knobDefaults.ts の KNOB_META と同期。
-- - upscale-results バケットの 1 ファイル上限を 50MB → 100MB へ
--   （8K PNG は ~31MB だが横長・別アスペクトで超えうる。worker は 25MB 超の
--   出力を WebP q92 へ再エンコードするが、保険として枠を広げる）。

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('upscale_mult_power', 1.5, '超解像 パワーティア係数（8K）', 'feature_credits', '×',
   '8K モードの 1構図単価に乗せる係数。倍率モード(×2〜4)は 1.0。', true)
on conflict (key) do nothing;

update storage.buckets
   set file_size_limit = 104857600
 where id = 'upscale-results'
   and file_size_limit < 104857600;

notify pgrst, 'reload schema';
