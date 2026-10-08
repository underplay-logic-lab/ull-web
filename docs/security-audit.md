# セキュリティ点検（2026-10-09〜）

きっかけ: ホストが「AI に作らせたアプリの 91% に脆弱性」という研究（Understanding the (In)Security of Vibe-Coded Applications）を見て依頼。
ULL Studio はほぼ AI（Claude）が書いたコードで、2026-10-01 にも「anon キーだけでクレジットを足せる」穴があった（`20260894_security_hardening`）。

## 1. コードを読む点検（静的）

| 深刻度 | 内容 | 状態 |
|---|---|---|
| **致命的** | admin 用の開発 ComfyUI（`modal_comfyui_dev.py` の `comfyui_server`）が `requires_proxy_auth=False` で公開。URL は決まった形で、画面のコード（`NEXT_PUBLIC_MODAL_COMFYUI_DEV_URL` の既定値）にも載っていた。アクセスだけで T4 が起動し、ComfyUI-Manager で任意のノード＝任意のプログラムを実行でき、本番と共有の Volume `ull-wan-models` が書き込み可能でつながっていた。本番の Director・超解像ワーカーは起動時に Volume の `custom_nodes` を読み込む＝本番ワーカーに仕込み、秘密の鍵（Supabase の全権限キー・R2 など）を盗める状態だった | **2026-10-09 アプリ停止**（`modal app stop ull-comfyui-dev`）。Volume の `custom_nodes`（KJNodes・VDN-H3・sol-attn 2 つ）は 8〜9 月のままで仕込みの形跡なし（`__pycache__` だけ当日の本番ジョブの時刻）。ホスト「最近は使っていない」→ 止めたまま。直すなら Next の admin 判定を通した中継か Modal の認証 |
| **高** | クレジットの二重使用。生成 API 10 個（Director・部分修正・曲づくり・Multi-Angle・特化ワークフロー・LoRA 学習・画像／一括／動画の超解像・Wan Animate）とキャプション解析が「残高を読む → 料金以上か確かめる → 残高 − 料金 を上書き」。同時に何本も送ると 1 本分の料金で何本も作れた。返金（API の巻き戻し・ワーカー 7 つ・admin の中止・LoRA の回収）も「読む → 足して上書き」で、間の引き落としを消していた | **修正・反映済み（2026-10-09・3eb203f・マイグレーション適用・ワーカー 7 つデプロイ）**: DB 関数 `debit_profile_credits`／`refund_profile_credits`（`supabase/migrations/20260897000000_atomic_credit_debit.sql`）＋ `src/lib/credits.server.ts`。**マイグレーションの適用が先**（先にコードを出すと全部の生成が失敗する） |
| 低 | Director の持ち込み音声のパスを入口で本人のものか確かめていない（読むとき `downloadStudioUpload` が確かめるので他人の音声は読めない。課金後に失敗するだけ） | 未修正 |
| 低 | トリガー用の 3 関数（`log_*_completion`）に一般の実行権限が残っていた（直接呼ぶとエラーになるので実害なし） | 同じマイグレーションで取り消し |
| 低 | ライセンスの試用（`/api/license/trial`）は PC の ID を変えれば何度でも発行できる（PC の ID 方式の性質） | 記録のみ |
| 問題なし | admin の判定（全 admin API が `requireAdmin`・メールの許可リスト）／ジョブ・LoRA・写真の持ち主の確認／送られたファイルのパスの本人確認（R2 のキーは文字列そのまま・Volume 側は `..` を弾く）／全 22 表の RLS 有効・一般に書き込みを許すのはストレージの自分のフォルダだけ／SECURITY DEFINER 関数（上の 3 つ以外は一般から取り消し済み）／Modal の公開入口（開発 ComfyUI 以外はすべてトークンか署名）／Polar の Webhook（署名確認・付与量はサーバーの商品設定）／本番の JS に秘密の鍵なし（18 ファイル・約 2MB を検索）／URL を受け取って読みに行くのは admin だけ（SSRF なし）／毎日のボーナスは同時に押しても二重にならない（同じ残高に足して上書き） | ― |

まだ見ていない: アップロードの種類・大きさの確認、連続で叩かれたときの制限（レート制限）、Supabase の認証の設定（メール確認・Google のメール確認済みの扱い）、ページのセキュリティ用ヘッダー（CSP など）。

## 2. 本番での確認（動的）

- 新しい関数: service_role からは呼べる・**anon キーからは 42501（権限なし）で拒否**（存在しないユーザー ID で確認＝誰の残高も変えない）。
- 同時実行: demo アカウントに 1C の引き落とし 10 本と返金 10 本を同時に送る → **全部成功・最後の残高は最初と同じ 17,285C（ずれ 0）・有効期限も不変**（費用ゼロ。API は関数を呼ぶだけの形なので、関数で確かめれば足りる）。

## 再発防止（CLAUDE.md に足したルール）

- クレジットの増減は DB 関数でその場で 1 回に（読む → 足し引きして書く、は禁止）。
- Modal の公開入口は必ず認証。`web_server` を `requires_proxy_auth=False` で公開しない。
