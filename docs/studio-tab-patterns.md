# Studio タブ実装パターン（詳細・経緯）

CLAUDE.md §6 から退避した「各ルールの背景・実例・実装上のハマりどころ」のアーカイブ。
CLAUDE.md にはチェックリストだけを残し、その根拠と手本をここに置く。

**新規Studioタブを作るとき、または既存タブのジョブ処理を触るときに読むこと。**

---

## 1. ジョブ結果はリロードしても消えない

ジョブ送信時に `saveFormState(JOB_KEY, {jobId})`（`src/lib/studioFormPersistence.ts`）を **1回だけ** 呼ぶ。
**完了・失敗時にクリアする呼び出しを書かない**こと（`saveFormState(JOB_KEY, {jobId: ""})` のようなクリアはNG）。

次に新しいジョブを送信したときだけ上書きされる、というのが唯一の更新経路。
こうすることで「リロードすれば常に最後のジョブの現在状態（完了済みなら結果、実行中ならポーリング再開）が出る」という一貫した体験になる。

- 元祖: Multi-Angle / LoRA タブ
- 超解像タブで一度これを間違えた（完了時にクリアしてしまっていた）実績あり
- 意図的にクリアしたい特殊事情がある場合のみ例外とし、コメントで理由を明記する

---

## 2. 「ジョブが見つからない」は専用エラーとして扱う

ポーリング先の行が14日自動パージ等で本当に存在しない場合（Supabase `.single()` の `PGRST116`）と、
一時的な通信エラーを **区別すること**。

前者を後者と同じ「時間をおいて再読み込みしてください」で案内すると、リトライしても永久に直らない誤案内になる。

**実装**: `XxxJobNotFoundError` のような専用例外クラスを投げ、ポーリングループでは即座に
「生成から14日以上経つと自動的に削除されます。新しく生成してください」という趣旨の案内を出して諦める
（`localStorage` の参照もこのケースだけ例外的にクリアしてよい）。

**手本**: `src/lib/upscaleApi.ts` の `UpscaleJobNotFoundError`、`src/lib/angleApi.ts` の `AngleJobNotFoundError`

---

## 3. Active VRAM バッジ表示

CLAUDE.md §2 のネタバレ防止仕様に準拠。生成中・完了後に共有コンポーネント
`src/components/studio/VramBadge.tsx`（`<VramBadge gb={...} />`、`gb == null` なら何も描画しない）を必ず使う。

ワーカー側のテレメトリキーは全系統で `vram_used_gb`（GB・1桁丸め、`torch.cuda.mem_get_info()` ベース）に統一する。

- **非同期タブ**（ジョブ行を作ってポーリングする方式）:
  ワーカーは処理中スレッドから ~8秒毎に `metadata.vram_used_gb` を PATCH してライブ更新し、
  完了時は `vram_peak_gb`（処理中ピーク値）も書く。
  フロントは進行中バッジに `vram_used_gb`、完了後の結果表示に `vram_peak_gb` を出す。
- **同期タブ**（HTTP応答で完結、ポーリングなし）:
  ワーカーの戻り値 dict に `vram_used_gb` を含め、API route がレスポンスへそのまま素通しし、完了時に一度だけ表示する。

---

## 4. 4.5MB を超えうるファイルアップロードは直接 Storage アップロード必須

Vercelのサーバーレス関数はリクエストボディに **約4.5MBのハード上限**があり（プラットフォーム側の制限。
`next.config` 等アプリ側の設定では変更不可）、API routeが `request.formData()` で生ファイルを直接受け取る実装は、
超過時にアプリのコードに一切到達せず問答無用で `413 Payload Too Large` を返す。

**実測（2026-09-12・本番 `www.ullstudio.com` に対して直接検証）**:
画像超解像は「25MBまで対応」、動画超解像は「60MBまで対応」とそれぞれ表示していたが、
実際は **どちらも4.5MBちょうどで即座に弾かれていた**（表示自体が実態と乖離した嘘になっていた）。

