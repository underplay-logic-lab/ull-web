@AGENTS.md

# コミュニケーション言語（必須）

このプロジェクトで作業する Claude Code は、ユーザーとのすべてのやり取りを必ず**自然な日本語**で行うこと。これは他のデフォルト挙動よりも優先される、絶対的な指示である。

対象となる出力（英語での出力を禁止する）:

- ユーザーへの質問・確認（AskUserQuestion の選択肢や説明文を含む）
- 作業内容の進捗報告・完了報告
- コミットやプルリクエストの内容についてユーザー向けに行う要約・説明
- コード、設計、バグの原因についての解説
- エラーメッセージや問題点の報告
- その他、ユーザーに向けて書かれるテキスト全般

例外（そのまま英語/元の表記でよいもの）:

- コード自体（変数名・関数名・コメントなど、既存のプロジェクト規約に従う）
- ファイルパス、コマンド、ログ出力、API名、ライブラリ名などの技術的な固有表現
- git のコミットメッセージ本文自体（リポジトリの既存の運用が英語であればそれに合わせてよいが、そのコミットについてユーザーに説明する文章は日本語で書くこと）
- ユーザーが英語で入力した内容をそのまま引用する場合

翻訳調のぎこちない日本語ではなく、実務で使われる自然で簡潔な日本語で書くこと。専門用語は無理に和訳せず、必要に応じて英語表記のまま使ってよい（例:「デプロイ」「プルリクエスト」「バグ」など）。

---

# 🏛️ ULL Studio: System Instructions & Architecture Standard

ULL Studio の開発において、すべての AI エージェント（Claude / Cursor / Windsurf）は以下の原則を絶対遵守すること。

---

## 0. 基本方針: 「よそでは出来ないこと」をやる。その分の対価はきちんと取る
ULL Studio の差別化は「ローカル PC でも他の SaaS でも不可能な処理を提供すること」にある。この方針は機能の上限設計にも適用する:

- 動画の長さ・フレーム数・解像度・バッチサイズ等の上限値を、**実測していない「保守的な仮値」のまま放置しない**。VRAM OOM や Modal の実行時間上限など、実際に壁にぶつかる点を実機で探り、そこに安全マージンを乗せて上限を決める（例: 画像超解像の出力 75MP 上限は実測 OOM 境界 ~85-88MP から算出。[[upscale-studio]]）。
- 処理が重くなるほど消費クレジットも増える課金設計（per-frame / per-MP 課金等）にしてあるのだから、「重い処理は高くなる」を前提に、ユーザーの要求を安易に「デフォルトの控えめな値」で断らない。裏付けのない保守的な上限は、コンセプトと矛盾する自己ブロックである。
- 新しい生成系機能を作るときは、まず技術的な限界（OOM・タイムアウト）を実機で確認してから、そのすぐ手前に上限を引く。逆に「なんとなく安全そうな値」を先に決めて、それを検証せず放置してはいけない。
- 実例（2026-09-12）: 動画超解像の入力フレーム数上限が実測なしの「保守的初期値 90 フレーム」のまま出荷されており、30fps 動画で実質 3 秒・60fps で 1.5 秒しか受け付けない状態になっていた（ホスト指摘で発覚）。実機でフレーム数を段階的に上げて実際の限界を計測し、その結果に基づいて上限を引き上げた。

---

## 1. コンテナ ＆ インフラ標準仕様（改変厳禁）
- **Python Version**: 必ず **Python 3.13**（`modal.Image.debian_slim(python_version="3.13")`）を使用すること。古い Python 3.11/3.12 へのダウングレードは永久に禁止する。
- **CUDA / PyTorch**: 必ず **CUDA 13.0 (cu130)** を使用すること。
  - インストール元: `--index-url https://download.pytorch.org/whl/cu130 --extra-index-url https://download.pytorch.org/whl/nightly/cu130`
