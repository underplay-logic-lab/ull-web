import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

// PKCE callback for Google OAuth and password-reset email links (both use
// signInWithOAuth/resetPasswordForEmail's redirectTo, which now points here
// since migrating to @supabase/ssr's cookie-based, PKCE-flow sessions).
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/?authError=1`);
}
