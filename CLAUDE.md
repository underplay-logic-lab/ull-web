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
- **原因調査は「該当コードが読めるなら実測より先にソースを読む」**: 少数の実機実測データ（成功/失敗が1〜2点）だけから法則を逆算すると、たまたま一致しただけの誤った規則を確信を持って断定してしまうリスクが高い。対象が OSS 等でソースが実際に読める場合は、無料かつ確実なので実機再検証の前に必ず読むこと。実例（2026-09-13、ULL Cinematic Director の patchify クラッシュ）: 「正方形512pxで失敗・496pxで成功」という1点の実測から「ピクセル ≡ 16 (mod 32) が必要（+1オフセットがある）」という規則を誤って逆算し、この誤った規則に基づく修正を2回（丸め式の修正、続いて「first_frame側のアスペクト比ズレ」という誤った仮説に基づく明示的リサイズの追加）行ったが、どちらも別のアスペクト比で同じ種類のクラッシュが再発し失敗に終わった。ComfyUI 本体のノード実装（`comfy_extras/nodes_minimax_h3.py`）を直接読んだところ真因は単純だった（`height // 16` の整数除算のみ・+1オフセットなし、必要なのは「32の倍数」という条件だけ）。GPU実機の1トライアルにはコスト（時間・課金）がかかる一方、公開されているソースコードを読むのは無料で確実なので、実機トライアル＆エラーを繰り返す前に「そもそも読めるソースがないか」を先に確認する。
- **GPUジョブのタイムアウト／ポーリング上限は「多め」に設定する（短めにして得したケースが実績上ゼロ）**: スモークテストやワーカー内のポーリングループ（`_run_workflow` の `poll_deadline_s`、Modal 関数の `timeout=` 等）の上限値を保守的に短く見積もると、実際には正常に進行中のジョブを「失敗」と誤判定してしまう（実例: 2026-09-13、cinemaMaster相当・20ステップの実機テストで `poll_deadline_s=1500`（25分）を設定したところ、19/20ステップ＝95%まで正常に進んでいたところで力尽きてタイムアウトエラーになった。真の暴走・無限ループではなく、単にステップ数×実測所要時間の見積もりが甘かっただけ）。逆に、上限を短くしたことで本当に暴走したジョブを検知して助かったケースはこのプロジェクトで一度も発生していない。したがって、コスト超過防止の役割は Modal 側のハードタイムアウト・costGuard（CLAUDE.md §3）や実行時間の絶対上限に任せ、スモークテスト・ポーリングループの上限自体は「実測見積もりの2倍以上」を初期値にする（例: 20ステップ×約100秒/stepなら見積もり33分→上限は60〜75分程度に設定する）。短い上限で刻んで様子見するより、多少長めに一発で確保したほうが、タイムアウト誤検知による無駄な再実行（＝二重の GPU 課金）を避けられる。

---

## 1. コンテナ ＆ インフラ標準仕様（改変厳禁）
- **Python Version**: 必ず **Python 3.13**（`modal.Image.debian_slim(python_version="3.13")`）を使用すること。古い Python 3.11/3.12 へのダウングレードは永久に禁止する。
- **CUDA / PyTorch**: 必ず **CUDA 13.0 (cu130)** を使用すること。
  - インストール元: `--index-url https://download.pytorch.org/whl/cu130 --extra-index-url https://download.pytorch.org/whl/nightly/cu130`
  - **例外（2026-09-15、ホスト明言）**: この Python 3.13 / CUDA 13.0 統一は、**もともと ComfyUI ベースのワーカー（動画生成系）を想定して決めた基準**であり、ComfyUI を使わない新規ワーカー（例: kohya-ss/sd-scripts ベースの SDXL 専用学習ワーカー）にはこだわりが無い。そのトレーナー自身が公式に推奨・検証している Python / CUDA / PyTorch の組み合わせをそのまま使ってよい（例: sd-scripts は README 上、Python 3.10 でテスト済み・3.11/3.12 は未テスト、Blackwell（RTX 50 系）向けには PyTorch 2.8.0 + **CUDA 12.8/12.9** を明示的に推奨しており cu130 ではない）。Modal の各ワーカーはそれぞれ独立した image を持つため、あるワーカーが cu130 以外を使っても他のワーカーに影響しない。採用する場合は、そのワーカー自身の冒頭コメントに「なぜこのバージョン組み合わせにしたか（トレーナー公式の推奨に従った、等）」を明記すること。
