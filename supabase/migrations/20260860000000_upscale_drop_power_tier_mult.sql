-- 超解像スタジオ: 8K パワーティア係数（upscale_mult_power）を撤廃。
--
-- 8K も倍率モード(×2〜4)も同じ純 MP 課金（per_mp × 出力MP × モデル係数）に
-- 統一。純 MP 課金がすでに「大きい出力ほど高い」を実現しており、8K だけの
-- ×1.5 上乗せは実効倍率（入力サイズ次第で 8K が ×4.7 相当のこともある）と
-- 釣り合わなかった。src/lib/pricing/knobDefaults.ts と同期。
--
-- あわせて B300 実測でノンタイル上限を再確認（27MP=85GB / 61MP=189GB /
-- 79MP=244GB OK / 109MP=OOM）→ フロントの UPSCALE_MAX_OUTPUT_MP を 45→75 に
-- 引き上げ（コード側のみ・DB 変更なし）。

update public.pricing_knobs
   set value = 1.0,
       label = '超解像 パワーティア係数（廃止・未使用）',
       description = '（廃止）8K も倍率モードも純 MP 課金。この値は使われない。',
       is_public = false
 where key = 'upscale_mult_power';

notify pgrst, 'reload schema';
