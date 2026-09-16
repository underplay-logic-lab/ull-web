-- 動画超解像の課金式を、本番実ジョブの実測2点（L40S・HDプリセット、
-- 72frame/210.86s と 362frame/941.82s）から再校正する（2026-09-17）。
--
-- 前回の修正（20260875000000）は72frame単発テストのみから「フレーム数は
-- VRAM・時間にほぼ無関係」と一般化していたが、これはB300ドキュメント由来
-- （計算力に余裕があるGPU限定）の性質で、非力なL40Sには成り立たなかった。
-- 実際に本番で362frameのHDジョブを流したところ実測941.82sとなり、2点から
-- 逆算するとL40Sの真の限界費用は2.52s/frame——0.3s/frame想定の8.4倍重い。
--
-- 2点回帰: 固定費29.38s・限界費用2.52s/frame
-- → credit_to_jpy(1.66)/usd_jpy(150)/3倍markup換算で
--   upscale_video_base_credits = 4.31C
--   upscale_video_per_frame    = 0.37C/frame
--
-- ⚠️ 2K(H200)/4K(B300)は72frame単発データしかなく、長尺でも同様の傾向か
-- 未検証（コード側SSOT knobDefaults.ts のコメント参照）。既存の
-- upscale_video_mult_res_2k/_4k はそのまま維持する。

update public.pricing_knobs
set value = 4.31,
    updated_at = now()
where key = 'upscale_video_base_credits';

update public.pricing_knobs
set value = 0.37,
    updated_at = now()
where key = 'upscale_video_per_frame';