**対策**: 4.5MBを超えうるアップロード（動画・複数枚画像・音声等）を扱う新規タブでは、着工前に必ずこの制限を意識し、
**クライアントから直接 Supabase Storage へアップロードし、API route にはファイル本体ではなく storage path だけを渡す**方式にする
（route側は `supabaseAdmin.storage.from(bucket).download(path)` で server-side に取得する
— service roleからの取得はVercelのリクエストボディ上限と無関係）。

**手本**: `src/lib/loraApi.ts` の `uploadLoraDataset`
（コメントに "bypassing Vercel's 4.5 MB request body cap" と明記済み）

> ⚠️ なお 2026-09-18 以降、大容量バイナリは Supabase Storage ではなく **Modal 直**が標準
> （CLAUDE.md §1 の該当項目を参照）。この4.5MB制限の話は「Vercelを経由させない」という点では今も有効。

---

## 5. 生成物は同期/非同期を問わず必ず永続ストレージへ保存する

「特化ワークフロー」（`/api/studio/custom-workflows/generate`）が HTTPレスポンスで base64 を返すだけの同期実装のまま
長期間サーバー側に一切保存しておらず、ユーザーがその場でダウンロードし忘れると生成物が永久に復元不能という欠陥が発覚
（ホスト報告、2026-09-13）。

Multi-Angle/超解像のような非同期タブは元々ジョブ行＋Storage保存が必須構造なので問題にならないが、
**同期タブ（HTTP応答で完結する方式）ほどこの罠に陥りやすい**。

**新規タブが同期・非同期いずれの方式でも、生成成功時に必ず**:
1. 結果を公開Storageバケット（`angle-results`/`upscale-results`/`custom-workflow-results` と同じパターン、
   `<user_id>/<uuid>.<ext>` 配置）へアップロードする
2. `generation_jobs`（または専用テーブル）に `status: "completed"` の行を1件残し、後から辿れるようにする
3. 新設したバケット名を `modal_retention_purge.py` の `DEFAULT_BUCKETS` と
   `src/lib/generatedStorage.ts` の `GENERATED_BUCKETS` の**両方**に追加し、
   14日自動パージと admin バケットブラウザの対象に確実に含める
   （追加を忘れると際限なく溜まり続けるか、admin から見えないまま放置される）

これらはベストエフォートでよい（保存に失敗してもユーザーへ返すメインの生成結果は落とさない）。

**手本**: `src/app/api/studio/custom-workflows/generate/route.ts` の `persistCustomWorkflowResult()`

---

## 6. コールドスタート中は「起動待ち」と分かる専用表示にする

ホスト報告、2026-09-13: Multi-Angle にだけ実装され、超解像等への横展開が漏れていた。

非同期タブの多くはジョブ行を「まだ実処理が始まっていない初期状態」
（`angle_jobs`/`upscale_jobs` は `status: 'pending'`、`generation_jobs` は `status: 'queued'`
— テーブルにより文字列は異なるが役割は同じ）で作り、
ワーカーが実際にコンテナ内でコードを実行し始めた瞬間（GPUのコールドブート・モデルロードが終わった後ではなく、ジョブ関数の先頭）に
`status: 'processing'` へ PATCH する、という2段階の遷移を既に持っている。

この「insert時点の初期ステータス」と「processing」を**フロント側で区別せず**、ずっと同じ「生成中…」を出し続けるタブがあり、
コールドスタート（初回1〜2分）の間ユーザーが「固まった」と誤解する原因になっていた。

**対策**: ジョブが `pending`/`queued` 相当の間は
**「生成準備中…GPUを起動しています（初回は1〜2分ほどかかります）」のような起動中専用の文言**を
ボタンラベル・進捗表示の両方に出し、`processing` に上がってから初めて通常の「生成中 X/Y」表示に切り替える。

**手本**: `MultiAngleStudioTab.tsx`（`job?.status === "pending"` で分岐）、
より高度な例として `LoraStudioTab.tsx`（経過時間に応じた文言のグラデーション）