- **GPU Architecture**: 標準 GPU は **Blackwell（`GPU_REQUEST = ["b300", "b200"]` または `"b200"`）** を使用すること。
- **モデル精度（量子化禁止）**: 推論・学習とも **BF16 フル精度を既定**とし、量子化（fp8 / int8 / int4 / NF4 / GGUF 等）およびモデルオフロード（CPU offload / sequential offload）は原則使用しない。Blackwell の大 VRAM を活かしてフル精度のまま常駐させるのが ULL Studio の基本方針。量子化・オフロードをどうしても使う場合は、実機計測で品質・速度の劣化がないことを示したうえでホスト承認を得ること。
- **GPU（B300）は「GPU が必須な本番処理」でのみ使う（必須）**: 本番の推論・学習でのみ Blackwell GPU コンテナを起動する。**それ以外の目的で `gpu=` 付きコンテナを起動しない**:
  - モデル重み・リポジトリ・torch.hub アセットのプリキャッシュ／ダウンロード → **CPU 関数**でやる（重い DL を GPU にやらせない）。
  - import 連鎖の検証・依存ビルドの切り分け・PoC の配管確認 → GPU を使う前に **CPU 専用の probe 関数**（本番と同じ image を `gpu=` なしで起動）で通す。
  - 新規ワーカーの立ち上げは「CPU で import と資産準備がグリーン → はじめて GPU 実行」の順を厳守する。`modal run` で GPU クラスを直接叩くと、crash-loop 時に Modal がコンテナ起動を繰り返し **GPU 課金が垂れ流しになる**（`retries=0` では止まらない。2026-09-08 に TRELLIS worker の立ち上げで ~31分の無駄が発生）。
  - バックグラウンドで GPU ジョブを投げたら **放置しない**。最初の数分でログを確認し、crash-loop していたら即 kill する。
- **GPU コンテナ ライフサイクル標準**:
  - **動画生成系 GPU ワーカー（30秒 Keep-Warm 規格）**: `scripts/modal_wan_animate.py` の `WanAnimate` / `WanAnimateUltra`、`modal_wan_animate_blackwell.py` の `WanAnimateBlackwell` 等、`gpu=` を持つ関数・クラスには **`scaledown_window=30`（30秒）** を明示すること。値は一律 `30` で統一し、個別に変更しない。理由: コスト最適化（アイドル待機課金の抑制）と、ユーザー体験（30秒以内の連続生成でコールドスタートを回避）の両立。
    - ⚠️ **課金による延長（フロント「🔥 火をくべる」UI・`gpu_warm_status` 共有テーブル・`/api/gpu/warm-extend`）は 2026-09-12 に全廃止**: GPUウォーム状態が全ユーザー共通の1行だったため、ある人が課金して延長したウォームを別の人が無料で横取りできてしまい、有料インセンティブとして成立しなかった。scaledown_window=30 自体（無料の自然な延命）は残す。DB の `gpu_warm_status` テーブルは害がないため未削除（`supabase/migrations/20260833000000_create_gpu_warm_status.sql`）。
  - **LoRA worker（`modal_lora_worker.py`）は例外— 全関数一律 `scaledown_window=2`（2秒即切り）**: `train_lora_job`（GPU）を含む、この1ファイル内の全 `@app.function` / `@app.cls`（Web エンドポイント／内部関数を問わず）に `scaledown_window=2` を明示し、`min_containers` は使用しない（常に0＝常駐なし）。理由: LoRA学習は長時間の単発バッチジョブであり、動画生成のような連続生成UXが存在しないため、30秒Keep-Warmの恩恵がなくアイドル課金だけが残る。コールドスタートの数秒より、アイドル課金ゼロを優先する。
  - GPU-less（CPU のみ）の関数（`ModalStorage*` 等、`modal_lora_worker.py` 以外）はこの規格の対象外（現状の値を維持）。
