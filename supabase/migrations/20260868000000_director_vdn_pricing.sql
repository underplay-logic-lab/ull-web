-- ULL Cinematic Director: VDN-H3導入(2026-09-13/14)に伴う価格体系の刷新。
--
-- 旧 director_per_second(0.6) は、2026-09-09〜13の間、B300実機60秒=638.6s の
-- 原価計算を10倍誤って(¥19.9とすべきところ¥199.6)算出した値で、実際の原価に
-- 対し大幅な過小課金だった（本番60秒生成で36C≈¥60課金 vs 実原価¥187〜200）。
-- また speed モード（4step蒸留LoRA）固定だったため、複数シーンの複雑な
-- プロンプトで指示追従性が崩壊する実障害もあった。
--
-- VDN-H3導入・実機再検証（2026-09-13/14）により、ユーザーが選べる2モードに
-- 分割し、それぞれ正しい実測原価から計算し直す:
--   fast:    8step蒸留(stage-dmd-step-250、無音仕様)。実測 elapsed=396.1s
--            (480x864) → 原価≈¥8.25/秒。原価の約3倍÷credit_to_jpy(1.66)
--            ≈ 14.9C/秒。
--   quality: 50step非蒸留(stage-b-step-2000、音声あり)。実測 elapsed=681.3s
--            (1024px相当) → 原価≈¥14.19/秒。同様に ≈ 25.7C/秒。

delete from public.pricing_knobs where key = 'director_per_second';

insert into public.pricing_knobs (key, value, label, category, unit, description, is_public) values
  ('director_per_second_fast', 14.9, 'Cinematic Director Fast（秒あたり）', 'feature_credits', 'C/秒', 'Fastモード（8step蒸留・無音）の合計尺1秒あたり消費クレジット', true),
  ('director_per_second_quality', 25.7, 'Cinematic Director Quality（秒あたり）', 'feature_credits', 'C/秒', 'Qualityモード（50step非蒸留・音声あり）の合計尺1秒あたり消費クレジット', true)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
