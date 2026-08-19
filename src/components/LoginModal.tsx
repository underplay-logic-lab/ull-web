"use client";

import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { KeyRound, Loader2, Mail, X } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { PasswordInput } from "@/components/PasswordInput";

type LoginModalProps = {
  open: boolean;
  onClose: () => void;
  message?: string;
};

type Tab = "google" | "email";
type EmailMode = "login" | "signup" | "reset";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4c-7.5 0-14 4.2-17.7 10.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.5 0 10.4-1.9 14.3-5.1l-6.6-5.6C29.6 35.4 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.6 5.1C9.9 39.7 16.4 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.3-4.1 5.7l6.6 5.6C41.7 36.5 44 30.7 44 24c0-1.3-.1-2.7-.4-3.5z"
      />
    </svg>
  );
}

export function LoginModal({ open, onClose, message }: LoginModalProps) {
  const [tab, setTab] = useState<Tab>("google");
  const [signingIn, setSigningIn] = useState(false);

  const [emailMode, setEmailMode] = useState<EmailMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [emailSubmitting, setEmailSubmitting] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailNotice, setEmailNotice] = useState<string | null>(null);

  const handleGoogleLogin = async () => {
    setSigningIn(true);

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}`,
      },
    });

    if (error) {
      setSigningIn(false);
      alert(`Googleログインに失敗しました: ${error.message}`);
    }
    // On success, the browser navigates to Google's consent screen,
    // so no further local state update is needed here.
  };

  const handleEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setEmailNotice(null);

    if (emailMode === "signup") {
      if (password.length < 6) {
        setEmailError("パスワードは6文字以上で入力してください。");
        return;
      }
      if (password !== confirmPassword) {
        setEmailError("パスワードが一致しません。");
        return;
      }
    }

    setEmailSubmitting(true);

    try {
      if (emailMode === "reset") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        setEmailNotice(
          "パスワード再設定用のメールを送信しました。メール内のリンクから再設定してください。",
        );
      } else if (emailMode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;

        if (!data.session) {
          // Email confirmation is required before the account can sign in.
          setEmailNotice(
            "確認メールを送信しました。メール内のリンクからログインを完了してください。",
          );
        } else {
          handleClose();
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        handleClose();
      }
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "処理に失敗しました。");
    } finally {
      setEmailSubmitting(false);
    }
  };

  const handleClose = () => {
    setEmail("");
    setPassword("");
    setConfirmPassword("");
    setEmailMode("login");
    setEmailError(null);
    setEmailNotice(null);
    onClose();
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border-gradient bg-surface p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">ログイン</h3>
          <button
            type="button"
            onClick={handleClose}
            aria-label="閉じる"
            className="text-muted transition-colors hover:text-foreground"
          >
            <X size={20} />
          </button>
        </div>

        <p className="mt-2 text-sm leading-relaxed text-muted">
          {message ?? "続行するにはログインしてください。"}
        </p>

        <div className="mt-6 flex gap-1 rounded-lg border border-border bg-background p-1">
          <button
            type="button"
            onClick={() => setTab("google")}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === "google"
                ? "bg-surface-hover text-foreground"
                : "text-muted hover:text-foreground"
            }`}
          >
            Google
          </button>
          <button
            type="button"
            onClick={() => setTab("email")}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === "email"
                ? "bg-surface-hover text-foreground"
                : "text-muted hover:text-foreground"
            }`}
          >
            メールアドレス
          </button>
        </div>

        {tab === "google" ? (
          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={signingIn}
            className="mt-4 flex w-full items-center justify-center gap-2.5 rounded-xl border border-border bg-background px-6 py-3 text-sm font-medium transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {signingIn ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                Googleへ接続中...
              </>
            ) : (
              <>
                <GoogleIcon />
                Googleでログイン
              </>
            )}
          </button>
        ) : (
          <form onSubmit={handleEmailSubmit} className="mt-4 space-y-3">
            <div>
              <label htmlFor="login-email" className="mb-1.5 block text-xs font-medium text-muted">
                メールアドレス
              </label>
              <input
                id="login-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                placeholder="you@example.com"
              />
            </div>

            {emailMode !== "reset" && (
              <div>
                <label htmlFor="login-password" className="mb-1.5 block text-xs font-medium text-muted">
                  パスワード
                </label>
                <PasswordInput
                  id="login-password"
                  required
                  minLength={6}
                  value={password}
                  onChange={setPassword}
                  placeholder="6文字以上"
                  autoComplete={emailMode === "signup" ? "new-password" : "current-password"}
                />
              </div>
            )}

            {emailMode === "signup" && (
              <div>
                <label htmlFor="signup-confirm-password" className="mb-1.5 block text-xs font-medium text-muted">
                  パスワード（確認用）
                </label>
                <PasswordInput
                  id="signup-confirm-password"
                  required
                  minLength={6}
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  placeholder="もう一度入力してください"
                  autoComplete="new-password"
                />
              </div>
            )}

            {emailMode === "login" && (
              <button
                type="button"
                onClick={() => {
                  setEmailMode("reset");
                  setEmailError(null);
                  setEmailNotice(null);
                }}
                className="block text-xs text-muted hover:text-neon-violet hover:underline"
              >
                パスワードをお忘れですか？
              </button>
            )}

            {emailError && (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {emailError}
              </p>
            )}
            {emailNotice && (
              <p className="rounded-lg border border-neon-violet/30 bg-neon-violet/10 px-3 py-2 text-xs text-neon-violet">
                {emailNotice}
              </p>
            )}

            <button
              type="submit"
              disabled={emailSubmitting}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {emailSubmitting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : emailMode === "reset" ? (
                <KeyRound size={16} />
              ) : (
                <Mail size={16} />
              )}
              {emailMode === "signup"
                ? "アカウントを作成"
                : emailMode === "reset"
                  ? "リセットメールを送信"
                  : "ログイン"}
            </button>

            <button
              type="button"
              onClick={() => {
                setEmailMode(emailMode === "signup" ? "login" : emailMode === "reset" ? "login" : "signup");
                setEmailError(null);
                setEmailNotice(null);
              }}
              className="w-full text-center text-xs text-muted hover:text-neon-violet hover:underline"
            >
              {emailMode === "signup"
                ? "すでにアカウントをお持ちの方はこちら"
                : emailMode === "reset"
                  ? "ログインに戻る"
                  : "アカウントをお持ちでない方はこちら"}
            </button>
          </form>
        )}

        <p className="mt-4 text-center text-xs text-muted">
          ログインすると10クレジットが付与されます。
        </p>
      </div>
    </div>,
    document.body,
  );
}
