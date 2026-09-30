import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";

// Email links (signup confirmation / password reset) land here directly on
// our own domain instead of bouncing through <project>.supabase.co/auth/v1/verify.
// The Supabase email templates point at
//   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=<type>&next=<path>
// and we redeem the hash server-side with verifyOtp. Unlike the PKCE `code`
// flow this needs no code verifier, so the link also works when opened on a
// different browser/device than the one that requested it.
const OTP_TYPES: readonly EmailOtpType[] = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
];

// Only same-origin paths — never let `next` turn this into an open redirect.
function safeNext(next: string | null, fallback: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(searchParams.get("next"), type === "recovery" ? "/reset-password" : "/");

  if (tokenHash && type && OTP_TYPES.includes(type)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/?authError=1`);
}
