-- LoRA 課金 knob を 2026-09-20 の実機計測へ差し替える。
--
-- 計測: modal_lora_benchmark.py の smoke プラン
--   minimax_h3 / B300 / 1024px / rank32 / batch1 / prodigy /
--   gradient_checkpointing 無効 / torch.compile 有効 / 画像8枚 / 40step
--
-- 判明したこと:
--
-- 1. s/it は 0.2329（コード側 LORA_SPI_BASELINE を差し替え済み）。
--    旧値 5.0 は **it/s を s/it と取り違えた値**で 21 倍の過大評価だった。
--    docs/gpu-benchmarks.md §5 の 2026-09-06 計測（compile 5.0-5.4 it/s）が
--    正しかったことが確認された。
--
-- 2. コストは学習ステップではなく **固定費が支配的**。全体 1,404.5 秒のうち
--    学習本体は約9秒で、残り約1,395秒が固定費（int8/nvfp4 の逆量子化 約570秒、
--    torch.compile ウォームアップ、学習前後のサンプル生成、モデル/VAE ロード）。
--    GPU 使用率の平均は 1.8% で、B300 の時間のほとんどは GPU が遊んでいる。
--
-- 3. latent キャッシュの「1枚あたり」は 0.14 秒程度。8枚で合計51秒だが、その
--    うち約50秒は1枚目に集中する固定費（VAE ロード）で、限界費用ではない。
--    旧暫定値 20 s/枚 は100倍以上の過大評価だった。
--
-- 4. peak VRAM は 107.36GB。**RTX PRO 6000(96GB) には 1024px で載らない。**
--
-- 価格水準は据え置き（代表ジョブ 545C のまま）。計測の修正が黙って値段を
-- 動かさないよう、単価 knob 側で相殺してある。原価3倍の設計目標に合わせるなら
-- lora_credits_per_gpu_second を 0.5648 にする（代表ジョブ 545C -> 947C）が、
-- 固定費の削減（学習前後のサンプル生成の停止など）とセットで判断すること。

-- 5. 学習中のサンプル画像生成（学習前のベースライン1枚＋学習後の最終1枚）を
--    停止した（ホスト判断「使ったことがない」）。2回目の smoke で効果を実測:
--    全体 1,404.5秒 -> 559.9秒、固定費 1,395秒 -> 551秒（-844秒・60%削減）。
--    B300 換算で ¥264/ジョブ。s/it も 0.2329 -> 0.2135 で再現した。
--    ⚠️ ワーカー側の変更（modal_lora_worker.py の disable_sampling /
--    skip_first_sample）は **modal deploy して初めて本番に効く**。
--
-- 固定費 551 秒を、逆量子化ぶん（minimax_h3 固有）と共通ぶんに分けて持つ。
-- 分けずに全 arch へ当てると、逆量子化を持たない画像系 arch を過大請求する。
-- ⚠️ 270/280 の配分は1回目のログからの見積もりで、合計 550 秒の方が実測。
update public.pricing_knobs
set value = 280,
    label = 'LoRA 準備時間（固定分・ai-toolkit）',
    description = 'モデル/VAE ロード・torch.compile ウォームアップ・保存処理等、枚数にも step 数にも依らない固定オーバーヘッド。',
    updated_at = now()
where key = 'lora_prep_load_s';

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('lora_prep_dequant_s', 270, 'LoRA 準備時間（逆量子化ぶん）', 'lora_formula', 's', '量子化配布された重み（現状 minimax_h3 のみ）をロード時に full precision へ戻すコスト。該当 arch にのみ加算。', true)
on conflict (key) do nothing;

update public.pricing_knobs
set value = 0.15,
    description = 'latent キャッシュのうちデータセット枚数に比例する分（限界費用）',
    updated_at = now()
where key = 'lora_prep_per_image_s';

-- 単価は原価ベース（3倍markup）へ統一（ホスト判断）。
--   B300 ¥1,125/h = ¥0.3125/GPU秒 × 3.0 ÷ credit_to_jpy 1.66 = 0.5648 C/GPU秒
-- サンプル生成の停止で固定費を60%削れたぶんを、そのまま値下げとして出す形。
-- 代表ジョブ（minimax_h3 / 1024px / 画像30枚 / 1210step）は 545C -> 459C。
-- fal の Wan2.2 動画LoRA trainer 比で 2000step -23% / 3000step -38%。
update public.pricing_knobs
set value = 0.5648,
    updated_at = now()
where key = 'lora_credits_per_gpu_second';

update public.pricing_knobs
set value = 0.0911,
    updated_at = now()
where key = 'lora_credits_per_gpu_second_sdxl';

-- sd-scripts ワーカーは逆量子化も torch.compile も持たないので固定費の桁が
-- 違う。ai-toolkit 側の 1390 を当てると SDXL ジョブを数倍に過大請求するため
-- 分離する。⚠️ 値自体は未実測の暫定。
insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('lora_prep_load_s_sdxl', 300, 'LoRA 準備時間（固定分・sd-scripts / SDXL）', 'lora_formula', 's', 'SDXL系（sd-scripts ワーカー）の固定オーバーヘッド。⚠️未実測の暫定値。', true)
on conflict (key) do nothing;

-- 未知 arch（ユーザーのカスタムモデル）のフォールバック s/it。2.5 は
-- LORA_SPI_BASELINE が旧スケールだった頃の値で、テーブルを実測値
-- （0.051〜0.233）へ入れ替えた際に取り残されていた。そのままだと未知 arch が
-- 最も重い minimax_h3 の10倍の s/it で見積もられる。既知で最も重い 0.233 を
-- やや上回る 0.3 とし、過小請求側ではなく過大側へ倒す。
update public.pricing_knobs
set value = 0.3,
    updated_at = now()
where key = 'lora_spi_baseline_default';

-- 損切りの arch-floor が課金と同じ見積もり関数を通すようになり、「純学習時間に
-- 一律で足す下駄」という概念が無くなったため廃止。行は残置。
update public.pricing_knobs
set label = 'LoRA 損切り：prep 下駄秒（廃止・未使用）',
    description = '（廃止）prep は lora_prep_* knob で明示的に見積もるようになった。',
    is_public = false,
    updated_at = now()
where key = 'lora_floor_prep_s';