**同期タブ**はこの区別ができない構造的な制約があるため、コールドスタートを利用者に見せたいなら
非同期（ジョブ行＋ポーリング）化が前提になる。

### 既知の未対応（意図的に保留中）

「特化ワークフロー」（`CustomWorkflowsTab.tsx` / `/api/studio/custom-workflows/generate`）は今も完全同期実装で、
ジョブ行・ポーリングの仕組み自体が無いため、この項目にまだ対応できていない。
2026-09-13時点でホストの判断により「使い道がまだ明確でないので保留」。

対応するなら §5 で既に追加した `generation_jobs`（`workflow_type: 'custom'`）書き込みを土台に、
Cinematic Director（`DirectorStudioTab.tsx` / `src/app/api/director/generate/route.ts`）と同じ
非同期ジョブ＋ポーリング構成へ作り替えるのが最短経路。

---

## 7. 実行中でも次のジョブを出せるようにする

2026-09-14 追加。GPUジョブを伴うタブは、既存ジョブの実行中でも新しいジョブを受け付けられるようにする。
**バックエンドの Keep-Warm 設定で実装パターンが変わる**ので、新規タブを作る際は該当ワーカーの `scaledown_window` をまず確認する。

### `scaledown_window=30` 系（Multi-Angle / 超解像 / Director 等、連続生成UXがあるタブ）

「順番待ち（無料・既定）」と「並列実行（追加料金）」を選ばせる。

1. **warmカウントダウン**: 共有フック `src/hooks/useLocalWarmCountdown.ts`
   （`markWarm()` をジョブ完了時に呼ぶ、DB・共有状態不要のタブ内ローカル実装。
   旧 `gpu_warm_status` 共有テーブル方式は 2026-09-12 に横取り問題で全廃止済み）を使い、
   完了後「あと30秒以内ならコールドスタートなしで生成できます」を表示する。

   ジョブが「実際にこのポーリングセッション中に実行中状態を経由してから完了した」場合だけ warm 扱いにすること
   （タブ再読み込み直後に「とっくに完了済みのジョブ」を検知したケースを誤って warm と案内しないため）。

2. **キュー選択モーダル**: 生成ボタンはジョブ実行中も押せる状態にしておき（`disabled` に実行中フラグを含めない）、
   押すと選択モーダルを出す。

   - 順番待ちは現在のフォーム入力を**その場でスナップショットして**ジョブ完了検知時に自動発火する
     （発火時点の変わっているかもしれない state を読んではいけない）。
   - 並列実行は待たずに新しいGPUコンテナを起動する分のコールドスタート原価を追加課金する専用knob
     （`angle_priority_parallel_surcharge` に倣い `<feature>_priority_parallel_surcharge` 命名、
     原価 = cold_start_grace_s系knob × gpu_jpy_per_hour_b300 ÷ credit_to_jpy に他の単価と同じ3倍markupを掛けた概算値）を用意する。

   **追加料金が正当化できるのは「待てば温かいコンテナを再利用できる」場合だけ。**

**手本**: `MultiAngleStudioTab.tsx`（2026-09-14 実装）

### `scaledown_window=2` 系（LoRA等、常駐しない長時間バッチジョブ）

warmカウントダウンは意味が無い（常に即切りで温かい状態が存在しない）ので実装しないが、
**並列実行だけは追加料金なしで提供する**。

理由: 順番待ちしても並列実行しても、どのみち毎回フルのコールドスタートが必要でコスト差が発生しない
（＝待たせる理由がそもそも無い）ため、コールドスタート原価の上乗せロジックは適用できない。

LoRAは学習が数時間かかり「1件目が終わるまで2件目を出せない」のはUX上の実害が大きいため、むしろこちらの方が優先度が高い
（2026-09-14 ホスト指摘、**未実装** — LoRAタブは既存の単一ジョブ追跡UIを複数ジョブ同時追跡に拡張する作業が必要）。

