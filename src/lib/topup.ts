// クレジット不足からのチャージ導線（2026-10-01）。
//
// 料金表（購入ボタン）はトップページの #pricing にある。Studio は /studio へ移したので同じページ内の "#pricing" では飛べない。
// また購入は Polar の決済ページへページごと移動するため、同じタブで開くと Studio の作業中の内容（画面の中にしか無い画像など）が
// 消える。→ 料金表は新しいタブで開き、Studio のタブはそのまま残す。購入後の残高は useProfileCredits の realtime 購読で
// 元のタブにも反映されるので、戻ってそのまま実行できる。
export const TOPUP_URL = "/#pricing";

export const TOPUP_NOTE = "料金表は新しいタブで開きます。購入後にこのタブへ戻れば、今の設定のまま実行できます。";

export function openTopupInNewTab(): void {
  window.open(TOPUP_URL, "_blank", "noopener");
}
