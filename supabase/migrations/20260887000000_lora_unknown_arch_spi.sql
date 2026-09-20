-- 未知 arch（ユーザーのカスタムモデル）の s/it を 0.3 → 0.65 へ（2026-09-20 夜）。
--
-- この knob の設計意図は「既知で最も重い arch をやや上回る値を置き、未知の
-- モデルは過小請求・損切りの早撃ちより過大側へ倒す」というもの。0.3 は
-- LORA_SPI_BASELINE の最重量が minimax_h3 = 0.233 だった頃の値だった。
--
-- 20260886 で計測バグを是正し minimax_h3 が 0.55 になった結果、**未知の arch が
-- 既知で最も重いものより安く見積もられる**という逆転が起きていた。カスタム
-- モデルは最も予測がつかない相手なので、元の意図どおり上回る値に戻す。
--
-- コード側の既定値（src/lib/pricing/knobDefaults.ts、および
-- modal_lora_worker.py の LORA_SPI_BASELINE_DEFAULT）も同値に揃えてある。

update public.pricing_knobs
set value = 0.65,
    updated_at = now()
where key = 'lora_spi_baseline_default';
