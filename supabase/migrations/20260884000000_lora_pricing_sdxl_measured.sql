-- SDXL（sd-scripts ワーカー）の課金 knob を実機計測へ差し替える（2026-09-20）。
--
-- 計測: modal_sdxl_lora_worker.py::smoke_test_sdxl_lora
--   L40S / 1024px / rank32 / prodigy / gradient_checkpointing 無効 / 画像5枚
--   step 数だけ変えた2回の実行から連立で prep と s/it を分離した:
--     elapsed(20step)  = 56.0 秒
--     elapsed(120step) = 120.2 秒
--     → s/it = (120.2-56.0)/(120-20) = 0.642
--       prep = 56.0 - 20×0.642       = 43.2 秒
--   peak VRAM は2回とも 17.73GB（L40S 48GB に対し 30GB の余裕）。
--   gradient_checkpointing を既定OFFにした変更が L40S で安全だと確認できた。
--
-- 旧値（s/it 1.4 / prep 300）はどちらも大きく外れていた。1.4 は 2026-09-15 の
-- スモーク（rank16・AdamW8bit・gradient_checkpointing 有効）由来で条件が違い、
-- prep 300 は完全な未実測の仮値だった。
--
-- ⚠️ s/it はコード側（src/lib/pricing/loraRuntime.ts の LORA_SPI_BASELINE と
-- modal_lora_worker.py の同名テーブル）にあり、このマイグレーションには
-- 含まれない。**Vercel デプロイを先に、この SQL を後に**当てること。
--
-- 価格方針（ホスト判断）: **値下げはしない。**
-- 推定秒が 1,998 → 824 と半分以下になったため、原価3倍（rate 0.1468）にすると
-- 代表ジョブが 183C → 122C と33%の値下げになる。SDXL は実測で fal の Flux
-- LoRA trainer（2000step ¥720〜1,500）に対し 2000step ¥292 と既に1/3以下で、
-- これ以上下げても競合比の見え方は変わらない。よって単価を上げて価格を据え置く
-- （824秒 × 0.222 ≒ 183C）。markup は約4.5倍で ai-toolkit 側（3.0倍）より厚いが、
-- 原価ではなく価値で取る形（CLAUDE.md §0）。

update public.pricing_knobs
set value = 45,
    description = 'SDXL系（sd-scripts ワーカー）の固定オーバーヘッド。2026-09-20 実測。',
    updated_at = now()
where key = 'lora_prep_load_s_sdxl';

update public.pricing_knobs
set value = 0.222,
    updated_at = now()
where key = 'lora_credits_per_gpu_second_sdxl';
