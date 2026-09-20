-- LoRA 価格を GUI 既定条件の実測へ合わせる（2026-09-20 夜・3回目）。
--
-- これまでの値は「実効バッチ4 / torch.compile 無効」で測ったランからの逆算
-- （docs/gpu-benchmarks.md §14.13 / §14.14）だった。GUI モードが実際に使う
-- 構成は **実効バッチ1 / gradient_checkpointing 無効 / compile 有効** なので、
-- その条件そのままで本番ランを回して直接実測した（docs §14.15）。
--
--   s/it        : 0.90（逆算） -> **1.80**（実測。3経路一致）
--   prep 固定分 : 740（470+270） -> **1,098**（model load 621.5 + first-step
--                 JIT/compile 476.9）。compile 有効だと first-step が §14.13 の
--                 99.1s から 476.9s へ激増し、そのぶんが式に無かった。
--   latent/枚   : 0.9 -> **1.33**（174.4s / 131枚）
--
-- 合成データのベンチ（modal_lora_benchmark.py）は同条件で 0.20 s/it と出て
-- 実写と **9倍** ずれたため、値付けの根拠には採用していない。
--
-- 影響: 代表ジョブ（minimax_h3 / 2000step / 131枚）が 1,502C -> 2,752C（1.83倍）。
-- 実原価に対する markup はちょうど 3.0 倍で、CLAUDE.md §3 の方針どおりになる。
-- 旧価格は実所要の 55% しか請求できておらず、原価割れ方向にずれていた。
--
-- 未知 arch のフォールバック（lora_spi_baseline_default）は「既知で最も重い
-- arch をやや上回る」という設計意図を保つため 0.65 -> 2.0。minimax_h3 が
-- 1.80 になり、20260887 で直したはずの逆転が再発していた。
--
-- コード側の既定値（src/lib/pricing/knobDefaults.ts、loraRuntime.ts の
-- LORA_SPI_BASELINE、modal_lora_worker.py の同名テーブルと
-- LORA_SPI_BASELINE_DEFAULT）も同値に揃えてある。

update public.pricing_knobs
set value = 828,
    updated_at = now()
where key = 'lora_prep_load_s';

update public.pricing_knobs
set value = 1.33,
    updated_at = now()
where key = 'lora_prep_per_image_s';

update public.pricing_knobs
set value = 2.0,
    updated_at = now()
where key = 'lora_spi_baseline_default';