- **PyTorch 最適化標準（`torch.compile`）**: すべての GPU 推論・学習ワーカー（Diffusers / ai-toolkit / Wan 等）で、Transformer / UNet / DiT の基幹ブロックに `torch.compile`（`mode="reduce-overhead"` または Inductor デフォルト、`dynamic=True`）を標準適用すること。適用方法はワーカー種別ごとに以下で統一する。
  - **Diffusers 系推論ワーカー**（`modal_angle_worker.py` 等）: `@modal.enter()` のパイプラインロード直後に `self.pipe.transformer`（または `.unet`）へ `torch.compile(..., dynamic=True)`（**Inductor デフォルト mode**）を適用。`try/except` と `torch._dynamo.config.suppress_errors = True` で必ずガードし、環境変数で ON/OFF できるようにする。**採用可否はワーカーごとに実機計測で判断すること**（一律 ON にしない）。既知の落とし穴:
    - **`mode="reduce-overhead"`（CUDA Graphs）は禁止**: CFG（`true_cfg_scale` / `guidance_scale`）を使うパイプラインは 1 ステップで transformer を pos/neg の 2 回呼ぶため、CUDA Graphs が 1 回目の出力バッファを 2 回目で上書きし `accessing tensor output of CUDAGraphs that has been overwritten` で落ちる（2026-09-06 A100/B300 実機で確認）。
    - **初回 forward の warmup が巨大**（Qwen-Image-Edit BF16: B300 で 500s、A100 で 640-915s。RoPE の複素演算が Inductor 非対応で eager フォールバック）。`scaledown_window` が短い（Keep-Warm しない）ワーカーでは 1 コンテナ寿命で warmup を回収できず **差し引きマイナス**。`modal_angle_worker.py` は計測の結果 **既定オフ**（`ANGLE_ENABLE_COMPILE=1` でオプトイン。定常も A100 で悪化・B300 で -22% 止まり）。
    - VRAM は Inductor デフォルトでは変化なし（CUDA Graphs 不使用のため静的メモリプールが乗らない）。
    - **inference 回帰の別件**（2026-09-06）: `torch 2.14.0+cu130` + diffusers 0.40 + transformers 5.16 の現行スタックで、`modal_angle_worker.py` の Qwen-Image-Edit DiT forward が **A100(sm_80) で ~6x 退行**（2.4s/step、健全時 ~0.4s/step）。attention backend / GEMM / SDPA / RoPE / compile いずれも無関係と実機確認済み。`whl/cu130` は torch 2.14.0 しか配信せずダウングレード不可。**B300(sm_100) は影響なし**（0.47s/step）→ 当該ワーカーの本番は Blackwell 一択、A100/B200 は degraded 扱い。
  - **ai-toolkit / LoRA 学習**（`modal_lora_worker.py`）: `_build_config()` が生成する `process[0].model` ブロックに `compile: true`（ai-toolkit `ModelConfig` のネイティブオプション。`compile_dynamic` は既定 `true`）を付与。`LORA_DISABLE_COMPILE=1` / `training_config.compile: false` で無効化可能。生 YAML override 経由のジョブも `_sanitize_override_yaml()` で未指定時のみ補完。
    - **実機計測（2026-09-06、B300 / minimax_h3 / rank 32 / 768px）**: eager 2.6 it/s → compile **5.0-5.4 it/s（~2x）**。warmup は cold で ~599s、永続 Inductor キャッシュ（`TORCHINDUCTOR_CACHE_DIR` / `TRITON_CACHE_DIR` を Volume に、`_apply_hf_cache_env()` で実行時のみ設定）ありで ~325s。break-even（warm）~1700 step → **既定の 2000 step 以上のジョブでは compile が純増**（3000 step で -23%、5000 step で -34%）。学習は推論と違い compile が明確に効く。
    - compile 有効時は途中サンプル生成が別 shape で毎回 ~220s 再コンパイル → `_build_config` は `_compile_on` のとき `sample_every` を最終 1 回だけに落とす。
  - **ComfyUI ベースの動画ワーカー**（`scripts/modal_wan_animate.py` / `modal_wan_animate_blackwell.py` / `scripts/modal_wan_animate_stable_47s.py`）: 呼び出し側が渡すワークフロー JSON に対し、diffusion-model ローダーノードを 1 つだけ一意に特定できる場合のみ、その下流に `TorchCompileModel` ノードを挿入する後処理（`_inject_torch_compile`）を実行パスに組み込む。曖昧・既存 compile ノードあり・例外時はワークフローを無改変で返す（fail-open）。`WAN_TORCH_COMPILE=0` で完全無効化。CUDA graphs と ComfyUI のモデルオフロードが競合し得るため、本番反映前に実生成での検証を必須とする。
