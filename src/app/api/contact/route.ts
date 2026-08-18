import { NextResponse } from "next/server";
import { Resend } from "resend";

type ContactPayload = {
  name?: string;
  email?: string;
  company?: string;
  service?: string;
  message?: string;
};

export async function POST(request: Request) {
  let body: ContactPayload;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "リクエストの形式が正しくありません。" },
      { status: 400 },
    );
  }

  const { name, email, company, service, message } = body;

  if (!name || !email || !message) {
    return NextResponse.json(
      { error: "お名前・メールアドレス・お問い合わせ内容は必須です。" },
      { status: 400 },
    );
  }

  console.log("[Contact Form Submission]", {
    name,
    email,
    company: company || null,
    service: service || null,
    message,
    receivedAt: new Date().toISOString(),
  });

  const resendApiKey = process.env.RESEND_API_KEY;
  const receiverEmail = process.env.CONTACT_RECEIVER_EMAIL;

  if (!resendApiKey || !receiverEmail) {
    console.error(
      "[Contact Form] RESEND_API_KEY or CONTACT_RECEIVER_EMAIL is not configured.",
    );
    return NextResponse.json(
      { error: "メール送信の設定が完了していません。" },
      { status: 500 },
    );
  }

  const resend = new Resend(resendApiKey);
  const subject = service ? `【お問い合わせ】${service}` : "【お問い合わせ】UNDERPLAY LOGIC LAB";

  try {
    const { error } = await resend.emails.send({
      from: "ULL Contact <onboarding@resend.dev>",
      to: receiverEmail,
      replyTo: email,
      subject,
      text: [
        `お名前: ${name}`,
        `メールアドレス: ${email}`,
        `会社名 / 組織名: ${company || "-"}`,
        `ご相談内容: ${service || "-"}`,
        "",
        "詳細:",
        message,
      ].join("\n"),
    });

    if (error) {
      console.error("[Contact Form] Resend send failed:", error);
      return NextResponse.json(
        { error: "メール送信に失敗しました。" },
        { status: 500 },
      );
    }
  } catch (err) {
    console.error("[Contact Form] Resend send threw:", err);
    return NextResponse.json(
      { error: "メール送信に失敗しました。" },
      { status: 500 },
    );
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [
            "📩 **新しいお問い合わせ**",
            `**お名前**: ${name}`,
            `**メール**: ${email}`,
            `**会社名**: ${company || "-"}`,
            `**相談内容**: ${service || "-"}`,
            "**詳細**:",
            message,
          ].join("\n"),
        }),
      });
    } catch (err) {
      console.error("[Contact Form] Discord webhook notification failed:", err);
    }
  }

  return NextResponse.json({ success: true });
}
