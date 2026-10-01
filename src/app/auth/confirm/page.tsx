"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { EmailOtpType } from "@supabase/supabase-js";
import { KeyRound, Loader2, Mail } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";

// Email links (signup confirmation / password reset) land here on our own domain
// instead of bouncing through <project>.supabase.co/auth/v1/verify. The Supabase
// email templates point at
//   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=<type>&next=<path>
//
// The one-time token is redeemed only when the user presses the button, never on
// page load: mail providers / security scanners pre-open links in received mail,
// and a GET that consumed the token left the real click with an expired link
// (2026-09-30, password reset landed on /?authError=1).
const OTP_TYPES: readonly EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

// Only same-origin paths — never let `next` turn this into an open redirect.
function safeNext(next: string | null, fallback: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

type Params = { tokenHash: string; type: EmailOtpType; next: string };

export default function AuthConfirmPage() {
  const router = useRouter();
  const [params, setParams] = useState<Params | null | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const tokenHash = sp.get("token_hash");
    const type = sp.get("type") as EmailOtpType | null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- URL is only readable after mount
    setParams(
      tokenHash && type && OTP_TYPES.includes(type)
        ? { tokenHash, type, next: safeNext(sp.get("next"), type === "recovery" ? "/reset-password" : "/") }
        : null,
    );
  }, []);

  const isRecovery = params?.type === "recovery";

  const handleConfirm = async () => {
    if (!params) return;
    setSubmitting(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.verifyOtp({ type: params.type, token_hash: params.tokenHash });
    if (verifyError) {
      setSubmitting(false);
      setError(verifyError.message);
      return;
    }
    router.replace(params.next);
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-24">
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-40" />
      <div className="relative w-full max-w-sm rounded-2xl border-gradient bg-surface p-8">
        {params === undefined ? (
          <p className="flex items-center justify-center gap-2 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" />
            読み込み中...
          </p>
        ) : params === null ? (
          <>
            <h1 className="text-lg font-bold text-foreground">リンクを確認できませんでした</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              メールのリンクが途中で切れている可能性があります。お手数ですが、もう一度メールの送信からやり直してください。
            </p>
          </>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2 text-neon-pink">
              {isRecovery ? <KeyRound size={16} /> : <Mail size={16} />}
            </div>
            <h1 className="text-lg font-bold text-foreground">
              {isRecovery ? "パスワードの再設定" : "メールアドレスの確認"}
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              {isRecovery
                ? "下のボタンを押すと、新しいパスワードの入力画面に進みます。"
                : "下のボタンを押すと、アカウントの登録が完了します。"}
            </p>
            {error ? (
              <div className="mt-4 space-y-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                <p>
                  リンクが無効か、有効期限が切れています。リンクは 1 回しか使えません。お手数ですが、もう一度
                  {isRecovery ? "「パスワードをお忘れですか？」から" : "登録から"}やり直してください。
                </p>
                <p className="font-mono text-[10px] opacity-80">{error}</p>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleConfirm}
                disabled={submitting}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-background transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 glow-pink"
              >
                {submitting && <Loader2 size={16} className="animate-spin" />}
                {isRecovery ? "パスワードの再設定へ進む" : "登録を完了する"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