- **GPU Architecture**: 標準 GPU は **Blackwell（`GPU_REQUEST = ["b300", "b200"]` または `"b200"`）** を使用すること。
- **モデル精度（量子化禁止）**: 推論・学習とも **BF16 フル精度を既定**とし、量子化（fp8 / int8 / int4 / NF4 / GGUF 等）およびモデルオフロード（CPU offload / sequential offload）は原則使用しない。Blackwell の大 VRAM を活かしてフル精度のまま常駐させるのが ULL Studio の基本方針。量子化・オフロードをどうしても使う場合は、実機計測で品質・速度の劣化がないことを示したうえでホスト承認を得ること。
- **GPU（B300）は「GPU が必須な本番処理」でのみ使う（必須）**: 本番の推論・学習でのみ Blackwell GPU コンテナを起動する。**それ以外の目的で `gpu=` 付きコンテナを起動しない**:
  - モデル重み・リポジトリ・torch.hub アセットのプリキャッシュ／ダウンロード → **CPU 関数**でやる（重い DL を GPU にやらせない）。
  - import 連鎖の検証・依存ビルドの切り分け・PoC の配管確認 → GPU を使う前に **CPU 専用の probe 関数**（本番と同じ image を `gpu=` なしで起動）で通す。
  - 新規ワーカーの立ち上げは「CPU で import と資産準備がグリーン → はじめて GPU 実行」の順を厳守する。`modal run` で GPU クラスを直接叩くと、crash-loop 時に Modal がコンテナ起動を繰り返し **GPU 課金が垂れ流しになる**（`retries=0` では止まらない。2026-09-08 に TRELLIS worker の立ち上げで ~31分の無駄が発生）。
  - バックグラウンドで GPU ジョブを投げたら **放置しない**。最初の数分でログを確認し、crash-loop していたら即 kill する。
  - **「GPU の存在自体は必要だが、実際の計算力は不要」なケースは最安の GPU tier を使う（2026-09-14 追加）**: ComfyUI 本体の `comfy.model_management` が import 時点で無条件に `torch.cuda.current_device()` を呼ぶため、ノードの存在確認・`/object_info` スキーマ取得のような「起動するだけでモデルロードも生成もしない」プローブでも GPU ドライバの存在自体は必須（CPU 専用コンテナでは `RuntimeError: Found no NVIDIA driver` で止まる）。ただしこの用途では Blackwell の性能は一切使わないので、本番実行用クラス（`WanAnimateBlackwell` 等）をそのまま流用して毎回 B300 を起動するのではなく、**Modal で選べる最安の GPU tier** を使うこと。実例（2026-09-14、TRELLIS.2/Pixal3Dのノード存在確認プローブ）でホストから指摘を受けて明文化。
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
- **ComfyUI コアのバージョン運用方針**: 新規ワーカーを初めて構築する時点では、その時点の**最新版 ComfyUI**を使うこと（`git fetch --tags && git checkout <最新タグ>`）。無根拠に古いバージョンから始めない。実装が完了して本番稼働に入った後は、**バージョンを固定（ピン止め）し、明確な理由なく追従しない**運用に切り替える——ComfyUI は頻繁に破壊的変更が入るため、稼働中のワークフローが突然壊れるのを防ぐのが目的（実例: `modal_wan_animate_blackwell.py` は `v0.33.3` にピン止め中。理由はコード内コメントに明記——「master に一時的な SaveVideo バグがあり、それを踏まない最後の検証済みタグ」だったため）。**バージョンを上げる時は、必ず事前検証してから**切り替えること: (1) 現行ピンとの間で何が変わったか（changelog・該当PR）を確認する、(2) 過去にそのバージョンを避けた理由（上記のような既知バグ等）が解消されているか、または回避策（例: 問題のあるコアノードを使わず `ComfyUI-VideoHelperSuite` 等の代替ノードに差し替える）で無効化できるかを確認する、(3) 既存のワークフロー・カスタムノード・実測値（速度・VRAM等）が新バージョンでも壊れないか実機で再検証する。この3点を飛ばした「なんとなく最新に追従」は禁止。

