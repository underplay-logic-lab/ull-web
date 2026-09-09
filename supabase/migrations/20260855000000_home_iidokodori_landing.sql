-- トップページ「いいとこどり」LP 刷新（実績ファースト・原価防衛型）。
--
--   1. site_contents.page_sections_order を新セクション込みの並び順へ更新
--      （HomeSections.tsx の SECTION_REGISTRY に comparison / showcase /
--       devicezerowaste / trustmedia を追加したのに対応）。
--   2. Hero は新しい siteKey（hero_ii_*）へ移行済み。旧 hero_* 行は触らない
--      （フォールバックはコンポーネント側にあるので、シードは任意）。
--   3. 新セクションのコピー / リンクをシード。
--
-- 既存マイグレーション（20260824 / 20260825）と同じ形にしてある:
--   delete ... where key in (...);
--   insert ... values (...), (...) on conflict (key) do nothing;

-- 1) セクション並び順を入れ替え（旧行を消してから入れ直す）
delete from public.site_contents where key = 'page_sections_order';

-- 2) 並び順 ＋ Hero(hero_ii_*) ＋ 新セクションのコピーをまとめてシード
insert into public.site_contents (key, value, section, label) values
  ('page_sections_order', '[{"id":"hero","visible":true},{"id":"comparison","visible":true},{"id":"showcase","visible":true},{"id":"studio","visible":true},{"id":"devicezerowaste","visible":true},{"id":"trustmedia","visible":true},{"id":"pricing","visible":true},{"id":"contact","visible":true},{"id":"articles","visible":false}]', 'general', 'トップページのセクション表示順序'),
  ('hero_ii_badge', 'ローカルの自由度 × クラウドの手軽さ × 秒単位の適正価格', 'hero', 'ヒーロー：バッジ'),
  ('hero_ii_title_line1', '高価なPCも、理不尽な規制も、待機課金も、', 'hero', 'ヒーロー：見出し1'),
  ('hero_ii_title_line2', 'すべて過去にする。', 'hero', 'ヒーロー：見出し2'),
  ('hero_ii_title_line3', '画像生成の「いいとこどり」を、この1画面に。', 'hero', 'ヒーロー：見出し3'),
  ('hero_ii_subtitle', 'スマホから世界最高峰のGPUパワーを1クリックで解放する、次世代クリエイティブスタジオ。月額固定費は0円、生成した分だけの完全従量課金。', 'hero', 'ヒーロー：サブコピー'),
  ('hero_ii_cta_primary', 'ログイン / スタジオを開く', 'hero', 'ヒーロー：主CTAラベル'),
  ('hero_ii_cta_primary_href', '#studio', 'hero', 'ヒーロー：主CTAリンク'),
  ('hero_ii_cta_secondary', '料金を見る', 'hero', 'ヒーロー：副CTAラベル'),
  ('hero_ii_cta_secondary_href', '#pricing', 'hero', 'ヒーロー：副CTAリンク'),
  ('cmp_eyebrow', 'Best of Both Worlds', 'general', '比較：エピグラフ'),
  ('cmp_title', '3つの選択肢の「不満」だけを、まとめて解決する', 'general', '比較：見出し'),
  ('cmp_subtitle', 'ローカルの自由度、クラウドの手軽さ、レンタルの高性能。いいとこだけを1画面に。', 'general', '比較：サブコピー'),
  ('showcase_eyebrow', 'Evidence Showcase', 'general', 'ショーケース：エピグラフ'),
  ('showcase_title', '言葉より、動く証拠を。', 'general', 'ショーケース：見出し'),
  ('showcase_subtitle', '実際の作例を触って確かめてください。すべてローカルGPUでは再現できない仕上がりです。', 'general', 'ショーケース：サブコピー'),
  ('showcase_ba_title', '真横90°でも破綻しない Multi-Angle', 'general', 'ショーケース：BA見出し'),
  ('showcase_ba_caption', '境界線をドラッグ。他社 i2i は横顔で崩れ、ULL はテクスチャと同一性を完全維持。', 'general', 'ショーケース：BA説明'),
  ('showcase_turn_title', '360° ターンアラウンド', 'general', 'ショーケース：360見出し'),
  ('showcase_turn_caption', '正面→斜め→真横→背面→アオリ→フカン。1枚の入力から全アングルを一貫生成。', 'general', 'ショーケース：360説明'),
  ('showcase_swap_title', '2人同時キャラ挿げ替え', 'general', 'ショーケース：挿げ替え見出し'),
  ('showcase_swap_caption', '2人写りの元画像から、キャラA・キャラBそれぞれの LoRA で完全置換。', 'general', 'ショーケース：挿げ替え説明'),
  ('dzw_eyebrow', 'Device-Free & Scale-to-Zero', 'general', '死に金ゼロ：エピグラフ'),
  ('dzw_title', 'スマホで動く、モンスターGPU。', 'general', '死に金ゼロ：見出し'),
  ('dzw_subtitle', '端末は選ばない。そして、使っていない時間の費用は1円もかからない。', 'general', '死に金ゼロ：サブコピー'),
  ('dzw_meter_title', '待機費用 0円 — リアルタイム比較', 'general', '死に金ゼロ：メーター見出し'),
  ('dzw_meter_caption', 'レンタルGPUは「考えている時間」も課金対象。ULL は生成した瞬間だけ、秒単位で課金します。', 'general', '死に金ゼロ：メーター説明'),
  ('trust_eyebrow', 'Trust & Media', 'general', 'メディア：エピグラフ'),
  ('trust_title', '技術は、公開されている。', 'general', 'メディア：見出し'),
  ('trust_subtitle', '何を、どう動かしているか。記事と動画で確かめられます。', 'general', 'メディア：サブコピー'),
  ('trust_note_href', 'https://note.com/', 'general', 'メディア：Noteリンク'),
  ('trust_note_title', 'Note — 技術解説', 'general', 'メディア：Noteタイトル'),
  ('trust_note_desc', 'アーキテクチャ・モデル選定・原価設計の裏側を公式記事で公開。', 'general', 'メディア：Note説明'),
  ('trust_youtube_href', 'https://youtube.com/', 'general', 'メディア：YouTubeリンク'),
  ('trust_youtube_title', 'YouTube — 実演', 'general', 'メディア：YouTubeタイトル'),
  ('trust_youtube_desc', 'スマホから3秒で生成するプレイ動画。編集なしのノーカット実演。', 'general', 'メディア：YouTube説明'),
  ('trust_x_href', 'https://x.com/', 'general', 'メディア：Xリンク'),
  ('trust_x_title', 'X — 最新情報', 'general', 'メディア：Xタイトル'),
  ('trust_x_desc', 'アップデート告知と最新の作例ポストをリアルタイムで。', 'general', 'メディア：X説明')
on conflict (key) do nothing;
