import { NextResponse } from "next/server";

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

  return NextResponse.json({ ok: true });
}