### 実装上の注意（Multi-Angle 実装時にハマった点）

`scaledown_window=30` 系で特に該当:

1. **「実行中でもキュー選択に進めるべき」チェックは、既存の `insufficientCredits`（現在の1回分の与信）チェックより*先*に置く**
   — 1件目の課金直後で残高が減っている状態だと、無料のはずの順番待ちにすら辿り着けなくなる。
2. **ポーリングの長寿命な `useEffect` から「予約中の次の1件」を読むための ref は、*イベントハンドラでのみ書き込み*、
   effect内で毎レンダー同期する実装にしない**
   （このプロジェクトの eslint-plugin-react-hooks が `react-hooks/immutability` / `react-hooks/refs` /
   `react-hooks/set-state-in-effect` でこの手のパターンを検出して弾く）。
   ポーリングeffectが呼ぶ「次を発火する関数」自体は `useCallback` で安定させ、依存配列に含めてよい。

---

## 8. 対応外のファイルを選んだ時は必ずエラー表示する（黙って無視しない）

2026-09-15、ホスト報告: Cinematic Director に動画ファイル(MP4)をドロップしたら、
プレビューも出ずエラーも出ず、何も起きなかったように見えた。

画像アップロードのドロップゾーンで `file.type.startsWith("image/")` のような型チェックだけを条件に
「一致しなければ `onFileSelected`/`onAdd` を呼ばない」実装は、
ユーザーからは「読み込まない」としか見えない原因不明の沈黙になる。

**対策**: 型チェック自体は変更先（親コンポーネントの `onFileSelected`/`onAdd` ハンドラ）に持たせ、
**ドロップゾーン側は picked file があれば常にハンドラへ渡す**。
ハンドラ側で型が不正なら専用のエラー文言
（`file.type.startsWith("video/")` なら「動画ファイルは使えません。〜」のように原因を具体的に案内。
動画専用の別タブがあるならそちらへの誘導も添える）を既存のエラー表示state（`imageError`/`errorMessage` 等）にセットする。

複数ファイルを一括処理するバッチ/ZIP系の取り込み（`LoraStudioTab.tsx` の `addImages`、
`UpscaleStudioTab.tsx` の `addBatchFiles`）でも同様に、フィルタで弾いた件数・ファイル名を集計してエラーメッセージにまとめる。

**手本**: `DirectorStudioTab.tsx` の `ImageDropzone`（2026-09-15 実装、動画ドロップ時に
「動画ファイルは使えません。起点となる1枚の静止画（PNG/JPEG/WebP等）を選んでください。」を表示）

---

## 9. ジョブの成功/失敗を必ず `generation_logs` に記録する

admin「実稼働ログ & 粗利監視」タブの土台。

2026-09-16、ホスト指摘: このタブがほぼ空で「全然使われてない」と発覚。
原因は `src/lib/generationLogger.ts` の `logGenerationActivity()` を呼んでいたのが
「特化ワークフロー」（保留中でほぼ未使用）と旧 Wan Animate 同期エンドポイント（タブ自体を非表示化済み）の2箇所だけで、
実際によく使われる Multi-Angle / 超解像（画像・動画）/ LoRA / Cinematic Director はどれも呼んでいなかったこと。

これらは全て非同期ジョブ方式（`angle_jobs` / `upscale_jobs` / `generation_jobs` へ `pending`/`queued` 行を insert →
ブラウザが owner RLS で直接ポーリング → Modal ワーカーが service-role で直接 PATCH）であり、
**成功/失敗が判明する箇所が Next.js のコード上に存在しない**（PATCHはPythonワーカーからREST経由で直接飛ぶ）。
そのため個々のrouteに `logGenerationActivity()` 呼び出しを追加する方式は非同期タブには使えない。

### 同期タブ

HTTP応答が返る直前（成功・失敗どちらのパスも）で `logGenerationActivity()` を1回呼ぶ。
**手本**: `custom-workflows/generate`、旧 `wan-animate/generate`

