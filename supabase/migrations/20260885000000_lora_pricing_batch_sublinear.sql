-- LoRA 課金: 実効バッチを「所要秒に正比例」から外す（2026-09-20）。
--
-- 旧: s/it = 基準値 × 解像度係数 × 実効バッチ
-- 新: s/it = 基準値 × 解像度係数 × ((1 - m) + m × 実効バッチ)   m = この knob
--
-- 実測（docs/gpu-benchmarks.md §14.7、minimax_h3 / B300 / 1024px）:
--   実効バッチ1 / rank32 → 0.2135 s/it（1画像あたり 0.213秒）
--   実効バッチ4 / rank64 → 0.485  s/it（1画像あたり 0.121秒）
-- バッチも rank も上げているのに1画像あたりはむしろ速い。バッチ1のとき GPU
-- 使用率が平均 1.8%（§14.2）で遊んでいるため、まとめても時間がほぼ増えない。
-- 正比例のままではバッチを上げたジョブを最大で倍近く過大請求しており、
-- 品質に有利な設定へのペナルティにもなっていた。
--
-- m = 0.42 はこの2点を結んだ値（0.485 / 0.2135 = 2.272 = 1 + 3m）。
-- ⚠️ 2点のみ・条件も完全には揃っていない（バッチ1側は rank32 + compile 有効、
-- バッチ4側は rank64 + compile 無効）。どちらの差もバッチ4側を重く見せる向き
-- なので真の m は 0.42 より小さく、この値は過大請求側＝安全側に倒れている。
-- 同一条件でバッチだけ 1/2/4/8 と振った実測が出たら回帰で置き換えること。
--
-- 影響範囲: 実効バッチ > 1 になるのは生 YAML モードのジョブだけ（GUI モードの
-- _build_config は batch_size / gradient_accumulation_steps とも 1 固定）。
-- バッチ1のジョブの価格は 1 円も動かない（係数が厳密に 1.0 になるため）。
--
-- ⚠️ 式そのものは src/lib/pricing/loraRuntime.ts にあり、この SQL には含まれない。
-- **Vercel デプロイを先に、この SQL を後に**当てること（既定値 0.42 はコード側に
-- 入れてあるので、行が無い間もコードは新式で動く）。
-- 課金（loraPricing.ts）と損切り（pricing/costGuard.server.ts）は同じ見積もり
-- 関数を通るので、許容GPU秒も自動で同じ方向へ動く。

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('lora_batch_marginal_ratio', 0.42, 'LoRA 実効バッチの限界比率', 'lora_formula', '×',
   '1ステップのうち実効バッチに比例する割合。1.0で正比例（旧挙動）、0でバッチを上げても所要秒が変わらない。', true)
on conflict (key) do nothing;

-- ------------------------------------------------------------------------
-- 併せて: lora_prep_dequant_s を実測配分値（270）へ揃える。
--
-- 本番DBには 570 が入ったままだった（2026-09-19 17:25 UTC 時点の行）。570 は
-- 実測前のドラフトの見立てで、20260883 が 270 を入れようとしたものの
-- `on conflict (key) do nothing` だったため上書きされずに残っていた。
--
-- 実測（docs/gpu-benchmarks.md §14.3、サンプル生成なし＝現行の本番設定）では
-- minimax_h3 の prep 合計が 551秒。コード側はこれを
--   lora_prep_load_s (280) + lora_prep_dequant_s (270) = 550秒
-- と配分している。DB の 570 だと合計 850秒となり、**実測より300秒多く**
-- 見積もることになる（minimax_h3 のジョブで約 169C ≒ ¥280 の過大請求）。
--
-- 配分そのものに意味は無く（単独では実測していない）、効くのは合計値。
-- ⚠️ 同種の取り残しを防ぐため、既存キーの値を動かしたいときは
-- `on conflict do nothing` ではなく明示的な update を書くこと。

update public.pricing_knobs
set value = 270,
    updated_at = now()
where key = 'lora_prep_dequant_s';