- **SageAttention ビルド標準（C++20 フラグ必須）**: `thu-ml/SageAttention` を from-source ビルドする全ワーカー（`modal_seedvr2_worker.py` / `modal_wan_animate_blackwell.py` / `scripts/modal_wan_animate.py` / `scripts/modal_wan_animate_stable_47s.py`）は、SageAttention の `pip install` を行う `run_commands()` に必ず以下を付けること:
  ```python
  env={"CXX_APPEND_FLAGS": "-std=c++20", "NVCC_APPEND_FLAGS": "-std=c++20"}
  ```
  理由: SageAttention の `setup.py`（thu-ml/SageAttention commit d1a57a5 時点）は `CXX_FLAGS`/`NVCC_FLAGS` に `-std=c++17` をハードコードしているが、cu130 index が解決する現行 torch（2.14.0 系）のヘッダーは C++20 を要求し、素のままでは `#error C++20 or later compatible compiler is required` でビルドが失敗して SDPA へ fail-open する（2026-09-12 実機確認）。`CXX_APPEND_FLAGS`/`NVCC_APPEND_FLAGS` は setup.py が用意している注入口で、末尾に追記したフラグが gcc/nvcc の「複数回指定時は最後が勝つ」挙動で `-std=c++17` を上書きする。実機計測（B300・動画アップスケール、320×240・30フレーム）: warm 実行で **SDPA 25.43s → SageAttention 8.6s（~2.96倍高速化）**、cold でも 76.42s → 40.53s（~1.9倍）。GPU 課金は稼働秒数に比例するため、ビルドが通っているかは黙って劣化させず必ず確認すること（`⚡ SeedVR2 optimizations check: SageAttention ✅` のログで判定可能）。
- **デプロイコマンド**: バッチ文字化けを防ぐため、必ず `PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal deploy ...` を使用すること。

---

## 2. ブランド保護 ＆ ネタバレ防止原則
- **物理型番の完全隠蔽**: 一般ユーザー向け UI（トースト、プログレス、ツールチップ）に `B300`, `B200`, `H100`, `Modal` 等の物理型番・ベンダー名を露出させることを永久に禁止する。
- **VRAM 表示仕様**: 分母（280GB等）や％は出さず、純粋に実効消費量のみ（`Active VRAM: ${vram_used_gb} GB`）を表示すること。
- **管理者画面の隔離**: 物理型番や時給原価（$7.10/h等）は管理者専用の Admin 画面（`GpuCostReferenceCard`）のみに表示すること。

---

## 3. データ保持 ＆ 課金ポリシー
- **14日間完全自動パージ**: 生成された LoRA（.safetensors）、画像、動画、素材画像、キャプションはすべて一律 **14日間保持** 後に自動削除する。
- **単価は DB knob で一元管理（`pricing_knobs` テーブル / `/admin`「Pricing」タブ）**:
  - 全工程のクレジット単価・課金係数・原価割れ損切り閾値・レートは `pricing_knobs`（key/value）に集約。admin で編集 → 約1分で反映、Modal 再デプロイ不要。
  - コード側の SSOT は `src/lib/pricing/knobDefaults.ts` の `DEFAULT_KNOBS`（＝マイグレーションのシード値のフォールバック）。DB 読み取り失敗時はこの既定値で動作し、生成は止めない。
  - サーバーは `getPricingKnobs()`（`src/lib/pricing/knobs.server.ts`）、クライアントは `usePricingKnobs()` フックで公開 knob（`is_public`）を取得し、純関数へ渡す。公開 knob は `GET /api/studio/pricing` の `knobs` フィールドで配信。損切り閾値・レートは非公開（サーバーのみ）。
  - 既存の `studio_pricing` テーブル（Wan Animate）はそのまま併存。