---

## 2. ブランド保護 ＆ ネタバレ防止原則
- **物理型番の完全隠蔽**: 一般ユーザー向け UI（トースト、プログレス、ツールチップ）に `B300`, `B200`, `H100`, `Modal` 等の物理型番・ベンダー名を露出させることを永久に禁止する。
- **VRAM 表示仕様**: 分母（280GB等）や％は出さず、純粋に実効消費量のみ（`Active VRAM: ${vram_used_gb} GB`）を表示すること。
- **管理者画面の隔離**: 物理型番や時給原価（$7.10/h等）は管理者専用の Admin 画面（`GpuCostReferenceCard`）のみに表示すること。
- **基盤モデル名の非表示（2026-09-14 追加）**: 一般ユーザー向け UI に `TRELLIS.2`, `Pixal3D`, `MiniMax H3`, `Qwen-Image-Edit` 等、内部で使っている基盤モデルの名称を露出させることを禁止する（物理型番の完全隠蔽と同じ原則をモデル名にも適用）。理由: 今日のTRELLIS.2/Pixal3D検証（[[image-to-3d-feature-validation]]）で確認した通り、これらの基盤モデルはほぼ全て誰でも無料で入手できるオープンウェイトであり、モデル名を出すこと自体が「それなら自分でタダで動かせるのでは」という比較・離脱を招くリスクになる。「どのモデルを使っているか」ではなく「ULL Studioで何ができるか（機能・体験）」に対価を感じてもらう方針とする。
  - これは UI 表示上の方針であり、**ライセンス遵守の実務（地域制限の geofence 対応・Community License 等が求める NOTICE 表記義務）とは別枠**で維持すること。UI で名前を隠しても、地域制限や NOTICE 同梱義務そのものは消えない。NOTICE 表記が契約上必要なモデルは、目立たない場所（利用規約ページ等）でその義務を満たせば足り、機能説明の前面に出す必要はない。
  - **例外: LoRA Studio（`src/lib/loraModels.ts`のモデル選択）は対象外**（2026-09-14、ホスト判断）。理由: LoRA学習は「どのベースモデルに対して学習するか」自体がユーザーにとって機能そのものであり（互換性・プロンプト作法・コミュニティ知見の流用に直結する専門ツール）、モデル名を隠すと実用性が損なわれる。Multi-Angle/Director/Upscale のような「結果だけ受け取る」一般機能とは性質が異なるため、`label` フィールドは実際のモデル名のまま維持する（`id`/`arch` はそもそも変更対象外）。

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
- **4.5MB を超えうるファイルアップロードは直接 Storage アップロード必須**: Vercel のサーバーレス関数はリクエストボディに **約4.5MBのハード上限**があり（プラットフォーム側の制限。`next.config` 等アプリ側の設定では変更不可）、API route が `request.formData()` で生ファイルを直接受け取る実装は、超過時にアプリのコードに一切到達せず問答無用で `413 Payload Too Large` を返す。実測（2026-09-12・本番 `www.ullstudio.com` に対して直接検証）: 画像超解像は「25MBまで対応」、動画超解像は「60MBまで対応」とそれぞれ表示していたが、実際は**どちらも4.5MBちょうどで即座に弾かれていた**（表示自体が実態と乖離した嘘になっていた）。4.5MBを超えうるアップロード（動画・複数枚画像・音声等）を扱う新規タブでは、着工前に必ずこの制限を意識し、**クライアントから直接 Supabase Storage へアップロードし、API route にはファイル本体ではなく storage path だけを渡す**方式にすること（route 側は `supabaseAdmin.storage.from(bucket).download(path)` で server-side に取得する — service role からの取得は Vercel のリクエストボディ上限と無関係）。手本: `src/lib/loraApi.ts` の `uploadLoraDataset`（コメントに "bypassing Vercel's 4.5 MB request body cap" と明記済み）。
- **生成物は同期/非同期を問わず必ず永続ストレージへ保存する**: 「特化ワークフロー」（`/api/studio/custom-workflows/generate`）が HTTP レスポンスで base64 を返すだけの同期実装のまま長期間サーバー側に一切保存しておらず、ユーザーがその場でダウンロードし忘れると生成物が永久に復元不能という欠陥が発覚した（ホスト報告、2026-09-13）。Multi-Angle/超解像のような非同期タブは元々ジョブ行＋Storage保存が必須構造なので問題にならないが、**同期タブ（HTTP応答で完結する方式）ほどこの罠に陥りやすい**ので明文化する。新規タブが同期・非同期いずれの方式でも、生成成功時に必ず: (1) 結果を公開 Storage バケット（`angle-results`/`upscale-results`/`custom-workflow-results` と同じパターン、`<user_id>/<uuid>.<ext>` 配置）へアップロードする、(2) `generation_jobs`（または専用テーブル）に `status: "completed"` の行を1件残し、後から辿れるようにする、(3) 新設したバケット名を `modal_retention_purge.py` の `DEFAULT_BUCKETS` と `src/lib/generatedStorage.ts` の `GENERATED_BUCKETS` の両方に追加し、14日自動パージ（CLAUDE.md §3）と admin バケットブラウザの対象に確実に含める（追加を忘れると際限なく溜まり続けるか、admin から見えないまま放置される）。これらはベストエフォートでよく（保存に失敗してもユーザーへ返すメインの生成結果は落とさない）、手本は `src/app/api/studio/custom-workflows/generate/route.ts` の `persistCustomWorkflowResult()`。
- **コールドスタート中は「起動待ち」と分かる専用表示にする**（ホスト報告、2026-09-13: Multi-Angle にだけ実装され、超解像等への横展開が漏れていた）: 非同期タブの多くはジョブ行を「まだ実処理が始まっていない初期状態」（`angle_jobs`/`upscale_jobs` は `status: 'pending'`、`generation_jobs` は `status: 'queued'` — テーブルにより文字列は異なるが役割は同じ）で作り、ワーカーが実際にコンテナ内でコードを実行し始めた瞬間（GPUのコールドブート・モデルロードが終わった後ではなく、ジョブ関数の先頭）に `status: 'processing'` へ PATCH する、という2段階の遷移を既に持っている。この「insert 時点の初期ステータス」と「processing」を**フロント側で区別せず**、ずっと同じ「生成中…」を出し続けるタブがあり、コールドスタート（初回1〜2分）の間ユーザーが「固まった」と誤解する原因になっていた。新規タブ・既存タブの手直しを問わず、ジョブが `pending`/`queued` 相当の間は **「生成準備中…GPUを起動しています（初回は1〜2分ほどかかります）」のような起動中専用の文言**をボタンラベル・進捗表示の両方に出し、`processing` に上がってから初めて通常の「生成中 X/Y」表示に切り替えること。手本: `MultiAngleStudioTab.tsx`（`job?.status === "pending"` で分岐）、より高度な例として `LoraStudioTab.tsx`（経過時間に応じた文言のグラデーション）。**同期タブ**（HTTP応答が返るまでポーリングしない方式）はこの区別ができない構造的な制約があるため、コールドスタートを利用者に見せたいなら非同期（ジョブ行＋ポーリング）化が前提になる。
  - **既知の未対応（意図的に保留中）**: 「特化ワークフロー」（`CustomWorkflowsTab.tsx` / `/api/studio/custom-workflows/generate`）は今も完全同期実装で、ジョブ行・ポーリングの仕組み自体が無いため、この項目にまだ対応できていない。2026-09-13時点でホストの判断により「使い道がまだ明確でないので保留」。対応するなら §6 の「生成物の永続化」項目で既に追加した `generation_jobs`（`workflow_type: 'custom'`）書き込みを土台に、Cinematic Director（`DirectorStudioTab.tsx`/`src/app/api/director/generate/route.ts`）と同じ非同期ジョブ＋ポーリング構成へ作り替えるのが最短経路。着手を思い出すためのメモなので、対応したらこの小項目ごと削除してよい。
