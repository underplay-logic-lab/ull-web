import { NextResponse } from "next/server";
import { Resend } from "resend";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type ContactPayload = {
  name?: string;
  email?: string;
  company?: string;
  service?: string;
  message?: string;
  hp_company_url?: string;
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

  const { name, email, company, service, message, hp_company_url } = body;

  if (hp_company_url) {
    console.warn("[Contact Form] Honeypot triggered, discarding submission silently.");
    return NextResponse.json({ success: true });
  }

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

  // Persisted first, before the notification email is even attempted — this
  // is the durable record of the inquiry. A Resend failure below (e.g. an
  // unverified sending domain) must never lose an inquiry the customer
  // already submitted, only the notification about it.
  const { data: inquiryRow, error: insertError } = await supabaseAdmin
    .from("contact_inquiries")
    .insert({
      name,
      email,
      company: company || null,
      service: service || null,
      message,
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("[Contact Form] failed to persist inquiry:", insertError.message);
    return NextResponse.json(
      { error: "送信に失敗しました。しばらくしてから再度お試しください。" },
      { status: 500 },
    );
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  const receiverEmail = process.env.CONTACT_RECEIVER_EMAIL;
  const subject = service ? `【お問い合わせ】${service}` : "【お問い合わせ】UNDERPLAY LOGIC LAB";

  // Best-effort from here on — the inquiry is already safely stored above,
  // so a notification failure must not turn into a user-facing error.
  let emailSent = false;
  if (!resendApiKey || !receiverEmail) {
    console.error("[Contact Form] RESEND_API_KEY or CONTACT_RECEIVER_EMAIL is not configured; inquiry saved, notification skipped.");
  } else {
    try {
      const resend = new Resend(resendApiKey);
      const { error } = await resend.emails.send({
        from: `ULL Studio お問い合わせ <${receiverEmail}>`,
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
        console.error("[Contact Form] Resend send failed (inquiry is saved; notification only):", error);
      } else {
        emailSent = true;
      }
    } catch (err) {
      console.error("[Contact Form] Resend send threw (inquiry is saved; notification only):", err);
    }
  }

  if (emailSent) {
    const { error: updateError } = await supabaseAdmin
      .from("contact_inquiries")
      .update({ email_sent: true })
      .eq("id", inquiryRow.id);
    if (updateError) {
      console.error("[Contact Form] failed to mark inquiry as notified:", updateError.message);
    }
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
