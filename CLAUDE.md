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

## 1. コンテナ ＆ インフラ標準仕様（改変厳禁）
- **Python Version**: 必ず **Python 3.13**（`modal.Image.debian_slim(python_version="3.13")`）を使用すること。古い Python 3.11/3.12 へのダウングレードは永久に禁止する。
- **CUDA / PyTorch**: 必ず **CUDA 13.0 (cu130)** を使用すること。
  - インストール元: `--index-url https://download.pytorch.org/whl/cu130 --extra-index-url https://download.pytorch.org/whl/nightly/cu130`
- **GPU Architecture**: 標準 GPU は **Blackwell（`GPU_REQUEST = ["b300", "b200"]` または `"b200"`）** を使用すること。
- **GPU コンテナ ライフサイクル標準（30秒 Keep-Warm 規格）**:
  - すべての GPU ワーカー（LoRA学習 / 動画生成）の `@app.function` / `@app.cls` に **`scaledown_window=30`（30秒）** を明示すること。値は一律 `30` で統一し、個別に変更しない。
  - 対象: `modal_lora_worker.py` の `train_lora_job`、`scripts/modal_wan_animate.py` の `WanAnimate` / `WanAnimateUltra`、`modal_wan_animate_blackwell.py` の `WanAnimateBlackwell` 等、`gpu=` を持つ全関数・全クラス。
  - GPU-less（CPU のみ）の関数（`ModalStorage*`, `*_dispatch`, `download_*` 等）はこの規格の対象外（現状の値を維持）。
  - 理由: コスト最適化（アイドル待機課金の抑制）と、ユーザー体験（30秒カウントダウン中の「🔥 火をくべる」連続生成でコールドスタートを回避）の両立。フロントの `WARM_EXTEND_SECONDS`（`src/lib/gpuWarm.ts`）もこの 30 秒に一致させること。
- **デプロイコマンド**: バッチ文字化けを防ぐため、必ず `PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal deploy ...` を使用すること。

---

## 2. ブランド保護 ＆ ネタバレ防止原則
- **物理型番の完全隠蔽**: 一般ユーザー向け UI（トースト、プログレス、ツールチップ）に `B300`, `B200`, `H100`, `Modal` 等の物理型番・ベンダー名を露出させることを永久に禁止する。
- **VRAM 表示仕様**: 分母（280GB等）や％は出さず、純粋に実効消費量のみ（`Active VRAM: ${vram_used_gb} GB`）を表示すること。
- **管理者画面の隔離**: 物理型番や時給原価（$7.10/h等）は管理者専用の Admin 画面（`GpuCostReferenceCard`）のみに表示すること。

---

## 3. データ保持 ＆ 課金ポリシー
- **14日間完全自動パージ**: 生成された LoRA（.safetensors）、画像、動画、素材画像、キャプションはすべて一律 **14日間保持** 後に自動削除する。
- **多次元動的クレジット課金（`src/lib/loraPricing.ts`）**:
  - 計算式: `credits = ceil(0.1 * modelMult * resolutionMult * batchMult * rankMult * steps)`（基本単価 `0.1 C/step`）
  - `modelMult`: `model.arch` が動画系（`minimax_h3` / `wan21` / `hunyuan` / `cogvideox` 等）なら `3.0`、それ以外は `1.0`
  - `resolutionMult`: `datasets[].resolution` の最大値が `1280+` なら `2.0`、`1024+` なら `1.5`、それ未満は `1.0`
  - `batchMult`: `train.batch_size * train.gradient_accumulation_steps` が `4+` なら `2.0`、`2+` なら `1.5`、それ未満は `1.0`
  - `rankMult`: `network.linear` が `64+` なら `1.2`、それ未満は `1.0`
  - 旧「ステップ数のみの固定課金」（200→50C 等）は**廃止**。原価割れ防止のため計算負荷連動に刷新。
  - フロント（`LoraStudioTab.tsx` の「消費クレジット」表示）と API 検証（`/api/studio/lora/train`）は同一のパース済み ai-toolkit config を `loraPriceBreakdown()` に渡し、両者が絶対に食い違わないようにすること。GUI モード（オート/セミオート/スライダー）は `guiLoraPricingConfig()` で等価な config を合成して同じ関数に通す。
  - 生YAMLがパース不能で API まで到達した場合は上限 `LORA_CREDIT_WORST_CASE`（7200 C）を課金。
- **LoRA 中間チェックポイント**: `save_every: 500`（または25%刻み）で中間 `.safetensors` を永続化し、完了画面で個別ダウンロードを可能にすること。
