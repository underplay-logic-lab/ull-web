# STATUS — 今どこまで進んでいるか

**このファイルの役割**: セッションをまたぐ引き継ぎの唯一の正。`/clear` 直後に
「残課題を進めて」「続きをやって」と言われたら、**推測で候補を並べて質問する前に
まずここを読む**。CLAUDE.md は「守るべきルール」、docs/*.md は「実測と経緯」、
メモリは「背景と方針」で、**「今どこか」を書くのはここだけ**。

**更新のタイミング**: 作業の区切りごと（コミットした／方針が決まった／実測が
出た／残課題が増減した）。セッションの終わりに必ず見直す。

最終更新: 2026-09-23（深夜・R2 移行 4 実装）

---

## 直近やったこと（2026-09-20）

- **LoRA 価格を実測へ作り直した**（`fa57c60`, push 済み）。GUI が実際に使う構成
  （実効バッチ1 / gc 無効 / compile **有効**）が一度も測られておらず、生YAML経路
  （実効バッチ4 / compile 無効）からの逆算で値付けしていた。実測は逆算の倍。
  s/it 0.90 → **1.80**、prep 固定分 740 → **1,098**、latent 0.9 → **1.33 秒/枚**。
  代表ジョブ 1,502C → **2,752C**（markup 1.6倍 → **3.0倍**）。詳細 docs §14.15。
- ベンチの `measured` 未定義バグ修正 + アスペクト比混在オプション（`3e3e8e9`）。
- 長時間タスク完了時に `PushNotification` で知らせるルールを CLAUDE.md へ（`e3332ee`）。

- **課金式の実効バッチを修正（2026-09-21）**。`batch_size ×
  gradient_accumulation_steps` → `batch_size × gradient_accumulation`。
  ai-toolkit では `_steps` 付きの方は optimizer を踏む間隔で**所要時間を
  増やさない**（ソース確認済み）。掛けたままだと cost-guard の許容秒も
  過小で、正常ジョブを原価割れ判定で止め得た。`lora_batch_marginal_ratio`
  は既に 1.0（正比例）で DB も一致していたので**マイグレーション不要**。
  新式の見積もりは実測と整合する（batch2+gas2: 推定3.56 / 実測3.45、
  batch4: 推定7.12 / 実測6.52＝9%過大＝安全側）。
- **`block_compile` を既定 ON・`vram_peak_gb` の記録を追加**（`5b3013a`, デプロイ済み）。
- **minimax_h3 の torch.compile を既定 OFF にした（2026-09-21）。**
  `COMPILE_LOW_VALUE_ARCHES = {"minimax_h3"}` を追加し、GUI 経路
  （`_build_config`）／生 YAML 経路の両方で、明示指定が無ければ eager で回す。
  理由: バッチ1・同一条件で compile 1.78 / eager 1.87 s/it ＝ **利得 4.6%**
  しかなく、warmup 135秒（温）／476.9秒（冷）を回収するのに 1,570／5,545 step
  必要。実運用の 1,000〜3,000 step では多くが純損。docs §14.8.2 に実測を移した
  （それまで STATUS にしか無かった）。明示有効化は `training_config.compile`
  / `model.compile`。`76d8820`・**デプロイ済み**（7.7秒・image 再ビルドなし・
  エンドポイント URL 不変）。
  - 価格 knob は触っていない。`lora_prep_load_s`（828秒）は compile warmup
    込みの校正なので**過大請求＝安全側**に倒れる（2000step で -476.9秒 vs
    s/it 過小ぶん +140秒）。値下げは「次の一手」1 の実データが溜まってから。
- **LP の料金文言の「取りこぼし」だけを直した（2026-09-21・反映済み）。**
  調査の結果、2026-09-19 のメモ `pricing-copy-accuracy-issue` が挙げた箇所は
  **ほぼホストが対応済み**だった:
  - ヒーロー統計バッジ: `¥0/月額固定費`→`¥0/維持費`、`秒単位/従量課金`→
    `従量課金/使った分だけ`（`b12e7b6`, SourceTextEditor で実施）。**この表現は
  ホストの判断なので触らない。**
  - ヒーローのサブタイトル: CMS（`site_contents`）側で「月額固定費は0円…」の
    一文が削除済み（本番で確認）。ソースの fallback だけ旧文言のままだったので
    本番に合わせた。
  残っていた取りこぼしは3つ（`b12e7b6` が触っていない箇所）:
  - `ComparisonSection.tsx` の `ULL_WINS`「月額固定費0円・完全従量課金」→
    「固定契約なし・使った分だけの従量課金」（ハードコード配列）
  - `Hero.tsx` のバッジ fallback「秒単位の適正価格」→「使った分だけの適正価格」
  - `DeviceZeroWasteSection.tsx` の `dzw_meter_caption` fallback
    「秒単位で課金します」→「生成に使うGPU時間ぶんだけの課金です」
  📌 **教訓: この手の文言は (1) CMS の `site_contents`、(2) `EditableText` の
  fallback、(3) 統計バッジ・比較表のようなハードコード配列 の3レーンに散る。
  「直したはず」の確認は本番ページの実表示 + 全レーンの grep でやる。**
- **SDXL（sd-scripts）ワーカーの cost-guard / salvage を実装（2026-09-21・デプロイ済み）。**
  それまで `timeout=10800` の固定の器しか無く、CLAUDE.md §3 の動的損切りが
  このワーカーだけ未実装だった。
  - `modal_sdxl_lora_worker.py`: trimmed s/it から残り step の所要を予測し、
    cap 超過で graceful stop → 中間チェックポイント保全 → 全額返金。cap は
    payload `cost_cap_seconds`（pricing_knobs 由来）優先、無ければ
    `SDXL_SPI_BASELINE`（0.642）と L40S 時給から算出。
  - **🐛 最終 LoRA のダウンロードが必ず 404 になるバグを発見・修正。** metadata に
    `filename="<name>.safetensors"` と書きながら実ファイルは
    `"<name>_final.safetensors"` で置いていた（ダウンロード API は filename を
    そのまま `loras/<user>/<job>/<filename>` として引く）。
  - 中間チェックポイントを全部永続化するようにした（CLAUDE.md §3。従来は最終1個
    だけ）。走行中も30秒間隔で `vol.commit()` するので、コンテナが落ちても
    salvage できる。失敗・安全停止でも途中結果を残して metadata に載せる。
  - `modal_lora_worker.py` の `salvage_lora_job` が `/models/outputs_sdxl/<key>`
    も探すようにした（従来は ai-toolkit のルートだけ見ていたので SDXL ジョブの
    salvage は常に空振りしていた）。
  - `costGuard.server.ts`: arch=sdxl の許容秒を **L40S の時給**で算出するように
    修正（全 arch を B300 で割っていた。単価が約4倍違うので許容秒が約1/4になり、
    しかも課金側は既に sdxl 専用の安い単価 knob を使っているため二重に厳しかった）。
  - メモリ `sdxl-training-sd-scripts-plan` の「フロントUI未着手」は**既に実装済み**
    （`LoraStudioTab.tsx` に埋め込みタグ / keep_tokens の入力欄がある）。
- **admin ファイルエクスプローラーの使い勝手を作り直した（2026-09-21・デプロイ済み）。**
  ホスト指摘の5点に対応。**ファイルの置き場所（パス規約）は変えず表示だけで解決**
  （パスを変えると既存ジョブの `metadata.checkpoints` とダウンロード API の
  互換性に波及するため）。
  - フォルダごとの**ファイル数・容量を復活**。`e271c62`（2026-09-19 の遅延読み込み
    化）で `countFilesRecursive` / `sumSizeRecursive` ごと消えていた。新設の
    `dir_stats` アクションで「今開いている階層の子フォルダぶん」だけを集計し、
    一覧描画の後から非同期で埋める（Volume 全体 walk には戻さない）。
    1フォルダ2万エントリで打ち切り（`20,000+` 表示）。
  - **UUID フォルダの名前解決**。`loras/<user_id>/<job_id>/` に
    「🎯 LoRA名 / 日付・ベースモデル・step数・状態」「👤 メールアドレス」を併記。
    `/api/admin/modal/storage/labels` が `generation_jobs` と `profiles` を引く。
  - ソート（名前・サイズ・更新日時、ヘッダクリック）、絞り込み（名前＋解決済み
    ラベル）、長いファイル名の**中央省略**（末尾の `_step0001000` / `_final` を
    必ず残す）、画像・動画の**インラインプレビュー**（25MB まで。既存の
    `?inline=1` 経路）。

- **エクスプローラー第2弾（2026-09-21・デプロイ済み）。**
  - **フォルダの日時**を表示。⚠️ Linux では作成日時が取れない（`st_birthtime` は
    BSD/macOS のみ）ので出しているのは mtime＝「直下の中身が最後に変わった時刻」。
    学習ジョブフォルダは `generation_jobs.created_at` 由来の**本当の作成日**が
    ラベル側に出る。
  - **動画は先にサムネイル**。`thumbnail` アクション（ffmpeg で1フレーム→JPEG、
    `_thumbs/<sha1>.jpg` に Volume キャッシュ）を新設し、`<video>` は再生を
    押すまで本体を1バイトも読まない。実測 11MB の mp4 → **22KB の JPEG**。
    画像も既定はサムネイルで、「原寸で開く」は 25MB まで。
  - **空フォルダは既定で非表示**（トグルで表示・削除はしない）。「空フォルダ N 件を
    非表示にしています」と件数を出す。

- **Illustrious 系のライセンス表示を利用規約へ追加（2026-09-21）。** `docs/model-licenses.md`
  に Illustrious 系の記載が1件も無く、**既に GUI に出している `illustrious_xl` にも
  義務が発生していた**（既存の穴）。Fair AI Public License 1.0-SD は
  **「モデルに対して学習を行うこと」を改変と定義**しており、そのベースで焼いた LoRA は
  同ライセンス下で提供する義務がある。LoRA 本体をダウンロード提供しているので
  「派生モデルを受け取れる手段」の要件は満たしており、残る告知義務を
  `src/app/terms/page.tsx` の**第3条の2**として追加した（条番号は振り直さない）。
- **LTX-2 の不要ファイルを特定（2026-09-21）。** 292.76GB のうち **158.94GB が
  我々の構成では一度も読まれない**（ComfyUI 用の単一ファイル群 + latent_upsampler +
  デモ動画）。ai-toolkit の `LTX2Model.load_model()` をソースで確認済み。
  詳細と根拠コードは docs §14.8.2 の次（§14.8.3）。**削除は未実施。**

- **納品する LoRA 自体にライセンス表示を焼き込んだ（2026-09-21）。** 規約ページ
  だけでは「ファイル単体で人に渡った後」に何も残らない。Gemini のレビューでも
  同じ指摘があり、3層にした:
  1. 利用規約 第3条の2（サービスとしての告知）
  2. `.safetensors` の metadata（`modelspec.license` 他4キー。Civitai や ComfyUI
     へ持ち出されても付いて回る）
  3. ジョブフォルダの `LICENSE.txt`（一括DL の ZIP に入る）
  対象は `illustrious_xl` / `wai_illustrious` のみ。ローカルテストで
  **既存メタデータとテンソル本体が無改変**であることを確認済み。
  ⚠️ **生成した画像は Outputs 条項でライセンス対象外＝自由。** LoRA 本体
  （derived model）だけが継承対象。この2つを混同しないこと。

- **画像ごとの学習回数（num_repeats）を実装した（2026-09-21・両ワーカー）。**
  ローカルの kohya 運用では `datasets/10_kocho/` のようにフォルダ名の先頭へ
  数字を置いて画像ごとの学習回数を変えるのが定番で、ホストもこれで焼いていた。
  ULL Studio はブラウザから画像を1つの束として受け取るのでフォルダ名が使えず、
  代わりに**倍率ごとに dataset/subset を分けて `num_repeats` を指定する**
  （TOML / config 側の表現としては同じもの）。
  - sd-scripts: `_group_by_repeats` → `[[datasets.subsets]]` を倍率ぶん出力
  - ai-toolkit: `_group_dataset_by_repeats` → `datasets` を倍率ぶん並べる
    （`DatasetConfig.num_repeats`、ソース確認済み）
  - UI: 画像をクリックで選択（**shift+クリックで範囲選択**）→ ×1/2/3/5/10 か
    カスタムで一括設定。重み付けした画像には `×N` バッジ。
  - ⚠️ **消費クレジットは変わらない。** 総ステップ数は固定で、`num_repeats` が
    変えるのはデータセットの構成比だけ。latent キャッシュも画像1枚につき1回。
  - ⚠️ 副作用: 重み付けを使うと画像のパスが変わるので **latent キャッシュは
    作り直し**になる（キャッシュはパス基準）。重み付け無しのジョブは従来どおり。
  - ローカルテストで正規化・グルーピング・TOML 生成（tomllib でパース）まで確認済み。
  - **実機未検証**: 重み付きの実ジョブはまだ1本も通していない。

- **LoRA Studio の入力を「学習したい特徴」1本へ統一した（2026-09-21）。**
  それまで「固定したい特徴／変化させたい特徴／見た目の特徴（日本語）／
  metadata タグ（英）」の4箇所で同じ話を聞いていた。1本の確定リストが
  ①キャプションのブラックリスト ②metadata の埋め込みタグ ③複数人の見分け
  ヒント の3役を兼ねる。「眼鏡を学習したくない」はリストから × で外すだけ。
  - 入力は**日本語**。`identity-tags` API を `"enja"` モードにして {en, ja} の
    ペアで返す（リクエスト数は同じ＝追加コストなし）。英タグは title で確認可。
  - 主経路は「**画像から抽出**」。候補10個前後を出して**削らせる**ので、
    宣言方式（ユーザー指定が既定を置き換える）でも書き漏らしが起きにくい。
    今朝つぶした「1語書くと既定が消える」事故の再発ではない（あちらは
    空欄から書かせていた）。UI に「上記以外すべて（顔立ち・髪型・髪色・
    目の色も含む）は毎回キャプションに書かれます」と結果を明示してある。
  - keep_tokens・metadata・確認ゲート・取り込みゲートも同時に入った。
    **いずれも実機未検証。**
- **データセット構成の自動診断を実装した（2026-09-21、段階A）。**
  `src/lib/datasetDiagnostics.ts` + `DatasetDiagnosticsPanel.tsx`。キャプション
  （生成済みの Danbooru タグ列）を集計するだけで、**新しいモデルも GPU も不要**。
  距離／向き／姿勢／背景の4軸で被写体ごとに枚数を出し、構造的な欠落と
  被写体間の偏りを指摘する。「学習回数では直らない」項目はその旨を明示。
  - ホストの実案件（85枚）に当てて検証済み。**8時間×複数回焼いても分からな
    かった原因が集計だけで出た**: kocho の上半身が4枚（hitozuma は23枚）、
    両者とも姿勢が「立ち」のみ・背景が「無地」のみ。
  - 一番効いたのは**被写体間のバケット偏り**ルール。絶対値の目安（上半身4枚）は
    満たしているのに相手の1/6、という状態は閾値では検出できない。
  - ⚠️ 数値目標（`DIAGNOSTIC_TARGETS`）は**未校正の出発点**。「0枚・1枚」の
    構造的欠落は仮値不要で断定できるのでそちらが主役。実ジョブが溜まったら校正する。
  - ⚠️ 集計はキャプションの語彙に依存するので `unclassified`（未分類枚数）を必ず併記。
  - 段階B（repeats の自動提案）とC（多い中からの選抜支援・知覚ハッシュで重複検出）は未着手。

### 実案件（NTR校長 duo LoRA）の調査結果（2026-09-21）

- **前回の構成**: `train_kocho.bat` / sd-scripts / wai_illustrious_v11 /
  dim128 alpha64 / conv_dim=4 conv_alpha=1 / Prodigy d_coef=2.0 / cosine+warmup100 /
  enable_bucket / keep_tokens=4 / 15 epochs（実効680枚/epoch ＝ 約10,200 step）。
  データは `20_kocho_solo`(19) / `8_duo_pair`(28) / `2_hitozuma_solo`(38)。
- **「男性が弱い」の原因は露出比ではない。** kocho は既に露出89%（hitozuma 44%）。
  効いているのは構図の偏り（上半身4枚 vs 23枚、後ろ4枚 vs 14枚）。
- **素材には足りない構図が全部ある。** `NTR校長キャラ/` の21枚は8方向ターン
  アラウンド＋顔7種＋seated/walking を含み、`augmented/` に crop_body 等が
  21枚ずつ（計105枚）。`人妻単体/` は19構図×全身/半身/顔アップ＝57枚。
  **選抜の工程で落ちていた**（kocho は crop_head / face_macro 寄りの選抜）。
- **次の焼き直しの方針**: repeats を上げるのではなく、kocho の solo を
  hitozuma と同じ「全身・半身・顔アップの3点セット」で組み直す。新規に絵を
  起こす必要はない。
- **Gemini の拒否は心配しなくてよい**（2026-09-21・ホスト確認）。この案件の
  素材レベル（イラスト・NSFW 寄り）では一切拒否されない。未測定リスクとして
  挙げていたが解消。**ただし実写の同種素材では未確認。**
- **`enable_bucket` が ULL Studio 側に無かった**（2026-09-21 に追加）。これが
  無いと sd-scripts は全画像を 1024 四方へリサイズ＋中央クロップするため、
  1024x1536 の縦長素材は上下が三分の一ほど切り落とされていた。ホストの
  ローカル `dataset.toml`（enable_bucket = true / bucket_no_upscale = true）に
  揃えた。min/max_bucket_reso はホスト側も未指定なので合わせて未指定。
- **判断（2026-09-22）: duo 画像のキャプションを人物ごとに分ける必要は無い。**
  「男女でタグが分かれるべき」という指摘は、この設定下では成立しない。
  `shuffle_caption = true`（`[general]` に一律）が keep_tokens より後ろを毎
  エポック並べ替えるため、キャプション側で人物ごとにまとめても順序は壊れる。
  かつ服装と人物の対応は solo 画像（kocho 55 / hitozuma 57）が一意に教える。
  ⚠️ **「duo では服装を書かない」は誤り**（一度そう提案して撤回した）。
  キャプションに書かれない要素はトリガーへ焼き込まれるので、服装を省くと
  その服がキャラの一部として学習される。服装は書き続けること。
- **写り込みの点検方法（2026-09-22）**: クロップは片方の被写体を選んで切り
  出すので、①相手の**単独**カウントが増えたら異常（原理的に増えない）、
  ②**両方写り**のカウントが増えた分が写り込みの上限。実例: クロップ前
  kocho 21 / hitozuma 57 / 両方 87 → 後 55 / 57 / 106（hitozuma 単独は不変＝
  正常、両方が +19）。顔が見えない人物にトリガーを付けない指示を入れたので
  （`a5df595`）、次回はこの +19 が減るはず。その差が腕だけの写り込み枚数。
### 【完了 2026-09-22】実ジョブで見つけた4つの不具合

**実ジョブを通さなければ1つも発見できなかった。**スモークテストでは全部素通り
していた種類のもの。

1. **`train_sdxl_lora_job` に `secrets=` が無かった**（`99d4fc6`）。学習は
   正常に走るのに Supabase へ進捗・完了を書けず、UI が永遠に「起動中」。
   `[sdxl-worker] Supabase env not configured, skipping request.` を出して
   黙って捨てていた。
2. **キュレーション経由で `repeats` が落ちていた**（`e714da2`）。
   `confirmCuration` / `flushCurationToForm` が画像オブジェクトを作り直す際に
   `repeats` / `cropKind` / `sizeVerdict` を捨てていた。キュレーションを既定
   ON にしたため**全ジョブがこの経路を通り、学習回数が毎回無効化されていた**。
3. **sd-scripts の標準出力を捨てていた**（`ad977ef`）。`for line in proc.stdout:`
   で読みながら print しておらず、起動ログもステップ進捗も見えなかった。
   CLAUDE.md §1 の「リアルタイムでストリーム」違反。
4. **`@app.function` が別の関数に付いた**（`adc9a6f`）。デコレータと関数定義の
   間にヘルパーを挿入してしまい `AttributeError: 'function' object has no
   attribute 'spawn'`。全28 Modal 関数を AST で検査済み、他に同種なし。

### 実測: SDXL 学習の実データ値（2026-09-22・実案件 259枚→220枚）

| 項目 | 実測 |
|---|---|
| 速度 | **1.35 it/s = s/it 0.74**（3,490 step / rank32 / 1024px / batch 1） |
| VRAM | **18.7 GB**（L40S 48GB に対し 29GB 余裕） |
| 学習時間 | 42分23秒（sd-scripts の tqdm 実測） |
| 全体 | **44分34秒**（DB の created_at→completed_at。コールドスタート・latent キャッシュ込み） |
| GPU 実費 | 約 ¥232（L40S $1.95/h × 0.74h × 160円） |
| 課金 | **573C**（DB 実績）≒ ¥951 相当 → 粗利率 **約76%** |
| 成果物 | 中間13本（250刻み）＋最終1本＝14本、各 228MB。`metadata.checkpoints` に登録済み |

**完走確認（2026-09-22 11:43 UTC）**: job `c3d2cfc6-0836-4d06-b1f9-07d42c4d28e0` が
`status=completed`、`error_message=null`。走行前に「約50分・粗利71%」と見積もった
が、実績は上記のとおり想定の76%に着地した。

**完走後に見つけた不具合（修正・デプロイ済み）**: 完了時の `metadata.vram_used_gb`
が **0.4GB** だった。学習プロセスが終わって VRAM を解放した後に測っていたため。
完了画面のバッジがこの値を出してしまう。走行中の最大値を `vram_peak` として持ち、
完了時は `vram_used_gb` と `vram_peak_gb` の両方にピークを書くよう修正
（`modal_lora_worker.py` の `_track_vram_peak` と同じ方式）。

**`LORA_SPI_BASELINE.sdxl = 0.642` の校正は不要**。実測 0.74 とのズレは15%。以前スモークで出た 1.197 のほうが実態と乖離して
いた（合成データは 1024x1024 の単一バケット、実データはアスペクト比が混在）。

**VRAM に 29GB の余裕がある** → 次の焼き直しでは batch_size 2 や、より安い
GPU tier が検討できる。ただし CLAUDE.md §1 のとおり **1回あたりの実コスト
（時間単価×所要時間）で判断**すること。速度が落ちれば安い tier でも高くなる。

### 【完了 2026-09-22】完走後のダウンロードで見つかった2件

1. **「キャプション付きデータセットDL」が「データセット ZIP が見つかりません」** —
   SDXL ワーカー（sd-scripts）が dataset.zip を作っていなかった（ai-toolkit 側の
   ワーカーだけが作っていた）。ステージング直後（サブフォルダ振り分け前・latent
   キャッシュ生成前）に作り、完了時に `loras/<user>/<job>/dataset.zip` へ置いて
   `metadata.checkpoints` に `is_caption_archive` で登録するよう修正・デプロイ済み。
   完走済みの job `c3d2cfc6` は、ジョブ行の dispatch payload（storage_paths＋captions）
   からワーカーの `_stage_dataset` を呼び直して**後付けで作成済み**（220枚＋220件、34MB。
   probe で found:true を確認）。salvage を使わなかったのは、完了ジョブに対して
   走らせると 3.2GB の checkpoints_all.zip を Volume に追加してしまうため。
2. **一括 ZIP のダウンロードが 5MB/s** — 原因は Modal の Web 入口で、ZIP 化でも
   Volume でもリージョンでもない。実測と選択肢は `docs/gpu-benchmarks.md` §16。
   **対策はホスト判断待ち**（R2 へ配信を逃がすのが本命だが新規依存）。

### 【完了 2026-09-22】メタデータ埋め込みが final にしか掛かっていなかった

ホストが LoRA ファイルを開いて発見。`_embed_metadata_tags`（ss_trained_words 等）と
`_stamp_license_metadata` を `final_ckpt` にだけ掛けていた。250刻みの中間を見比べて
採用するのが普通の運用なので、中間にも入っていないと困る。`produced`（sd-scripts が
出した全 .safetensors）をループするよう修正・デプロイ済み。

完走済み job `c3d2cfc6` の中間13本は、**ヘッダだけを書き換える**使い捨てスクリプトで
後付け済み（safetensors は先頭 JSON ヘッダにメタデータを持ち、テンソル本体は
ヘッダ直後からの相対オフセットなので、ヘッダ差し替え＋本体コピーで `save_file` と
同じ結果になる。ワーカーの純粋関数 `_clean_tag_frequency` 等をそのまま使用）。
13本とも検証 OK、サイズも final と同一の 228,480,492 バイトに揃った。
`metadata.checkpoints[].size_bytes` も更新済み。

⚠️ torch 入り image を新規ビルドする案は Modal 側で2回続けて
「Image build terminated due to external shut-down」で落ちた（torch CPU wheel 196MB の
取得中）。メタデータだけ触るなら torch は要らないので、今後もヘッダ書き換えで済ませる。

### 【進行中 2026-09-23】ローンチ価格の確定作業で入れた変更

- **動画超解像の課金を「課金前 ffprobe 実測」に変更**（`6229574`）。ブラウザは fps を取れず 30 を仮定
  するため申告フレーム数と実ファイルがズレていた（4K 実ジョブで 151→121、62C 取り過ぎ）。
  署名 URL を先に発行 → Modal の CPU 関数 `probe_upscale_video`（ffmpeg 入り軽量 image）で実測 →
  その値で確定課金。返金運用にはしない（ホスト判断「最初から正しい額」）。失敗時は申告値へ
  フォールバック。Vercel env `MODAL_SEEDVR2_VIDEO_PROBE_URL` 追加済み。
- **静止画超解像を RTX PRO 6000 既定へ**（`80db087`、3 tier 実測は gpu-benchmarks §1）。短辺 3840 超は B300。
- **LoRA の最低 step を 200→50**（UI `STEPS_MIN` と API クランプ）。s/it・VRAM を測る確認ランを UI から
  投げるため。
- **LoRA の価格式を arch 別プロファイルに**（`4a16778`〜`8392d20`）: ai-toolkit 5 arch（wan22_14b / ltx2 /
  krea2 / flux2_klein_4b / zimage / anima）を GUI から 50step ずつ実測し、`LORA_ARCH_PROFILE`
  （prep 固定費・枚数あたり秒・GPU tier）と `LORA_SPI_BASELINE` を実測に合わせた。credits/GPU秒は
  B300 knob × tier 時給比、実行 tier は payload `gpu_tier` で worker へ（デプロイ済み）。
  まとめは gpu-benchmarks §14.22。**【完了 2026-09-23】tier 確認ラン**（§14.26）: ltx2 / krea2 → H200、
  klein / zimage / anima → RTX PRO 6000 に切り替え済み（原価 −15〜60%）。ホスト判断「その程度なら安くていい」。
  **L40S / A100 40GB / A100 80GB も実測して全部不採用**（§14.27、速度が 1.6〜2.3 倍落ちて原価は同額か高い）。
  下限は RTX PRO 6000。**【完了】SDXL も RTX PRO 6000 へ**（§14.28、L40S 比 1.9 倍速・17% 安。Blackwell 用
  image torch 2.8/cu128 を別関数で追加、L40S 経路は残置。品質差はホストが次の実案件で確認、戻すのは 1 行）。
  **選択制（安い・遅い／高い・速い）はホストの元々の構想**で、klein/zimage の
  「B300 で 2 倍速・20% 高」が唯一の選択肢になる。機能化は未着手（UI 2 択 + route の gpuTier 上書き）。
- **動画超解像のダウンロードをネイティブ保存に**（`ab23ce6`）。fetch→blob で無反応に見えていた。
- **LoRA「フォームを初期化」が押せない詰み**（`d0b1693`）: 送信成功後に submitting が残っていた。

**【完了 2026-09-23】SDXL の固定既定**（`fc65d13`、smoke 済み・デプロイ済み）: `min_snr_gamma=5`（既存）
＋ `lr_scheduler=cosine`（Prodigy なので warmup 無し）＋ LoCon `conv_dim=16 / conv_alpha=8`
＋ `caption_tag_dropout_rate=0.1`（TOML `[general]`、keep_tokens 分は落ちない）。env
`SDXL_LR_SCHEDULER / SDXL_LR_WARMUP_RATIO / SDXL_CONV_DIM / SDXL_TAG_DROPOUT` で個別に戻せる。
smoke（L40S・合成5枚・20step、58.5s）で引数が通り、U-Net の LoRA モジュールが 722 → 788
（Conv2d 3×3 に掛かった）ことを確認。**WAI v7（kocho ×5・rank 64/alpha 64・3,000step）を焼いた結果、
ホスト評価は「v6 よりかなり良い」＝この 220 枚での頭打ち圏**（gpu-benchmarks §14.24）。
**【完了 2026-09-23】rank 32 + LoCon 300step で基準確定**（gpu-benchmarks §14.25）: 定常 1.21 s/it、
rank 64 の 1.23 と 2% 差＝**rank は時間を動かさない。遅くなったのは LoCon（+65%）**。
`LORA_SPI_BASELINE.sdxl` 1.0 → 1.25。価格式に rank 係数 `loraRankFactor()`（arch 別 k、
`LORA_RANK_MARGINAL`）を追加したが SDXL の k は実測 0。cost-guard も arch 別 GPU tier の時給で
割るよう修正（B300 固定のままだと安い tier で二重に厳しかった）。
**【完了 2026-09-23】loras/ 直下への final 平置きコピーを廃止**（`31c23fa`、両ワーカー）: ComfyUI 用の
名前エイリアスだったが導線が無く二重保存なだけ。result_path は `loras/<user>/<job>/<name>_final.safetensors`。
**【確定 2026-09-23】LoCon は既定で有効**（一度外したが同日撤回。同条件比較で v7 の顔の再現性が段違い）。
`SDXL_CONV_DIM` 既定 16、`LORA_SPI_BASELINE.sdxl` 1.25。SDXL の固定既定は cosine / LoCon conv16 /
tag dropout 0.1 / min_snr 5 の 4 つ。kocho が女性っぽくなる原因は推論側のネガティブ「醜い」だった。
**ホスト評価（2026-09-23）: v7 のベストは step 1,750**（3,000 の final ではない）。ただし毎回そうとは限らないので
**最低 2,000 は回す**。→ **【完了】SDXL の自動 step を 600 + 6.5×枚数 に**（220 枚で 2,030、旧式は 3,490）。
自動の rank/alpha（人物）は **32/32**（旧 32/16、alpha=rank・rank は価格に効かないので 32 のまま＝ファイル半分）。
ai-toolkit 系の式・detail 側 64/32 は据え置き。

### 実測: SDXL ワーカーのコールドスタート内訳（2026-09-22）

経過時間ログ（`_mk_logger`）を入れて初めて測れた。**コンテナに入ってからは
4.4秒しかかかっていない。**

```
t=  0.0s  コンテナ起動・import 完了
t=  0.2s  Volume マウント完了
t=  3.5s  データセット展開完了（220枚）
t=  4.4s  sd-scripts 起動
```

つまり約3分の大半は `t=0.0s` に到達するまで＝**Modal のマシン確保＋イメージ
展開＋`import torch`**。疑っていた「Volume からの6.6GB読み込み」「画像の展開」
は無罪だった。イメージの中身は PyTorch + CUDA + sd-scripts で削る余地が無く、
**現実的に手が打てないという結論**。

送信側は WebP 変換（317MB→35MB、9倍）＋4並列化で、圧縮1〜2分→20〜30秒、
アップロード数分→80秒まで短縮済み。

### 次の一手: LoRA Studio の導線を「光って導く」形にする（2026-09-22・実装済み）

ホスト提案。「初めての人には手順が分かりにくい。次に入力／押下すべき欄や
ボタンが順次光る・点滅すると直感的。選択肢があるときは両方光れば、どちらかを
選べばいいと分かる」。

**実装方針（新しい状態を持たない）**: 現在の状態から「次にやること」を導出
できる材料は既に揃っている。`useLoraFlowStep()` のような派生値1つにまとめ、
該当要素へ `ring-2 ring-neon-pink animate-pulse` 相当を当てるだけにする。
状態を新設すると既存の state とズレるので、必ず導出で作ること。

  トリガーワード未入力 -> トリガーワード欄
  性別タグ未選択       -> 性別/人数タグ（未選択だと特徴の自動抽出も待機する）
  画像0枚              -> 取り込み欄
  メタデータ未確認     -> 確認チェック
  キャプション未完了   -> 再解析ボタン（解析中は光らせない）
  診断に赤がある       -> クロップの準備ボタン ＋ そのまま進むボタン（両方）
  それ以外             -> 学習回数の📐 ＋ 学習設定へ進む（両方）

**注意**: ①常に1〜2箇所だけ。済んだら即消す ②既存の警告色（赤＝要確認 /
琥珀＝注意）と競合させない。ピンク系で統一する ③順序は一本道ではない
（クロップは任意、診断が問題なしなら飛ばす）。「必須の未完了があればそれ、
無ければ次の選択肢」という優先順位で決める。

半日規模。

### キャプション経路の課題（2026-09-22・未着手）

**Gemini は NSFW 寄りの素材を確率的に拒否する。枠切れではない。**
`geminiText.ts` の `RELAXED_SAFETY` で設定可能な4カテゴリは全て `BLOCK_NONE` に
してあり、それでも `safety` が立つのは Google の**設定で解除できない**
絶対ブロック（`IMAGE_SAFETY` / `PROHIBITED_CONTENT` 等）。課金しても解除
できない。実案件で 165枚中 144枚が落ちた。

⚠️ **キャプションのバッチサイズを上げてはいけない。** 1枚でも拒否されると
そのリクエストの全画像が巻き添えで失われる。無料枠節約のため一度 4→12 に
したが、この素材では巻き添えのほうが痛いので 4 へ戻した（`0332ede`）。

**対策の方向**: `Qwen3.8-27B-abliterated`（Volume に配置済み、ai-toolkit 側に
だけ経路あり）を SDXL 側にも用意する。ただし **混在させるかは要検証**:
キャプションに書かれない要素はトリガーへ焼き込まれるため、モデルによって
**網羅範囲**が違うと画像ごとに「何がトリガーに入るか」がバラつく。語彙の
ゆれより有害。
- 着手したら**まず同じ10枚を Gemini と Qwen 両方で解析して比べる**
  （タグの語彙／1枚あたりのタグ数＝網羅範囲）。測らずに決めない。
- ほぼ同じ → 拒否分だけ Qwen（安い）。明らかに違う → 1枚でも拒否されたら
  全部 Qwen でやり直す（ホスト案）。
- 30秒/画像（`LORA_CAPTION_S_PER_IMG`）だと165枚で約82分。小さい VL モデルへの
  載せ替えも検討対象。

- **方針決定（2026-09-22）: 2段階で焼く。** 品質に効く sd-scripts の設定
  （`network_args conv_dim/conv_alpha`、`lr_scheduler cosine + warmup`、
  `min_snr_gamma`、`caption_tag_dropout_rate`）がホストのローカル `run.bat` に
  あって ULL Studio 側に無いが、**今回のジョブの前には入れない**。構図を揃えた
  効果を測るのが今回の目的で、同時に変数を増やすと結果の判断がつかなくなる。
  ① 現状のまま焼いて kocho の再現性を見る → ② 4つを既定値として実装し、
  もう一度焼いて比較、の順。これらは**ユーザーに選ばせる種類の設定ではない**
  （固定値にする）。ユーザーに残す選択肢は rank / ステップ数 / 解像度の3つ。
- ⚠️ **ホストの経験則（2026-09-21・未検証）: Illustrious 系は女性優位に学習
  されており、男性は学習が入りにくい。** 過去に何度焼いても kocho だけ甘く、
  「異様な比率で男性の学習量を増やす」ことでようやく改善したという経緯がある
  （直近のものでかなり良くなったが、それでも女性より再現性は低いまま）。
  **これが本当なら、男女を同じ比率で組むと今回も kocho が甘くなる。**
  上の「原因は露出比ではない」という分析と矛盾はしない（構図の偏りと
  ベースモデルのバイアスは独立に効き、両方効いている可能性がある）が、
  **構図を揃えたうえで露出比を 1:1 に戻すのは危険**。まず構図だけ揃え、
  露出比は前回（kocho 89% / hitozuma 44%）に近い水準を維持して焼き、
  結果を見てから比率を動かす。1回で当てにいかない。

### 【完了 2026-09-22】オートモードを廃止して経路を1本にした

実装済み。モード選択（オート／エキスパート）のUIを撤去し、学習設定は常に
表示する。値は**未編集の間だけオートの推奨値を導出して見せ、触った瞬間に確定**
する（`proPristine` / `effPro` / `updatePro`）。state を書き換えないので、
枚数やカテゴリが変われば未編集の項目は追従する。以前の「エキスパートに入った
瞬間に固定値へ切り替わり alpha と steps が黙って変わる」挙動は無くなった。

旧・方針メモ（2026-09-21）:

### 方針決定: オートモードを廃止して経路を1本にする（2026-09-21・完了）

ホスト判断。「経路は1つに統一して、オートモードということではなく入力画像に
より自動で設定値が変わる。わからない人はそのまま生成ボタンを押せば良いし、
何か変えたい人は変えればいい。それだけの違いにしたい」。

**なぜ今なのか**: 2026-09-21 にキャプション・identity 抽出・keep_tokens・
metadata・データセット診断を自動化した結果、**データセット側の処理は
auto/pro で完全に共通**になった。残る差は学習ハイパーパラメータ5つだけで、
しかも自動値は関数2本（`autoLoraRankAlpha` / `autoLoraSteps`）で決まる。
「何も分からない人向けの入口で、分からない選択を強いている」状態になっていた。

**影響範囲（調査済み）**: `LoraStudioTab.tsx` の `mode` 参照は実質4箇所。
- 1242/1243 行: `linearRank` / `steps` の分岐
- 1716 行: trainingConfig の組み立て
- 2901 / 3727 行: モード選択カードと詳細パネルの表示条件
- 1009 行: `yamlMode = mode === "pro" && pro.useRawYaml && isAdmin`
  → `pro.useRawYaml && isAdmin` になるだけ。**生YAML は元々 admin 限定なので
  一般ユーザーへの露出は増えない。**

**唯一の設計判断 — 自動値をいつ上書きするか**: 画像を足すと `autoLoraSteps`
の値が動くが、ユーザーが手で変えていた場合に上書きすると「勝手に戻った」、
しないと「枚数を増やしたのに反映されない」。**このコードベースに既に答えが
ある** — `ProConfig.alphaLinked` / `lrCustom` が「ユーザーが触るまで追従し、
触った瞬間に固定」を実装している。同じ方式を `steps` / `rank` へ広げ、
手動項目には「手動」バッジと「自動に戻す」を置く。

**画面**: 自動で決めた値を常に表示（学習解像度が既にやっている形）。
「オート／プロ」のトグルを消し、触りたい人だけ各項目を手動へ切り替える。

⚠️ **着手は wai の検証ジョブが終わってから。** `steps` は消費クレジットに
直結するので、今触ると見積もりのズレが実装由来か設定由来か切り分けられない。
また 2026-09-21 に入れた取り込みゲート・確認ゲート・診断パネルは**まだ実機で
一度も通していない**ので、経路を統合すると確認をやり直すことになる。

### 次にやること（LTX-2 / SDXL 顧客対応）

1. ~~LTX-2 の 158.94GB を削除~~ → **完了（2026-09-21）**。`_REPO_SNAPSHOT_IGNORE`
   追加 → 削除 → CPU で再DLが走らないこと確認 → B300 スモークで学習が通ること確認。
   Volume 966.5GB → **807.6GB**（余裕 34GB → 193GB）。手順と根拠は docs §14.8.3。
2. ~~`waiNSFW_illustrious_v11.safetensors` を Volume へ~~ → **完了（2026-09-21）**。
   ホストが `modal volume put` で投入済み
   （`diffusion_models/waiNSFW_illustrious_v11.safetensors`・**6.46GB**）。
   ⚠️ **採用する版のモデルページでライセンス再確認は未実施**（HF ミラーの
   `faipl-1.0-sd` 表記を根拠にしている。docs/model-licenses.md 参照）。
   - 併せて **admin からローカルPCのファイルを送る口を新設**した。それまで
     リモートダウンローダ（URL 指定）しか無く、手元にしか無いファイルを
     持ち込めなかった（ホスト指摘）。ブラウザ→Modal 直・HMAC 署名・
     **レジューム対応**（`admin_upload_volume_file` / `_status`）。
3. ~~`wai_illustrious` プリセットを追加~~ → **完了（2026-09-21）**。
   `loraModels.ts` + `SDXL_TARGET_MODELS`（Volume 上の単一 .safetensors を直接指す）。
   **単一ファイル経路を L40S スモークで実機確認済み**（returncode 0 / 20step 完走 /
   LoRA 2,958テンソル・114.44MB / VRAM ピーク **16.71GB**）。
   スモークに `target_model` 引数を足したので、以後どのプリセットでも通せる。
   - ⚠️ **VRAM 16.71GB しか使っていない。** L40S(48GB) は過剰で、もっと安い tier が
     使える可能性が高い。$/job の比較はまだ。
   - 🚨 **SDXL の s/it が旧計測と2倍食い違う（docs §14.8.4）。** 同じ連立の方法で
     0.642 → **1.197**。現行 knob の見積もりは実所要の **55%** しかない。
     ただし合成5枚のデータなので knob は据え置き。**実写データセットの実ジョブ
     1本で決着させる**（`metadata.metrics` に自動で残る）。

### ファイル配置の調査結果（2026-09-21、ホスト質問への回答）

- `loras/<name>.safetensors`（直下）= ComfyUI から名前で引くための**モデル
  ライブラリ別名**。per-job フォルダは「ジョブの成果物アーカイブ」で役割が別。
- per-job フォルダに中間チェックポイントが無いのは**バグではない**。今 Volume に
  残っている9ジョブは全部 100〜200step のベンチランで、`config.yaml` を確認したら
  `save_every: 250` / `steps: 100` ＝一度も保存が発火していない。実運用の
  2000step なら8個ほど並ぶ。
- `yukipas_v6`〜`v13_eager` が消えないのは、14日パージが **`ADMIN_USER_IDS` を
  スキップする**仕様のため。ホスト自身の実験は自動削除されない。
- `lora_dataset_uploads/` は **12フォルダとも中身0件**（実測）。Smart Ingest が
  最適化コピーを焼いた後に生画像を消すので、`<user_id>/<dataset_id>/` の殻だけが
  残る。`studio_uploads/` も0バイト。**消しても害は無い**が、消さなくても容量は
  食わない（inode だけ）。
- `outputs/fc-xxx/<名前>/config.yaml` は **学習に実際に使われた ai-toolkit の
  設定ファイル**。完了時に .safetensors だけを `loras/` へ move するので、
  設定ファイルが残骸として残る。証跡として有用（今回の「中間が無い理由」も
  これで確定できた）。掃除は `admin_cleanup_volume` の対象。
- `outputs/all/a63a388a…_ComfyUI_00001.glb`（71.5MB・2026-09-14）は
  **TRELLIS.2 画像→3D の実機テスト**の出力。`ull-wan-animate` の
  `run_custom_workflow` → `_save_output_temp` が全生成物を
  `outputs/all/<uuid hex>_<ComfyUI のファイル名>` で7日保管する経路。
  機能自体は保留（メモリ `image-to-3d-feature-validation`）。
- ✅ **自動削除タイマーは全部動いている**（2026-09-21 に Modal のログで確認。
  いったん「効いていない疑い」と報告したが誤りだった）。
  - `ull-retention-purge` / `purge_expired`（14日）: 2026-09-21 03:17 JST に実行。
    cutoff 09-06 で全項目0件＝**まだ14日を超えたデータが無いだけ**。
  - `ull-lora-worker` / `cleanup_old_latent_caches`（14日）: 09-21 13:18 JST に実行。
  - `ull-wan-animate-blackwell` / `cleanup_old_outputs`（7日・`outputs/all`）:
    09-20 20:28 JST に実行し removed 0。そのときの cutoff が 09-13 11:28Z で、
    最古のファイルが 09-13 11:50Z ＝ **22分だけ新しくて生き残っただけ**。
    次回で消える。
  - `modal.Period(days=1)` がデプロイでタイマーを巻き戻す件は、実際には
    **デプロイ直後にも1回走る**挙動で、頻繁なデプロイでも空振りしていなかった。
    ログで確認するまで断定しないこと（CLAUDE.md §0）。
- **自動で走らないのは `admin_cleanup_volume`（既定3日）だけ。** スケジュール無しの
  手動関数なので、`outputs/<fc-id>/config.yaml` のような作業ディレクトリの残骸は
  admin が実行するまで残る。

### 反映状況 — 2026-09-21 時点ですべて適用済み

- Vercel デプロイ（push `76d8820` — LP 文言 `f72141a` を含む）
- `modal_lora_worker.py` のデプロイ（`76d8820`・7.7秒・image 再ビルドなし）
- 以下は 2026-09-20 時点で適用済み:
- Vercel デプロイ（push `69f7750`）
- マイグレーション `20260888000000_lora_pricing_gui_default_measured.sql`
- `modal_lora_worker.py` のデプロイ（7.2秒・image 再ビルドなし・エンドポイント URL 不変）

**適用順序は Vercel → SQL を守ること。** コード側 `DEFAULT_KNOBS` が先に出ていれば、
DB 適用前でもフォールバックで新しい値が使われ、古い価格で生成が走る隙間ができない。

---

## 次の一手（優先度順）

0. **クレジット販売プランを確定（2026-09-23）。** ¥1,980/800C → ¥29,800/18,000C の 5 段＋都度 ¥1,000/300C、
   有料ボーナス一律 10C/日、無料ストリーク廃止。Polar 適用・コード反映済み（`docs/pricing-decision-sheet.md`）。
   トップページの文言はホストが自分で修正中（Claude 側の課題から外す）。料金ページは後回し可。
0'. **ローンチ価格の決定（2026-09-22 着手）。** 機能別の GPU / 実測 / 原価 / 価格 / 粗利を
   `docs/pricing-decision-sheet.md` に集約した。**ホストが「決めること」7点に答えるのが次。**
   答えが出れば knob 引き直し（GPU代0）＋実測4本（合計 ¥300 程度）＋公開料金ページで完了。

1. **次の LoRA ジョブの `metadata.metrics` を見て prep 固定費を校正する（GPU代ゼロ）。**
   2026-09-21 に計測保存を入れた（`59dd839`）。ジョブが1本走るだけで
   `s_per_it` / `prep_s` / `model_load_s` / `latent_cache_s` / `jit_s` と条件一式が
   job 行に入る。確認する knob は `lora_prep_load_s`（828）と
   `lora_prep_per_image_s`（1.33）。
   - 参考: 同一構成でも prep はキャッシュ温度で **1,272.8 → 517.6秒** と動く
     （docs §14.8.1）。**冷キャッシュ基準のままにするのが妥当**（安く見積もって
     冷えていたら原価割れする方が危険）。

2. **ローンチ時に何モデル出すかの経営判断。** `TARGET_MODELS` 14本のうち実測済みは
   minimax_h3 だけ。未実測 arch は推測価格で、**cost-guard は見積もりの約2.8倍まで
   耐える**ので「ジョブが殺される」事故にはなりにくいが、推測が高すぎた場合は
   初回ユーザーが払いすぎる。売りの中心だけ測って出す（1本 ¥300〜500）か、
   14本全部推測価格で出すかはホスト判断。

3. **SDXL の残りは実機ものだけ。** cost-guard / salvage / UI は実装済み（上記）。
   残るのは **B300 vs L40S の実測 $/job 比較**と、現行 `sdxl: 0.642`
   （AdamW8bit + gc 有効で測った値）の再確認。gc は 2026-09-20 に既定 OFF に
   なった＝実運用はこれより**速い**見込みなので、0.642 は過大見積もり＝安全側。
   急がない。

4. **Polar API の 2026-10 移行。** 現在 2026-04 固定。2027年1月のローテーションで
   2026-04 が削除されるため期限付き。メモリ `polar-api-version-migration`。

5. **画像系 arch の prep 実測**（2 の仕組みで自然に溜まるので、能動的にやる必要は薄い）。

### 【決定 2026-09-23】R2 を成果物ストレージにする — **今すぐ実装する**（同日夕方にホストが前倒し）

ホスト: 一度「ローンチ直前に」としたが、rclone マウントで操作感を確認して「速度は全然 OK・当分 10GB は
越えなそうだからもう実装する。DL/UL ツールも」→ **次のセッションから下の 1→2→…の順で着手**。
rclone は導入済み（remote `r2`、デスクトップの `ULL-R2-mount.bat` / `ULL-R2-unmount.bat`、`R:`）。**既存の成果物は移行せず Modal に置いたまま 14 日パージで消える**。
ローンチ後の新規はすべて R2。速度テスト済み（gpu-benchmarks §16.5、R2 → PC 34〜46 MB/s、Modal → R2 48〜53 MB/s）。
資格情報は `.env.local` の `R2_*` と Modal secret `r2-artifacts`（メモリ `r2-artifact-storage`）。
Volume `ull-wan-models` は **847GB / 1TB**（LTX の不要モデル削除後、ホスト申告 2026-09-23）で、モデル重みだけ残す。

**実装計画（着手時にここから始める。対象コードは調査済み）**

1. **共通層**: `src/lib/r2.server.ts`（S3 クライアント・署名付き GET/PUT・キー規約 `<kind>/<user_id>/<job_id>/<file>`）と
   worker 側 `ull_r2.py`（boto3、`TransferConfig(multipart_chunksize=64MB, max_concurrency=16)` 固定、
   `put_file` / `put_bytes` / `presign_get`）。Modal secret `r2-artifacts` を各ワーカーへ付与。
2. **LoRA 成果物**（最初）: `modal_lora_worker.py` / `modal_sdxl_lora_worker.py` の完了処理
   （`loras/<user>/<job>/` へ書く箇所）で R2 へ put し、`metadata.checkpoints[].r2_key` を持たせる。
   `src/app/api/studio/lora/checkpoint/route.ts` は `r2_key` があれば R2 署名付き URL（15 分）を返し、
   無ければ従来の Modal `download_lora_checkpoint`（14 日で自然消滅する旧ジョブ用）。
   一括 ZIP（`download_lora_selection`）は R2 上のオブジェクトを CPU 関数で束ねるか、UI 側で並列 DL に置換
   （4 並列で 70 MB/s 出るので ZIP 化しない方が速い）。dataset.zip / LICENSE.txt も同じ経路。
3. **生成物**: `modal_seedvr2_worker.py`（`upscale_image_results` / `upscale_video_results` / `upscale_originals`）、
   `modal_wan_animate_blackwell.py`（`director_results/<user>/<job>.mp4`）、angle / custom_workflow の結果を
   R2 へ。`download_upscale_*` / `download_director_video` の呼び出し元（`src/lib/directorVideoDownload.server.ts`、
   `src/app/api/studio/upscale/*/result`）を R2 署名付き URL へ。
4. **ユーザー持ち込み**（`studio_uploads` / `lora_dataset_uploads`）: ブラウザ → R2 署名付き PUT へ切替、
   worker はジョブ開始時に R2 から取得。`studioUploadTicket.server.ts` / `studioUploads.server.ts` /
   `upload_lora_dataset_batch` が対象。§15 のアップロード速度（18 Mbps 頭打ち）もここで解消見込み。
5. **保持**: R2 バケットにライフサイクルルール「14 日で削除」。`modal_retention_purge.py` の Volume 側は
   旧データが尽きるまで残す（`DEFAULT_BUCKETS` から外さない、CLAUDE.md §6-5）。
6. **admin**: 「最近の生成物」タブとバケットブラウザ（`src/lib/generatedStorage.ts`、`admin_zip_volume_folder`）を
   R2 の一覧・署名付き URL に向ける。`GpuCostReferenceCard` 同様に Volume 残量表示はモデル分だけになる。
7. **切替**: 環境変数 `ARTIFACT_STORE=r2|volume` で全ワーカー・全 route を一括切替（ロールバック可能に）。
8. **DL/UL 体験**（ホスト要望 2026-09-23）: R2 の署名付き URL は Range・並列に対応するので、①完了画面に
   「URL 一覧をコピー」（自作ダウンローダー・aria2 等にそのまま渡せる）を移行と同時に。②ローンチ後の
   最初の改善として **ブラウザ内の転送パネル**（File System Access API + Range 並列 fetch + IndexedDB で
   レジューム、UL は S3 マルチパートの署名付き URL を並列 PUT）。前提として R2 バケットの CORS
   （GET/PUT、Range、ETag 公開）を設定。Firefox/Safari は通常リンクへフォールバック。
9. **admin の整理作業は R2 をエクスプローラーにマウントして行う**（rclone + WinFsp、または Mountain Duck）。
   admin「最近の生成物」タブは一覧と署名付き URL 表示に縮め、ファイル操作 UI は作り込まない。
   admin が遅い真因は Next → Modal エンドポイント → Volume の経路でコンテナ起動を毎回踏むことで、R2 で経路ごと消える。

規模: 2 が半日〜1 日、3 と 4 が 1〜2 日、5〜7 が半日。順に PR を分ける。

#### 【完了 2026-09-23 夜】1（共通層）と 2（LoRA 成果物）を実装・**本番反映済み**（`dbe9752` + 修正コミット、Vercel READY、Modal 2 本デプロイ済み）

**できたこと（ローカル検証済み）**
- 共通層: `ull_r2.py`（boto3、`TransferConfig` 64MB×16 固定、`put_file/put_bytes/presign_get/head/list_keys/delete_prefix`、
  `publish_job_dir()` = ジョブフォルダを R2 へ上げて `checkpoints[].r2_key` を焼き込み、サイズ検証後に Volume 側を unlink）と
  `src/lib/r2.server.ts`（`@aws-sdk/client-s3` + presigner、`presignR2Get/presignR2Put/headR2`、`r2Enabled()`）。
  切替は両側とも env `ARTIFACT_STORE=volume` で Volume 経路へ戻る（既定 `r2`）。資格情報が無ければ fail-open で Volume。
- worker: `modal_lora_worker.py`（train image 末尾に `boto3` + `add_local_python_source("ull_r2")`、`train_lora_job` に
  secret `r2-artifacts`、完了処理で `publish_job_dir` → `metadata.artifact_store="r2"` / `r2_prefix` / `r2_extra_keys`）。
  `modal_sdxl_lora_worker.py` も同様（`_publish_r2()` を成功・安全停止・失敗救出の 3 経路から呼ぶ。LICENSE.txt も同 prefix）。
  ai-toolkit 側の CPU salvage（`salvage_lora_job`）は Volume のまま（失敗ジョブのみ・後回し）。
- Next: `checkpoint` route は `r2_key` があれば R2 署名付き URL（15 分、`Content-Disposition: attachment`）、無ければ従来 Modal。
  `selection` route は全件 `r2_key` なら `{store:"r2", files:[{filename,url,sizeBytes}]}` を返し、UI が **iframe で並列 DL**
  （ZIP 化しない）。混在・旧ジョブは従来の ZIP。`bundle` route は `want=final|dataset` を metadata の R2 エントリから
  直接解決（Modal probe を踏まない）。完了画面に「📋 選択したファイルの URL 一覧をコピー」を追加（計画 8-①、両ストア対応）。
- 検証: `ull_r2` をローカルで実バケット往復 OK。`modal run modal_r2_probe.py`（CPU）で secret・image・96MB マルチパート・
  署名 GET・ローカル削除まで OK。`tsc --noEmit` / eslint グリーン。
- Vercel 環境変数 `R2_*` 4 つを REST API で production/preview/development に追加済み（2026-09-23）。
- R2 バケットのライフサイクル（14 日）と CORS を適用済み（`scripts/r2_bucket_setup.py`、冪等なので再実行可）。

**残り（この順で）**
1. ~~バケット設定~~ **完了（2026-09-23 夜）**: トークンを Admin 権限に上げて `scripts/r2_bucket_setup.py` を再実行。
   ライフサイクル 14 日＋不完全マルチパート 1 日＋CORS（GET/HEAD/PUT、Range/ETag 公開）が適用済み（読み戻しで確認）。
2. ~~コミット → push → modal deploy~~ **完了**: Vercel READY 確認後に `modal_lora_worker.py`（27 秒）と
   `modal_sdxl_lora_worker.py` をデプロイ。SDXL は初回 `train_image` のチェーン位置ミス（`.env({...}` の dict に
   `.pip_install`）で落ち、修正して再デプロイ（10 秒）。**py_compile では見つからない種類のミス**なので image 変更後は
   必ず `modal deploy` の結果まで見る。
3. **実 LoRA ジョブ 1 本目（minimax_h3・500step・220枚・job `cbeb0865`、2026-09-23 18:38〜19:09 JST）の結果**:
   - **R2 への put は 5 ファイル全部成功**（591MB×4 + dataset.zip 31MB = 2,396MB）。ただし GPU コンテナからの速度は
     14.6 / 2.4 / 33.5 / 32.0 / 7.6 MB/s とバラつき、合計 327 秒 = **B300 が 5.5 分アイドル（約 $0.65）**。
   - **バグ**: publish が Volume 側を unlink した後、`return` 内の `dest_path.stat()` が `[Errno 2]` → except が
     failed + 1,389C 返金で completed 行を上書き（metadata.checkpoints も消えた）。ファイルは R2 に揃っている。
     → **行の手動修復はまだ**（Claude の DB PATCH が権限で止まった。ホストが許可すれば `status=completed` と
     `checkpoints[].r2_key` を R2 の一覧から復元できる）。返金は済んでいるのでそのままでよい。
   - **対策（実装・デプロイ済み、同日 19:40 JST）**: アップロードを GPU から外した。GPU 関数はジョブ行を PATCH して
     即 return し、CPU 関数 `publish_lora_artifacts_r2(job_id)` / `publish_sdxl_artifacts_r2(job_id)` を spawn。
     そちらが行の `checkpoints[].path` を見て Volume → R2 へ上げ、`r2_key` を焼き込んで metadata だけ PATCH し、
     Volume 側を消す（`ull_r2.publish_job_meta_from_volume`）。上がるまでの間は DL route が Modal 経路に落ちるので
     ユーザーからは切れ目なし。`return` の `size_bytes` もファイルに依存しない値にした。
   - **metrics（prep 校正用・冷キャッシュ寄り）**: prep_s 863.7（model_load 682.6 + latent_cache 110.7）、jit_s 70.4、
     s_per_it **0.31**（tqdm の trimmed 平均）。stage 2 全体 1,138s → 学習部分は壁時計で約 0.41〜0.55 s/it。
     **knob の 1.80（docs §14.15）と 3〜6 倍ずれる**。§14.15 の条件（枚数・rank・実効バッチ・compile）と突き合わせて
     から判断する。1 点で knob は動かさない（CLAUDE.md §0）。preemption（CPU 準備段階）も 1 回踏んだ。
4. **実地確認 完了（2026-09-23 19:50 JST）**: (a) `cbeb0865` の行を R2 の一覧から `completed` + `checkpoints[].r2_key`
   に修復（ホスト承認）。(b) デプロイ済みの CPU 関数 `publish_sdxl_artifacts_r2` を過去ジョブ `e1204316`（SDXL、Volume
   上に 4 ckpt + dataset.zip + LICENSE.txt）に直接呼び、**5 ファイル 1,009MB を 70 秒で移行**（CPU コンテナから
   10〜20 MB/s、コールド込み 87 秒）。metadata に `r2_key` / `artifact_store` / `r2_publish` が入り、HEAD と Range 付き
   署名 GET（206）まで確認。**UI 側もホストが確認済み（2026-09-23 20:10 JST）**: 完了画面で 4 本選択 → 並列 DL、**1 本あたり約 20 MB/s（合計 約 80 MB/s）**。Modal 直の 3〜7 MB/s から 10 倍超。
   (c) minimax_h3 の s/it・prep を §14.15 と突き合わせて knob を引き直すかは**未判断**。
   - 速度メモ: Modal → R2 は GPU/CPU どちらのコンテナからも 2〜33 MB/s で、§16.5 の 48〜53 MB/s は再現していない
     （§16.5 は Volume 上の大きい 1 ファイルを測った値。ファイル 230〜590MB だと 64MB パートが 4〜10 個で並列が
     効き切らない可能性）。CPU に逃がしたので原価への影響は無いが、DL 開始までの待ちにはなる（1GB で 1〜2 分）。
5. 計画 3（生成物）・5〜9 は未着手（4 は下）。admin「最近の生成物」（計画 6）が R2 対応するまで、新規 LoRA 成果物は admin のバケット
   ブラウザに出ない（rclone マウント `R:` で見る）。

#### 【実装 2026-09-23 深夜】4（ユーザー持ち込み）— ブラウザ → R2 直 PUT へ切替（ホスト指示で 3 より先に着手）

**できたこと（ローカル検証・Modal 3 本デプロイ済み・Next は `e895814` を push、Vercel production READY 確認済み）**
- **Studio 共通の一時アップロード**（超解像 単発/バッチ/動画・Multi-Angle・特化ワークフロー・Director の 5 route）:
  `uploads/token` route が既定で **R2 の署名付き PUT URL**（`store:"r2"`、TTL 30 分）を返し、`studioUploads.ts` が
  そこへ `fetch(PUT)`（瞬断 3 回再送）。`storagePath` の形 `<userId>/<filename>` は不変。読む側
  （`studioUploads.server.ts`）は **R2 に HEAD → あれば R2 の署名付き GET、無ければ従来の Modal**（切替をまたいでも壊れない）。
  後片付けは R2 を常に削除、Modal の delete は `UPLOAD_STORE=volume` のときだけ（コンテナ起動を避ける）。
- **LoRA データセット**: `dataset-upload-token` route が `filenames[]` を受けて **1 枚ごとの署名付き PUT URL** を返す
  （500 枚でも署名は Vercel 内の CPU だけ、往復 1 回）。`loraApi.ts::uploadLoraDataset` は WebP 変換 → チケット →
  XHR PUT ×16 並列（進捗はバイト単位のまま）。`store:"modal"` が返れば従来のバッチ/単枚 POST にそのまま落ちる。
- **worker**: `_read_lora_dataset_upload` は **Volume に無ければ R2**（`lora_dataset_uploads/<key>`、Volume と同じ相対パス）。
  `_delete_lora_dataset_uploads` は R2 側も消す。`ingest_image` に boto3 + `ull_r2` と secret `r2-artifacts` を追加。
  SDXL worker も同じフォールバック。SeedVR2 の `_ALLOWED_IMAGE_HOSTS` に `r2.cloudflarestorage.com` を追加
  （超解像 画像/動画は Next が署名付き GET を worker に渡す経路。ffprobe も同 URL で Range が効く）。
- **切替 knob**: Next 側 `UPLOAD_STORE=r2|volume`（未設定なら `ARTIFACT_STORE` に従う）。成果物側と独立に戻せる。
  worker 側に knob は無く「両方見る」だけなので、戻すときは Vercel の env だけでよい。
- **実測（2026-09-23、ローカル Node → R2）**: 署名付き PUT の `X-Amz-SignedHeaders=host` のみで **Content-Type は署名に
  含まれない**（別の Content-Type で PUT しても 200）。3MB 単発 PUT 7.2 MB/s（TLS 込み）。Range GET 206 OK。
  `ull_r2.get_bytes` 300KB 0.47 秒、欠損キーは `NoSuchKey` を `RuntimeError` に包んで train/ingest の既存の失敗経路へ。
- **デプロイ**: `modal_sdxl_lora_worker.py`（4.9 秒）、`modal_seedvr2_worker.py`（image 変更なし）、`modal_lora_worker.py`
  （ingest_image 再ビルド、18 秒）。デプロイ後にデプロイ済みの CPU `ingest_and_optimize_dataset_cpu` を R2 上の probe
  データセット（2 枚）で直接呼び、**R2 読み出し → 最適化 → R2 原本の削除まで通し OK**（11.7 秒、GPU 不使用）。
  Volume に `_lora_persist/r2probe-*/_ingest` の小さな残骸あり（数 KB、latent cache の掃除で消える）。**順序は Modal → Next**（Next を先に上げると SeedVR2 が R2 の URL を host 不許可で弾く）。

- **事故（2026-09-23、反映直後）**: ホストの超解像 画像で `Failed to fetch`。原因は **切替前から開いていたタブの古い JS
  バンドル**が、新チケットの R2 URL に Modal 方式の `POST` を投げていたこと（R2 の CORS は GET/HEAD/PUT のみ →
  プリフライト 403 → `Failed to fetch`）。サーバー側・R2 側は正常（本番 Vercel 発行の URL で Node と実 Chromium
  （本番オリジン）から PUT 200 を確認）。対処: `sizeBytes` を送ってこない古いクライアントには Modal チケットを返す
  互換フォールバックを追加（LoRA 側は `filenames` 無し → Modal チケットで最初から互換）。**ホストはタブを再読み込み。**

**残り（この順で）**
1. **実地確認 (a) 超解像 画像は OK（2026-09-23 20:42〜20:45 JST、ジョブ `af14dbfe`）**: 3.8MB PNG がブラウザ → R2
   `studio_uploads/` に着地 → Next が R2 に HEAD → 署名付き GET を worker に渡し、worker（SeedVR2 app、Real-ESRGAN anime）
   が R2 から取得して 38 秒で完了（入力 1088×1920）。R2 経路で初の本番ジョブ成功。
   **残りをホストが実地で 1 本ずつ**（本番反映済み。**タブを再読み込みしてから**）: (a) 超解像 画像（署名付き GET を worker が fetch）、
   (b) 超解像 動画（ffprobe + worker、1GB 級）、(c) Multi-Angle / Director / 特化 WF（Next が R2 から Buffer 取得）、
   (d) LoRA データセット 100 枚超（`[lora-upload]` のコンソール行で Mbps を見る。§15 の 18.1 Mbps が基準）。
2. (d) の実測を `docs/gpu-benchmarks.md` §15 に追記し、`R2_CONCURRENCY`（16）を必要なら調整。
3. `modal_studio_uploads.py` と `upload_lora_dataset_batch/_image` は **消さない**（`UPLOAD_STORE=volume` の受け皿。
   Volume 側の残りは `modal_retention_purge.py` の 14 日パージが拾う）。

**実測メモ**: CPU probe（96MB・2 パート）は put 5.5 MB/s・GET 19.8 MB/s と §16.5 より遅いが、ファイルが小さく並列が
効かない条件なので参考値。実ジョブ（数百 MB〜GB）で再確認する。

### 残課題: LoRA の「結果がいまいちな時」ヒント（2026-09-23、ホスト発案・未着手）

置き場は 2 つ: ①ローンチ時に作る FAQ ページ（AI クローラー対策の FAQ と兼用、`launch-checklist-ai-seo`）、
②LoRA 完了画面に 3 行程度の短いヒント＋FAQ へのリンク。**書くのは実測・実案件で確かめたことだけ**
（一般論の受け売りは書かない）。現時点で根拠付きで書けるのは:
1. 顔が弱い → 最終より中間チェックポイントを見比べる（実案件で 3,000 中 1,750 が最良）。
2. 男性が女性っぽい → 生成側のネガティブ「ugly／醜い」が被写体の特徴を打ち消す。
3. t2i は出るが i2i で差し替わらない → ControlNet で構図固定＋高 denoise、または顔だけ高 denoise。
4. rank を上げても変わらない → rank 32 と 64 で顔の差なし・時間も価格も同じ（効くのは LoCon と repeats）。
5. 男女ペアで男性だけ甘い → ベースモデルの偏り。男性の repeats を上げる（実案件 ×5）。
「rank を上げてみろ」は実測で効かなかったので書かない。

## 踏み抜きやすい地雷

- **合成データのベンチ（`modal_lora_benchmark.py`）の s/it を価格に使わない。**
  同一条件で実写と **9倍** ずれる（0.20 vs 1.80）。画素数を揃えアスペクト比を
  混在させてもダメだった。値付けは必ず実ジョブのログから取る（docs §14.15）。
- **「実測データが無い」と判断する前に `docs/gpu-benchmarks.md` を grep する。**
  実測は DB にも git log にも残っていないが docs には詳細がある。2026-09-20 に
  これを見落として「実績が1件も無い」と誤報告した。
- **メモリは書かれた時点の情報**。以下は既に古い:
  - `lora-pricing-stage1` の「PR #13 未マージ」→ **マージ済み**
  - `upscale-studio` の「多段カスケード要方針決定」→ **実装済み**（×4=2段 / ×8=3段、
    課金係数も knob 化済み）

---

## 決まっていること（蒸し返さない）

- LoRA の値上げ（1.6倍 → 3.0倍 markup）は**ホスト判断で受け入れ済み**。
  理由:「実態がこれなんだから、それに合わせた価格にするしかない。特に今は
  minimax の LoRA の競合があまりいない」（2026-09-20）。
- UI の step スライダー上限は **20,000 据え置き**。s/it 倍増で 12h の壁が約 17,300
  step に下がり上限の内側ではなくなったが、17,300 step は 18,308C のジョブで
  現実には選ばれない。軽い arch の自由度を削らない方を採った。