### 非同期タブ（ジョブ行＋ポーリング方式）

Next.js側にフックできる箇所が無いので、**Postgres の `AFTER UPDATE` トリガーで一元的に拾う**。

`supabase/migrations/20260871000000_generation_logs_job_triggers.sql` が実装済み・手本。
`status` が `completed`/`failed` へ新規に変化した行を検知して `generation_logs` へ1行 insert する関数を
`angle_jobs` / `upscale_jobs` / `generation_jobs` それぞれに用意してある。

**新規の非同期ジョブテーブルを追加したときは、同じパターンのトリガーをそのマイグレーションに含めること**
（ワーカー側 Python コードの変更は一切不要 — 既存の PATCH 経路をそのまま拾える）。

### トリガーが読む列は status と同じ UPDATE で書く（2026-09-23）

`generation_logs` へのコピーは **status が completed/failed に変わった UPDATE** で 1 回だけ走る。その UPDATE に
`metadata.gpu_tier` 等が乗っていないと、後から metadata をマージしても取り込まれない（SeedVR2 worker で
admin Logs の GPU 名が常に "-" になっていた原因）。終端 PATCH は「GET → merge → status と metadata を 1 回の PATCH」
にする（`modal_seedvr2_worker.py::_finish_upscale_job`）。

### `execution_time_ms` の起点

`processing_started_at`（`pending`/`queued` → `processing` に変わった瞬間。
`20260873000000_job_processing_started_at.sql` で追加）を起点に計算する。

`created_at`（キュー投入時刻）を起点にすると他ジョブの順番待ち時間までModal原価に混入してしまう
（2026-09-16 ホスト指摘で修正）ため使わない。

コールドスタート（GPU起動＋モデルロード）は `processing` 遷移後に実際にGPU課金が発生している時間なので、そのまま含めて良い。
`processing_started_at` が null（`pending`/`queued` のまま completed/failed になった異常系）は `created_at` にフォールバックする。

---

## 10. 🔥 GPUウォーム延長システムは廃止済み（2026-09-12）

フロント「🔥 火をくべる」UI・`gpu_warm_status` 共有テーブル・`/api/gpu/warm-extend` は全廃止。

**理由**: GPUウォーム状態が全ユーザー共通の1行だったため、ある人が課金して延長したウォームを
別の人が無料で横取りできてしまい、有料インセンティブとして成立しなかった。

`scaledown_window=30` 自体（無料の自然な延命）は残す。
DBの `gpu_warm_status` テーブルは害がないため未削除（`supabase/migrations/20260833000000_create_gpu_warm_status.sql`）。

代替として、タブ内ローカルの warm カウントダウン（§7）を使う。


---

# 大容量バイナリは Supabase を経由させず Modal 側で直接やり取りする（2026-09-18導入）

CLAUDE.md §1 の該当ルールの背景・手本・ハマりどころ。

## なぜ

Supabase Free プランの月間送信量は5GB（DB・Storage・Realtime・Auth・API 等の合算）しかなく、
**動画・画像を配信するというこのサービスの根幹機能だけで構造的に超過する**
（ベースラインだけで月6〜9GB）ことが実測で判明した。
これを徹底してもなお5GBを超えるなら、そこで初めて Pro プラン等を検討する。
「回避できる送信量を回避しないまま課金で解決する」順番にはしない。

## 手本にするコード

- **配信**: Modal Volume の実体を `@modal.fastapi_endpoint` から直接ストリーム。
  `modal_lora_worker.py::download_lora_checkpoint`（4MiBチャンク）。
- **アップロード（単枚）**: ブラウザから直接 Modal の web エンドポイントへ POST し Volume へ保存。
  `modal_lora_worker.py::upload_user_lora`。
- **アップロード（複数枚）**: 1リクエストに複数ファイルをまとめ、`vol.commit()` をバッチ1回にする。
  `modal_lora_worker.py::upload_lora_dataset_batch` + `src/lib/loraApi.ts::uploadLoraDataset`。
  1枚1リクエストだと 400KB の送信に 4.3秒かかっていた（`gpu-benchmarks.md` §15）。