- **実行中でも次のジョブを出せるようにする（2026-09-14 追加。新規タブ作成時も必ず実装、指示を待たない）**: GPU ジョブを伴うタブは、既存ジョブの実行中でも新しいジョブを受け付けられるようにする。**バックエンドの Keep-Warm 設定（CLAUDE.md §1）で実装パターンが変わる**ので、新規タブを作る際は該当ワーカーの `scaledown_window` をまず確認してから、以下のどちらかを実装すること。手本は `MultiAngleStudioTab.tsx`（`scaledown_window=30` 系、2026-09-14 実装）。
  - **`scaledown_window=30` 系（Multi-Angle / 超解像・超解像動画 / Cinematic Director 等、連続生成 UX があるタブ）**: 「順番待ち（無料・既定）」と「並列実行（追加料金）」を選ばせる。
    1. **warmカウントダウン**: 共有フック `src/hooks/useLocalWarmCountdown.ts`（`markWarm()` をジョブ完了時に呼ぶ、DB・共有状態不要のタブ内ローカル実装。旧 `gpu_warm_status` 共有テーブル方式は 2026-09-12 に横取り問題で全廃止済み — [[gpu-warm-extend-removed]]）を使い、完了後「あと30秒以内ならコールドスタートなしで生成できます」を表示する。ジョブが「実際にこのポーリングセッション中に実行中状態を経由してから完了した」場合だけ warm 扱いにすること（タブ再読み込み直後に「とっくに完了済みのジョブ」を検知したケースを誤って warm と案内しないため）。
    2. **キュー選択モーダル**: 生成ボタンはジョブ実行中も押せる状態にしておき（`disabled` に実行中フラグを含めない）、押すと選択モーダルを出す。順番待ちは現在のフォーム入力を**その場でスナップショットして**ジョブ完了検知時に自動発火する（発火時点の変わっているかもしれない state を読んではいけない）。並列実行は待たずに新しい GPU コンテナを起動する分のコールドスタート原価を追加課金する専用 knob（`angle_priority_parallel_surcharge` に倣い `<feature>_priority_parallel_surcharge` 命名、原価 = cold_start_grace_s 系knob × gpu_jpy_per_hour_b300 ÷ credit_to_jpy に他の単価と同じ3倍markupを掛けた概算値）を用意する。**追加料金が正当化できるのは「待てば温かいコンテナを再利用できる」場合だけ**（下記参照）。
  - **`scaledown_window=2` 系（LoRA 等、常駐しない・連続生成 UX がない長時間バッチジョブのタブ）**: warmカウントダウンは意味が無い（常に即切りで温かい状態が存在しない）ので実装しないが、**並列実行だけは追加料金なしで提供する**。理由: 順番待ちしても並列実行しても、どのみち毎回フルのコールドスタートが必要でコスト差が発生しない（＝待たせる理由がそもそも無い）ため、上記のようなコールドスタート原価の上乗せロジックは適用できない。LoRA は学習が数時間かかり「1件目が終わるまで2件目を出せない」のはUX上の実害が大きいため、むしろこちらの方が優先度が高い（2026-09-14 ホスト指摘、未実装 — LoRA タブは既存の単一ジョブ追跡 UI を複数ジョブ同時追跡に拡張する作業が必要になる見込み）。
  - 実装上の注意（Multi-Angle 実装時にハマった点、`scaledown_window=30` 系で特に該当）: ①「実行中でもキュー選択に進めるべき」チェックは、既存の `insufficientCredits`（現在の1回分の与信）チェックより**先**に置くこと — 1件目の課金直後で残高が減っている状態だと、無料のはずの順番待ちにすら辿り着けなくなる。②ポーリングの長寿命な `useEffect` から「予約中の次の1件」を読むための ref は、**イベントハンドラでのみ書き込み**、effect 内で毎レンダー同期する実装にしない（このプロジェクトの eslint-plugin-react-hooks が `react-hooks/immutability`／`react-hooks/refs`／`react-hooks/set-state-in-effect` でこの手のパターンを検出して弾く）。ポーリング effect が呼ぶ「次を発火する関数」自体は `useCallback` で安定させ、依存配列に含めてよい。
