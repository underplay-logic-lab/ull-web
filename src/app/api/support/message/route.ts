import { NextResponse } from "next/server";
import { getPolarClient } from "@/lib/polar";
import { POLAR_DONATION_PRODUCT_ID } from "@/lib/polarProducts";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendDiscordEmbed } from "@/lib/discordNotify.server";
import { apiErrorResponse } from "@/lib/apiError";

// 支援者からのひとこと（2026-09-29、ホスト案）。「要望を送るのは気が引ける」人が、支援に "こうなったらいいな" を
// 添えられる窓口。会員特典の機能リクエスト（/api/contact）とは別枠。支援の決済から戻った画面だけで出し、
// Polar のチェックアウト id で「本当に寄付したか」を確かめてから受け付ける（支援していない人は送れない）。
// 保存先は問い合わせと同じ contact_inquiries（service＝「ご支援へのひとこと」、company＝決済 id）。admin の
// 「問い合わせ」タブにそのまま並ぶ。1 回の支援につき MAX_PER_CHECKOUT 通まで。
export const maxDuration = 30;

const LOG_PREFIX = "[support/message]";
const SERVICE_LABEL = "ご支援へのひとこと";
const MAX_MESSAGE = 2000;
const MAX_NAME = 50;
const MAX_PER_CHECKOUT = 3;

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
    const checkout = await getPolarClient().checkouts.get({ id: checkoutId });
    const paid = checkout.status === "succeeded" || checkout.status === "confirmed";
    if (!paid || checkout.productId !== POLAR_DONATION_PRODUCT_ID) {
      return NextResponse.json({ error: "支援の決済が確認できませんでした。" }, { status: 403 });
    }
    customerEmail = checkout.customerEmail ?? null;
    customerName = checkout.customerName ?? null;
    amount = checkout.totalAmount ?? checkout.amount ?? 0;
  } catch (err) {
    return apiErrorResponse(err, "verify_checkout", 403, LOG_PREFIX);
  }

  const tag = `polar_checkout:${checkoutId}`;
  const { count } = await supabaseAdmin
    .from("contact_inquiries")
    .select("id", { count: "exact", head: true })
    .eq("company", tag);
  if ((count ?? 0) >= MAX_PER_CHECKOUT) {
    return NextResponse.json({ error: "この支援からは、これ以上送れません。ありがとうございました。" }, { status: 429 });
  }

  const displayName = name || customerName || "（支援者）";
  const { error: insertError } = await supabaseAdmin.from("contact_inquiries").insert({
    name: displayName,
    email: customerEmail ?? "（支援の決済にメールなし）",
    company: tag,
    service: SERVICE_LABEL,
    message: `［¥${amount.toLocaleString()} のご支援］\n${message}`,
  });
  if (insertError) {
    console.error(`${LOG_PREFIX} insert failed:`, insertError.message);
    return NextResponse.json({ error: "送信に失敗しました。時間をおいてもう一度お試しください。" }, { status: 500 });
  }

  void sendDiscordEmbed({
    title: `💌 ${SERVICE_LABEL}（¥${amount.toLocaleString()}）`,
    description: `${displayName}\n\n${message.slice(0, 1500)}`,
  }).catch(() => undefined);

  return NextResponse.json({ ok: true });
}
