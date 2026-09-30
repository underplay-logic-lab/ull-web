// 運営宛て通知メール（問い合わせ・支援のひとこと・解約時アンケート）の差出人。
// 宛先（CONTACT_RECEIVER_EMAIL = contact@ullstudio.com → Cloudflare Email Routing で転送）と同じアドレスから
// 送ると転送先で迷惑メール判定された（2026-09-30）ので、別アドレスにする。ullstudio.com は Resend で認証済み。
export const NOTIFY_FROM = "ULL Studio お問い合わせ <noreply@ullstudio.com>";
