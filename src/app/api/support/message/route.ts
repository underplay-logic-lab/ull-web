import { NextResponse } from "next/server";
import { getPolarClient } from "@/lib/polar";
import { POLAR_DONATION_PRODUCT_ID } from "@/lib/polarProducts";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { Resend } from "resend";
import { apiErrorResponse } from "@/lib/apiError";
import { NOTIFY_FROM } from "@/lib/notifyMail";

// 支援者からのひとこと（2026-09-29、ホスト案）。「要望を送るのは気が引ける」人が、支援に "こうなったらいいな" を
// 添えられる窓口。会員特典の機能リクエスト（/api/contact）とは別枠。支援の決済から戻った画面だけで出し、
// Polar のチェックアウト id で「本当に寄付したか」を確かめてから受け付ける（支援していない人は送れない）。
// 保存先は問い合わせと同じ contact_inquiries（service＝「ご支援へのひとこと」、company＝決済 id）。admin の
// 「問い合わせ」タブにそのまま並ぶ。通知も問い合わせと同じくメール（Resend、2026-09-29 ホスト）。
// 1 回の支援につき MAX_PER_CHECKOUT 通まで。
export const maxDuration = 30;

const LOG_PREFIX = "[support/message]";
const SERVICE_LABEL = "ご支援へのひとこと";
const MAX_MESSAGE = 2000;
const MAX_NAME = 50;
// 1 回の支援にひとこと 1 回（2026-09-30 ホスト: 送りたければもう一度支援すればよい）。
const MAX_PER_CHECKOUT = 1;

export async function POST(request: Request) {
  let body: { checkoutId?: unknown; message?: unknown; name?: unknown };
  try {
    body = await request.json();
  } catch (err) {
    return apiErrorResponse(err, "parse_body", 400, LOG_PREFIX);
  }
  const checkoutId = typeof body.checkoutId === "string" ? body.checkoutId.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE) : "";
  const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(checkoutId)) {
    return NextResponse.json({ error: "支援の情報が確認できませんでした。" }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ error: "ひとことを入力してください。" }, { status: 400 });
  }

  // 本当に寄付の決済が済んでいるか。
  let customerEmail: string | null = null;
  let customerName: string | null = null;
  let amount = 0;
  try {
    const checkout = await getPolarClient().checkouts.get(checkoutId);
    const paid = checkout.status === "succeeded" || checkout.status === "confirmed";
    if (!paid || checkout.product_id !== POLAR_DONATION_PRODUCT_ID) {
      return NextResponse.json({ error: "支援の決済が確認できませんでした。" }, { status: 403 });
    }
    customerEmail = checkout.customer_email ?? null;
    customerName = checkout.customer_name ?? null;
    amount = checkout.total_amount ?? checkout.amount ?? 0;
  } catch (err) {
    return apiErrorResponse(err, "verify_checkout", 403, LOG_PREFIX);
  }

  const tag = `polar_checkout:${checkoutId}`;
  const { count } = await supabaseAdmin
    .from("contact_inquiries")
    .select("id", { count: "exact", head: true })
    .eq("company", tag);
  if ((count ?? 0) >= MAX_PER_CHECKOUT) {
    return NextResponse.json({ error: "この支援からのひとことは、もう受け取っています。ありがとうございました。" }, { status: 429 });
  }

  const displayName = name || customerName || "（支援者）";
  const { data: row, error: insertError } = await supabaseAdmin
    .from("contact_inquiries")
    .insert({
      name: displayName,
      email: customerEmail ?? "（支援の決済にメールなし）",
      company: tag,
      service: SERVICE_LABEL,
      message: `［¥${amount.toLocaleString()} のご支援］\n${message}`,
    })
    .select("id")
    .single();
  if (insertError || !row) {
    console.error(`${LOG_PREFIX} insert failed:`, insertError?.message ?? "no row returned");
    return NextResponse.json({ error: "送信に失敗しました。時間をおいてもう一度お試しください。" }, { status: 500 });
  }

  // 通知（best-effort。保存は済んでいるので失敗してもエラーにしない。問い合わせと同じくメール）。
  const resendApiKey = process.env.RESEND_API_KEY;
  const receiverEmail = process.env.CONTACT_RECEIVER_EMAIL;
  if (!resendApiKey || !receiverEmail) {
    console.error(`${LOG_PREFIX} RESEND_API_KEY or CONTACT_RECEIVER_EMAIL is not configured; saved, notification skipped.`);
  } else {
    try {
      const { error } = await new Resend(resendApiKey).emails.send({
        from: NOTIFY_FROM,
        to: receiverEmail,
        ...(customerEmail ? { replyTo: customerEmail } : {}),
        subject: `【${SERVICE_LABEL}】¥${amount.toLocaleString()} のご支援`,
        text: [
          `お名前: ${displayName}`,
          `メールアドレス: ${customerEmail ?? "-"}`,
          `ご支援額: ¥${amount.toLocaleString()}`,
          `決済: ${checkoutId}`,
          "",
          "ひとこと:",
          message,
        ].join("\n"),
      });
      if (error) {
        console.error(`${LOG_PREFIX} Resend send failed (saved; notification only):`, error);
      } else {
        await supabaseAdmin.from("contact_inquiries").update({ email_sent: true }).eq("id", row.id);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Resend send threw (saved; notification only):`, err);
    }
  }

  return NextResponse.json({ ok: true });
}
