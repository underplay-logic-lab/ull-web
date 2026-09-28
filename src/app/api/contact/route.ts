import { NextResponse } from "next/server";
import { Resend } from "resend";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { memberContactServices, memberContactServicesFor } from "@/lib/data";

const TIER_LABEL: Record<string, string> = {
  entry: "エントリー",
  standard: "スタンダード",
  pro: "プロ",
  master: "マスター",
  studio: "スタジオ",
};

async function resolveMember(request: Request): Promise<{ userId: string; tier: string | null } | null> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const { data } = await supabaseAdmin.auth.getUser(token);
    const userId = data?.user?.id;
    if (!userId) return null;
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("subscription_tier, cancel_at_period_end")
      .eq("id", userId)
      .maybeSingle();
    const tier = (profile?.subscription_tier as string | null) ?? null;
    const active = tier && tier in TIER_LABEL && !profile?.cancel_at_period_end;
    return { userId, tier: active ? tier : null };
  } catch (err) {
    console.error("[Contact Form] could not resolve member tier:", err);
    return null;
  }
}

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
  // 会員特典（リクエスト・技術的なご相談は上位プランから優先して検討）: ログイン中なら送信者と今のプランを残す。
  // 解約予約中は特典が止まっている扱い（チャージ優待と同じ）。読めなくても問い合わせ自体は受け付ける。
  const member = await resolveMember(request);
  // 会員特典の相談内容は、条件を満たす会員からだけ受け付ける（フォームは選択肢を出し分けているが、細工された送信も弾く）。
  if (
    service &&
    memberContactServices.some((s) => s.label === service) &&
    !memberContactServicesFor(member?.tier).includes(service)
  ) {
    return NextResponse.json(
      { error: "この相談内容は月額プランの会員特典です（技術的なご相談はスタンダード以上）。ログインしてから送ってください。" },
      { status: 403 },
    );
  }
  const subjectTag = member?.tier ? `【${TIER_LABEL[member.tier] ?? member.tier}会員】` : "";

  const baseRow = { name, email, company: company || null, service: service || null, message };
  const insertInquiry = (row: Record<string, unknown>) =>
    supabaseAdmin.from("contact_inquiries").insert(row).select("id").single();
  let { data: inquiryRow, error: insertError } = await insertInquiry({
    ...baseRow,
    user_id: member?.userId ?? null,
    member_tier: member?.tier ?? null,
  });
  // マイグレーション 20260891 の適用前（member_tier 列が無い）でも問い合わせを取りこぼさない。
  if (insertError && /member_tier|user_id/.test(insertError.message)) {
    console.warn("[Contact Form] member columns missing — saving without them:", insertError.message);
    ({ data: inquiryRow, error: insertError } = await insertInquiry(baseRow));
  }

  if (insertError || !inquiryRow) {
    console.error("[Contact Form] failed to persist inquiry:", insertError?.message ?? "no row returned");
    return NextResponse.json(
      { error: "送信に失敗しました。しばらくしてから再度お試しください。" },
      { status: 500 },
    );
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  const receiverEmail = process.env.CONTACT_RECEIVER_EMAIL;
  const subject = subjectTag + (service ? `【お問い合わせ】${service}` : "【お問い合わせ】UNDERPLAY LOGIC LAB");

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
          `プラン: ${member?.tier ? TIER_LABEL[member.tier] ?? member.tier : "なし"}`,
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
            `**プラン**: ${member?.tier ? TIER_LABEL[member.tier] ?? member.tier : "なし"}`,
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
