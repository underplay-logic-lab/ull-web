// 一般ユーザー向け UI の出し分けフラグ（環境変数ではなくコード定数。変えるときは
// 意図をここに書く）。

// Director（動画生成）で LoRA を選ぶ／持ち込む UI と、LoRA 完了画面の
// 「動画生成でこの LoRA を使う」導線。2026-09-23 ホスト指示で非表示。
// 理由: ①現状 MiniMax H3 でしか使えない ②GPU 名・モデル名を伏せている方針
// （CLAUDE.md §2）なのに「LoRA を使える」と出すこと自体が基盤モデルを明かす
// ことになる。ホストは将来「プラン専用機能／特別メンバー限定」として出す案を
// 検討中。API・worker 側の LoRA 対応（`director_user_loras/`、payload の lora）
// はそのまま残す。true に戻せば UI は元どおり出る。
export const DIRECTOR_LORA_ENABLED = false;