- **対応外のファイルを選んだ時は必ずエラー表示する（黙って無視しない）**（2026-09-15、ホスト報告: Cinematic Director に動画ファイル(MP4)をドロップしたら、プレビューも出ずエラーも出ず、何も起きなかったように見えた）: 画像アップロードのドロップゾーンで `file.type.startsWith("image/")` のような型チェックだけを条件に「一致しなければ `onFileSelected`/`onAdd` を呼ばない」実装は、ユーザーからは「読み込まない」としか見えない原因不明の沈黙になる。**型チェック自体は変更先（親コンポーネントの `onFileSelected`/`onAdd` ハンドラ）に持たせ、ドロップゾーン側は picked file があれば常にハンドラへ渡す**こと。ハンドラ側で型が不正なら専用のエラー文言（`file.type.startsWith("video/")` なら「動画ファイルは使えません。〜」のように原因を具体的に案内。動画専用の別タブがあるならそちらへの誘導も添える）を既存のエラー表示 state（`imageError`/`errorMessage` 等）にセットする。複数ファイルを一括処理するバッチ/ZIP系の取り込み（`LoraStudioTab.tsx` の `addImages`、`UpscaleStudioTab.tsx` の `addBatchFiles`）でも同様に、フィルタで弾いた件数・ファイル名を集計してエラーメッセージにまとめる。手本: `DirectorStudioTab.tsx` の `ImageDropzone`（2026-09-15 実装、動画ドロップ時に「動画ファイルは使えません。起点となる1枚の静止画（PNG/JPEG/WebP等）を選んでください。」を表示）。
- **ジョブの成功/失敗を必ず `generation_logs` に記録する（admin「実稼働ログ & 粗利監視」タブの土台）**（2026-09-16、ホスト指摘: このタブがほぼ空で「全然使われてない」と発覚）: 原因は `src/lib/generationLogger.ts` の `logGenerationActivity()` を呼んでいたのが「特化ワークフロー」（保留中でほぼ未使用）と旧 Wan Animate 同期エンドポイント（タブ自体を非表示化済み）の2箇所だけで、実際によく使われる Multi-Angle / 超解像（画像・動画）/ LoRA / Cinematic Director はどれも呼んでいなかったこと。これらは全て非同期ジョブ方式（`angle_jobs` / `upscale_jobs` / `generation_jobs` へ `pending`/`queued` 行を insert → ブラウザが owner RLS で直接ポーリング → Modal ワーカーが service-role で直接 PATCH）であり、**成功/失敗が判明する箇所が Next.js のコード上に存在しない**（PATCH は Python ワーカーから REST 経由で直接飛ぶ）。そのため個々の route に `logGenerationActivity()` 呼び出しを追加する方式は非同期タブには使えない。
  - **同期タブ**（HTTP 応答が返るまでポーリングしない方式）: HTTP 応答が返る直前（成功・失敗どちらのパスも）で `logGenerationActivity()` を1回呼ぶ。手本: `custom-workflows/generate`、旧 `wan-animate/generate`。
  - **非同期タブ（ジョブ行＋ポーリング方式）**: Next.js 側にフックできる箇所が無いので、**Postgres の `AFTER UPDATE` トリガーで一元的に拾う**（`supabase/migrations/20260871000000_generation_logs_job_triggers.sql` が実装済み・手本）。`status` が `completed`/`failed` へ新規に変化した行を検知して `generation_logs` へ1行 insert する関数を `angle_jobs` / `upscale_jobs` / `generation_jobs` それぞれに用意してある。**新規の非同期ジョブテーブルを追加したときは、同じパターンのトリガーをそのマイグレーションに含めること**（ワーカー側 Python コードの変更は一切不要— 既存の PATCH 経路をそのまま拾える）。
    - `execution_time_ms` は `processing_started_at`（`pending`/`queued` → `processing` に変わった瞬間。`20260873000000_job_processing_started_at.sql` で追加）を起点に計算する。`created_at`（キュー投入時刻）を起点にすると他ジョブの順番待ち時間まで Modal 原価に混入してしまう（2026-09-16 ホスト指摘で修正）ため使わない。コールドスタート（GPU起動＋モデルロード）は `processing` 遷移後に実際に GPU 課金が発生している時間なので、そのまま含めて良い。`processing_started_at` が null（`pending`/`queued` のまま completed/failed になった異常系）は `created_at` にフォールバックする。
- これら 10 点はセットで「Studio タブとして最低限あるべき挙動」なので、新規タブのレビュー・実装時のチェックリストとして扱うこと。
