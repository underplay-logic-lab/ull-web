-- LoRA 課金: ベンチの s/it 計測バグを受けた是正（2026-09-20 夜）。
--
-- 何が起きていたか:
--   modal_lora_benchmark.py の s/it 計測は、ai-toolkit が1ステップにつき tqdm 行を
--   2本出すことを考慮しておらず、**同一時刻の2行の差**をステップ所要時間として
--   記録していた。実際に測れていたのは「ログ2行をパイプから読んで print する時間」。
--   0.213 / 0.485 / 0.688 という値はすべてこれで、学習時間ではない。
--   → ベンチ側は修正済み（_spi_from_samples・回帰テスト付き）。
--
-- 唯一信頼できる実測（本番フルラン、docs/gpu-benchmarks.md §14.13）:
--   minimax_h3 / B300 / 1024px / rank64 / 実効バッチ4 / adamw /
--   gradient_checkpointing 有効 / torch.compile 無効 / 実写131枚
--     s/it = 5.24（見積もり 0.688 の 7.6倍）
--     prep = 860.7秒（model load 640.6 / latent キャッシュ 120.9 / first-step JIT 99.1）
--   このジョブは 866C（¥1,439）の請求に対し完走時の実原価が ¥3,776 で、
--   cost-guard が70分で止めなければ ¥2,337 の赤字だった。
--
-- この SQL で直すのは prep とバッチ係数。s/it はコード側
-- （src/lib/pricing/loraRuntime.ts の LORA_SPI_BASELINE と
--  modal_lora_worker.py の同名テーブル）にあり、0.213 → 0.55 へ引き上げ済み。
-- **Vercel デプロイを先に、この SQL を後に**当てること。
--
-- 検算: 470 + 270 + 0.9 × 131枚 = 858秒（実測 860.7）。

-- prep の固定分。実測 model load 640.6 から逆量子化ぶん(270)を引き、
-- それまでモデル化していなかった first-step JIT(99.1) を足した値。
update public.pricing_knobs
set value = 470,
    description = 'コンテナ起動 + モデルロード + 初回ステップのJIT（枚数に依らない）。2026-09-20 本番実測。',
    updated_at = now()
where key = 'lora_prep_load_s';

-- latent キャッシュの枚数比例分。旧値 0.15 は合成データ8枚（全て同一アスペクト比
-- ＝1バケット）由来で、実写131枚の実測 0.92秒/枚 に対し6倍の過小評価だった。
update public.pricing_knobs
set value = 0.9,
    description = 'latent キャッシュのうちデータセット枚数に比例する分。2026-09-20 実写131枚で実測。',
    updated_at = now()
where key = 'lora_prep_per_image_s';

-- 実効バッチの係数を正比例（1.0）へ戻す。0.42 の根拠にしていた
-- 「バッチ1で0.213 / バッチ4で0.485」はどちらも上記バグによる偽の値だった。
-- バッチが所要秒にどう効くかは現在まったく未測定なので、過大側の1.0に置く。
update public.pricing_knobs
set value = 1.0,
    description = '1ステップのうち実効バッチに比例する割合。1.0で正比例。実測が取れるまでは過大側の1.0で運用する。',
    updated_at = now()
where key = 'lora_batch_marginal_ratio';