- **多次元動的クレジット課金（`src/lib/loraPricing.ts`）**:
  - 計算式: `credits = ceil(lora_per_step * modelMult * resolutionMult * batchMult * rankMult * steps)`（基本単価 knob `lora_per_step`、既定 `0.1 C/step`）
  - `modelMult`: `model.arch` が動画系（`minimax_h3` / `wan21` / `hunyuan` / `cogvideox` 等）なら knob `lora_mult_model_heavy`（既定 `3.0`）、それ以外は `1.0`
  - `resolutionMult`: `datasets[].resolution` の最大値が `1280+` なら `lora_mult_res_1280`（既定 `2.0`）、`1024+` なら `lora_mult_res_1024`（既定 `1.5`）、それ未満は `1.0`
  - `batchMult`: `train.batch_size * train.gradient_accumulation_steps` が `4+` なら `lora_mult_batch_4`（既定 `2.0`）、`2+` なら `lora_mult_batch_2`（既定 `1.5`）、それ未満は `1.0`
  - `rankMult`: `network.linear` が `64+` なら knob `lora_mult_rank_64`（既定 `1.2`）、それ未満は `1.0`
  - 旧「ステップ数のみの固定課金」（200→50C 等）は**廃止**。原価割れ防止のため計算負荷連動に刷新。
  - フロント（`LoraStudioTab.tsx` の「消費クレジット」表示）と API 検証（`/api/studio/lora/train`）は同一のパース済み ai-toolkit config ＋ 同一の knob を `loraPriceBreakdown()` に渡し、両者が絶対に食い違わないようにすること。GUI モード（オート/セミオート/スライダー）は `guiLoraPricingConfig()` で等価な config を合成して同じ関数に通す。
  - 生YAMLがパース不能で API まで到達した場合は上限 `loraCreditWorstCase(knobs)`（既定 7200 C）を課金。
- **原価割れ損切り（cost-guard）の閾値も knob 駆動**:
  - `src/lib/pricing/costGuard.server.ts` が `pricing_knobs`（`credit_to_jpy` / `gpu_jpy_per_hour_b300` / `lora_margin_target` / `lora_cost_guard_multiplier` / `lora_floor_prep_s` / `angle_time_per_credit_s` / `angle_cold_start_grace_s` 等）からジョブの許容 GPU 秒を算出。
  - Next API がこの値を Modal ワーカーへ payload で渡す（LoRA: `cost_cap_seconds`、Angle: `max_allowed_time`）。ワーカー側の env override と `LORA_ABS_MAX_RUN_S` ハード上限は不変で残す。
- **LoRA 中間チェックポイント**: `save_every: 500`（または25%刻み）で中間 `.safetensors` を永続化し、完了画面で個別ダウンロードを可能にすること。

---

## 4. DBマイグレーション出力プロトコル（必須）
- Supabase のマイグレーションファイル（`supabase/migrations/*.sql`）を新規作成・修正した場合、またはホストに DB マイグレーションの適用を案内する際は、**該当する SQL 全文をチャット上のコードブロックとして必ずそのまま出力すること**。
- ファイルパスの提示だけで終わらせず、ホストがチャット画面からワンクリックでコピーして Supabase Dashboard (SQL Editor) に貼り付けられる状態を徹底すること。

---

## 5. モデル ＆ OSS ライセンス方針（商用リリース前提・必須）
- **ULL Studio は商用サービスとして一般公開する前提**。パイプラインに新しいモデル・推論コード・レンダラ・依存ライブラリを組み込む前に、**必ずライセンスを確認し、商用利用・SaaS 再頒布・地域制限の 3 点を満たすものだけ採用すること**。判断に迷う場合は採用せず、ホストに確認する。
- **不可（本番採用禁止）**:
  - **非商用ライセンス**（CC-BY-NC、"research only"、FLUX.1 `[dev]` 非商用ライセンス、**FLUX.1 Kontext `[dev]`** 等）。Kontext は BFL の有償商用ライセンスまたは Kontext Pro/Max API 経由でのみ商用可 → 自ホスト採用は不可。
  - **`nvdiffrast` / `nvdiffrec`**（NVIDIA Source Code License = 非商用）。3D レンダリングは商用可のものを使う: **3D Gaussian Splatting 出力を `gsplat`（Apache-2.0）でレンダリング**、またはメッシュは PyTorch3D（BSD）/ Kaolin（Apache-2.0）。Inria 版 3DGS ラスタライザ（`diff-gaussian-rasterization`）も研究用途限定なので不可。
- **可（確認済み・商用 OK）**:
  - **Qwen-Image / Qwen-Image-Edit-2511**: Apache-2.0。現行の画像編集・リスタイルの基盤はこれ。
  - **Microsoft TRELLIS / TRELLIS.2（`microsoft/TRELLIS.2-4B`）**: MIT。image→3D の第一候補（オプションの非商用レンダラ依存は上記のとおり回避すること）。
