-- Angle 損切り猶予（angle_cold_start_grace_s）を 300 → 600 に引き上げ。
--
-- コールドコンテナの初回 forward は Qwen-Image-Edit-2511 の RoPE 複素演算が
-- Inductor 非対応で eager フォールバックし、B300 でも ~500s かかる（一過性）。
-- 旧 300s だとコールドスタートに当たった大きめのジョブが 1 枚も生成しない
-- うちに cost-guard で損切り自爆しうるため、固定猶予を 600s に広げる。
-- コード側 SSOT は src/lib/pricing/knobDefaults.ts の angle_cold_start_grace_s。
-- 既に管理画面で手動変更済みの場合は上書きしない（value が 300 のときだけ更新）。

update public.pricing_knobs
   set value = 600,
       description = 'コンテナ起動 + モデルロード + 初回 forward warmup の固定猶予'
 where key = 'angle_cold_start_grace_s'
   and value = 300;
