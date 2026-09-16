-- 動画超解像の課金式を「固定費+わずかなフレーム比例分」へ修正する
-- （2026-09-17、ホスト指摘で発覚: 15秒HD動画で実コスト$0.16に対し課金
-- $10.00・約62倍のマークアップという実態を確認）。
--
-- 旧式（per_frame × frameCount × modelMult × resMult）は完全比例課金
-- だったが、動画超解像のVRAM・処理時間はフレーム数にほぼ依存しない
-- （modal_seedvr2_worker.py 内の実測コメント参照: 48f=17.8GB〜
-- 1800f=19.2GBとほぼ横ばい）。固定オーバーヘッド（モデルロード等）を
-- 新設の upscale_video_base_credits（HD基準28C、既存のmult_res_2k/4kが
-- 乗算される）へ切り出し、upscale_video_per_frame は限界費用分のみの
-- 小さい値（0.05C/frame）へ大幅減額する。
--
-- コード側SSOT（src/lib/pricing/knobDefaults.ts）は同時に更新済み。

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public)
values (
  'upscale_video_base_credits',
  28,
  '動画超解像（固定費・HD基準）',
  'feature_credits',
  'C',
  'モデルロード等の固定オーバーヘッド分（HD基準、他プリセットはmult_res_2k/4kが乗る）',
  true
)
on conflict (key) do update
  set value = excluded.value,
      label = excluded.label,
      description = excluded.description,
      updated_at = now();

update public.pricing_knobs
set value = 0.05,
    label = '動画超解像（1フレームあたり・限界費用分）',
    description = '出力フレーム数あたりの追加消費クレジット（固定費に対するわずかな上乗せ、× モデル係数）',
    updated_at = now()
where key = 'upscale_video_per_frame';