- **要注意（地域制限あり・原則回避）**:
  - **Hunyuan3D 2.1**（`tencent/Hunyuan3D-2.1`、Tencent Hunyuan 3D 2.1 Community License）: 重み＋学習コード公開だが **EU・英国・韓国では利用不可**、MAU 1 億超で別途ライセンス要、NOTICE 同梱義務。グローバル公開サービスでは原則採用しない（TRELLIS を優先）。どうしても品質面で必要なら geofence 前提でホスト承認を取る。
  - **Hunyuan3D 3.0 / 3.1**: プロプライエタリ（Tencent Cloud API のみ、重み非公開）。自ホスト不可・外部 API 依存になり「Blackwell 自ホスト」の売りと矛盾するため採用しない。
- 採用したモデル／依存の名称・バージョン・ライセンス・確認日を、当該ワーカーファイル冒頭の docstring に明記すること（`modal_angle_worker.py` の記法に倣う）。

---

## 6. Studio タブ実装の標準パターン（新規タブ作成時は必ず実装。指示を待たない）
新しい生成系 Studio タブ（画像・動画・LoRA 等、GPU ジョブを伴うもの）を作る、または既存タブのジョブ処理を触るときは、以下をホストに指示されなくても最初から実装すること。過去に何度か「後から指摘されて直す」を繰り返した経緯があるため、標準として明文化する。

- **ジョブ結果はリロードしても消えない**: ジョブ送信時に `saveFormState(JOB_KEY, {jobId})`（`src/lib/studioFormPersistence.ts`）を **1 回だけ** 呼ぶ。**完了・失敗時にクリアする呼び出しを書かない**こと（`saveFormState(JOB_KEY, {jobId: ""})` のようなクリアは NG）。次に新しいジョブを送信したときだけ上書きされる、というのが唯一の更新経路。こうすることで「リロードすれば常に最後のジョブの現在状態（完了済みなら結果、実行中ならポーリング再開）が出る」という一貫した体験になる。元祖は Multi-Angle / LoRA タブ。意図的にクリアしたい特殊事情がある場合のみ例外とし、コメントで理由を明記する。
- **「ジョブが見つからない」は専用エラーとして扱う**: ポーリング先の行が 14 日自動パージ等で本当に存在しない場合（Supabase `.single()` の `PGRST116`）と、一時的な通信エラーを **区別すること**。前者を後者と同じ「時間をおいて再読み込みしてください」で案内すると、リトライしても永久に直らない誤案内になる。`XxxJobNotFoundError` のような専用例外クラスを投げ、ポーリングループでは即座に「生成から14日以上経つと自動的に削除されます。新しく生成してください」という趣旨の案内を出して諦める（`localStorage` の参照もこのケースだけ例外的にクリアしてよい）。手本: `src/lib/upscaleApi.ts` の `UpscaleJobNotFoundError`、`src/lib/angleApi.ts` の `AngleJobNotFoundError`。
- **Active VRAM バッジ表示**（CLAUDE.md §2 のネタバレ防止仕様に準拠）: 生成中・完了後に共有コンポーネント `src/components/studio/VramBadge.tsx`（`<VramBadge gb={...} />`、`gb == null` なら何も描画しない）を必ず使う。ワーカー側のテレメトリキーは全系統で `vram_used_gb`（GB・1桁丸め、`torch.cuda.mem_get_info()` ベース）に統一する。
  - **非同期タブ**（ジョブ行を作ってポーリングする方式）: ワーカーは処理中スレッドから ~8秒毎に `metadata.vram_used_gb` を PATCH してライブ更新し、完了時は `vram_peak_gb`（処理中ピーク値）も書く。フロントは進行中バッジに `vram_used_gb`、完了後の結果表示に `vram_peak_gb` を出す。
  - **同期タブ**（HTTP 応答で完結、ポーリングなし）: ワーカーの戻り値 dict に `vram_used_gb` を含め、API route がレスポンスへそのまま素通しし、完了時に一度だけ表示する。
- これら 3 点はセットで「Studio タブとして最低限あるべき挙動」なので、新規タブのレビュー・実装時のチェックリストとして扱うこと。
