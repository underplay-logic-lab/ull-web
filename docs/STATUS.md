# STATUS — 今どこまで進んでいるか

**このファイルの役割**: セッションをまたぐ引き継ぎの唯一の正。`/clear` 直後に
「残課題を進めて」「続きをやって」と言われたら、**推測で候補を並べて質問する前に
まずここを読む**。CLAUDE.md は「守るべきルール」、docs/*.md は「実測と経緯」、
メモリは「背景と方針」で、**「今どこか」を書くのはここだけ**。

**更新のタイミング**: 作業の区切りごと（コミットした／方針が決まった／実測が
出た／残課題が増減した）。セッションの終わりに必ず見直す。

最終更新: 2026-09-21

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
3. `wai_illustrious` プリセットを追加（`loraModels.ts` + sd-scripts 側の
   `SDXL_TARGET_MODELS` にローカルパスで1行）。単一ファイル経路（`_resolve_base_model`
   の custom 分岐）は**未検証**なので実ジョブ1本で確定させる。ついでに SDXL の
   s/it と prep の実測も取れる。

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
