-- 動画超解像: プリセット別GPU tier導入（HD=L40S/2K=H200/4K=B300、
-- CLAUDE.md §1参照）に伴い、upscale_video_mult_res_2k / _4k を
-- GPU単価差込みの実測値へ更新する。
--
-- 旧値(2.25 / 2.9)はMP比のみを見ており、単一GPU(B300)前提の見積もりだった。
-- 実際はプリセットごとにGPU単価が異なる（HD: L40S $1.95/h, 2K: H200
-- $4.54/h, 4K: B300 $7.10/h）ため、2026-09-16/17の実機再計測
-- （同一入力・72フレーム・3秒）から算出した実コスト比に更新する:
--   HD: 210.86s @ $1.95/h = $0.1142
--   2K: 220.55s @ $4.54/h = $0.2782 -> HD比 2.44
--   4K: 288.53s @ $7.10/h = $0.5690 (12MP上限ケース) -> HD比 4.98
--
-- コード側SSOT（src/lib/pricing/knobDefaults.ts）は同時に更新済み。

update public.pricing_knobs
set value = 2.44,
    description = '2Kプリセット選択時にper_frameへ掛ける係数（HD=1.0基準、GPU単価差込み実測）',
    updated_at = now()
where key = 'upscale_video_mult_res_2k';

update public.pricing_knobs
set value = 4.98,
    description = '4Kプリセット選択時にper_frameへ掛ける係数（HD=1.0基準、GPU単価差込み実測）',
    updated_at = now()
where key = 'upscale_video_mult_res_4k';
