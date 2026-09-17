-- 動画超解像のGPU tier切り替え（HD: L40S→RTX PRO 6000、2K: H200→RTX PRO
-- 6000。4KはB300のまま）に伴い、課金式を再校正する（2026-09-17）。
--
-- 背景: HD/2Kとも全GPU横断の実機比較（短尺74frame・長尺362frame両方）で、
-- RTX PRO 6000がL40S/H200より「速くて1回あたり実コストが安い」と確認でき
-- たため、両プリセットの採用GPUをRTX PRO 6000に統一した（コード側は
-- modal_seedvr2_worker.py の UPSCALE_VIDEO_PRESET_GPU 参照）。
--
-- HD係数（RTX PRO 6000実測2点、74frame/114.92s・362frame/488.84s、$3.03/h）:
-- 線形回帰で固定費18.84s・限界費用1.298s/frame
-- → credit_to_jpy(1.66)/usd_jpy(150)/3倍markup換算で
--   upscale_video_base_credits = 4.30C（旧4.31Cとほぼ同値）
--   upscale_video_per_frame    = 0.30C/frame（旧0.37Cから19%減）
--
-- 2K係数（74frame基準、HD/2Kとも同一GPUになったため実コスト比で再計算）:
--   HD(74frame)≈26.2C・2K(74frame)≈55.0C → upscale_video_mult_res_2k = 2.10
--   （旧2.44はHD=L40S/2K=H200という異なるGPU前提だった）
--
-- 4K係数（HD側が安くなった影響で相対倍率が上昇。4K自体の実測は変更なし）:
--   HD(72frame)≈25.6C・4K(72frame,B300)≈154.3C → upscale_video_mult_res_4k = 6.02
--   （旧4.98はHD側がL40Sだった頃の比率）
--
-- ⚠️ HD/2Kは2点データからの線形回帰、4Kは72frame単発データのみで長尺再現性
-- 未検証（コード側SSOT knobDefaults.ts のコメント参照）。

update public.pricing_knobs
set value = 4.30,
    updated_at = now()
where key = 'upscale_video_base_credits';

update public.pricing_knobs
set value = 0.30,
    updated_at = now()
where key = 'upscale_video_per_frame';

update public.pricing_knobs
set value = 2.10,
    updated_at = now()
where key = 'upscale_video_mult_res_2k';

update public.pricing_knobs
set value = 6.02,
    updated_at = now()
where key = 'upscale_video_mult_res_4k';