- **認証**: `MODAL_AUTH_TOKEN` そのものはブラウザに渡さない。Next.js 側が短命のHMAC署名付き
  トークン（user_id・ファイル名・有効期限）を発行し、Modal 側で再計算・検証する。
  `src/app/api/studio/lora/checkpoint/route.ts` の `signDownloadToken` /
  `modal_lora_worker.py` の `_verify_download_token`・`_verify_upload_token`。

### 2026-09-23 以降の既定は R2（Modal 直は `UPLOAD_STORE=volume` のフォールバック）

成果物・持ち込みファイルとも **Cloudflare R2** に置く（CLAUDE.md §1「完成した成果物の置き場は R2」、
docs/STATUS.md「R2 を成果物ストレージにする」）。上の Modal 直パターンは戻し先として残す。

- **持ち込み（ブラウザ → R2）**: Next が `presignR2Put()`（`src/lib/r2.server.ts`）で署名付き PUT URL を発行し、
  ブラウザが直接 PUT。手本は `src/lib/studioUploads.ts`（単発）と `src/lib/loraApi.ts::uploadLoraDataset`
  （1 枚ごとの URL を `filenames[]` でまとめて取得し XHR PUT ×16 並列）。チケットの `store` で経路を分岐し、
  `"modal"` なら従来の POST に落ちる。**`storagePath` の形は両ストアで同じ**（`<userId>/<file>` /
  `<userId>/<datasetId>/<file>`）にして、route・worker の検証ロジックを触らない。
- **読む側は「R2 に HEAD → 無ければ Volume」**（`studioUploads.server.ts::locateStudioUpload`、
  `modal_lora_worker.py::_read_lora_dataset_upload`）。切替をまたいだアップロードや、戻した直後でも壊れない。
- **キーは Volume の相対パスと同一**（`studio_uploads/<userId>/<file>`、`lora_dataset_uploads/<userId>/<datasetId>/<file>`）。
- **署名付き PUT は host しか署名しない**（2026-09-23 実測、`X-Amz-SignedHeaders=host`）。ブラウザ側の
  Content-Type を決め打ちする必要は無く、送った値がそのままオブジェクトの Content-Type になる。
- **worker が署名付き GET を fetch する経路**（SeedVR2 の `_load_input_bytes` 等）は、URL ホストの許可リストに
  `r2.cloudflarestorage.com` が要る。忘れると `image URL host not allowed` で落ちる。**Next より先に worker をデプロイ**する。
- **バケットの CORS**（`scripts/r2_bucket_setup.py`）は GET/HEAD/PUT・全ヘッダー許可・ETag/Range 公開で適用済み。
  PUT を増やすときに触る必要は無い。ライフサイクルは全キー一律 14 日。

## ハマりどころ

- **Modal Volume (NFS) は1回あたりの読み書きオーバーヘッドが大きい。**
  小さいチャンクを大量に読み書きすると実効速度が数KB/秒まで落ち込む。
  **読み書きとも4MiB単位でバッファすること**（`open(path, mode, buffering=4*1024*1024)`）。
  ダウンロード・アップロード双方で実際に踏んだ。
- **`vol.commit()` を1ファイルごとに呼ぶと、その回数がそのまま直列コストになる。**
  Modal Volume は `allow_background_commits=True` が既定で、バックグラウンドとコンテナ終了時に
  自動コミットされる（`modal/_runtime/user_code_imports.py`）。明示commitはまとめて1回にする。
- 移行は**1回あたりの容量が大きい機能（動画系）から優先**（Director → 超解像動画 → 画像系）。
  移行中は両方式が混在してよい。
- CLAUDE.md §6「生成物は必ず永続ストレージへ保存する」原則は不変。変わるのは**永続化先**
  （Supabase Storage → Modal Volume）。14日自動パージは Volume 側のパスも対象にできる設計。
