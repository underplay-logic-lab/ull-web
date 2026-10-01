// クレジット不足からのチャージ導線（2026-10-01）。
//
// 料金表（購入ボタン）はトップページの #pricing にある。Studio は /studio へ移したので同じページ内の "#pricing" では飛べない。
// また購入は Polar の決済ページへページごと移動するため、同じタブで開くと Studio の作業中の内容（画面の中にしか無い画像など）が
// 消える。→ 都度チャージは埋め込み決済（TopupActions）でその場で、月額プランは料金表を新しいタブで開く。
// from=studio: Studio から開いた印。料金表で買い終えたら「このタブを閉じて元の Studio へ」と案内する（Pricing.tsx）。
export const TOPUP_URL = "/?from=studio#pricing";
