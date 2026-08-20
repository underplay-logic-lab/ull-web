import { NextResponse } from "next/server";

const VERIFY_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Gates the email/password auth forms (signup, login, password reset) in
// LoginModal.tsx — called with the widget's token right before the actual
// Supabase auth call, so a bot that never solves the challenge can't create
// accounts or burn through the Resend email quota via password resets.
export async function POST(request: Request) {
  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const token = body.token;
  if (!token) {
    return NextResponse.json({ error: "ボット認証を完了してください。" }, { status: 400 });
  }

  const secretKey = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
  if (!secretKey) {
    console.error("[turnstile/verify] CLOUDFLARE_TURNSTILE_SECRET_KEY is not configured.");
    return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
  }

  const remoteIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();

  try {
    const verifyRes = await fetch(VERIFY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: secretKey,
        response: token,
        ...(remoteIp ? { remoteip: remoteIp } : {}),
      }),
    });

    const verifyData = await verifyRes.json();

    if (!verifyData.success) {
      console.error(
        "[turnstile/verify] verification failed:",
        verifyData["error-codes"] ?? verifyData,
      );
      return NextResponse.json(
        { error: "ボット検証に失敗しました。もう一度お試しください。" },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[turnstile/verify] request to Cloudflare failed:", err);
    return NextResponse.json({ error: "ボット検証中にエラーが発生しました。" }, { status: 500 });
  }
}
