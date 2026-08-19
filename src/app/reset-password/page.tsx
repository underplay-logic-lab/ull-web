"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, KeyRound, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { PasswordInput } from "@/components/PasswordInput";

type Status = "idle" | "submitting" | "success";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (password.length < 6) {
      setErrorMessage("パスワードは6文字以上で入力してください。");
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage("パスワードが一致しません。");
      return;
    }

    setStatus("submitting");

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setErrorMessage(error.message);
      setStatus("idle");
      return;
    }

    setStatus("success");
    setTimeout(() => {
      router.push("/");
    }, 3000);
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-24">
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-40" />

      <div className="relative w-full max-w-sm rounded-2xl border-gradient bg-surface p-8">
        <div className="mb-2 flex items-center gap-2 text-neon-pink">
          <KeyRound size={16} />
          <span className="font-mono text-xs uppercase tracking-widest">
            Reset Password
          </span>
        </div>
        <h1 className="text-lg font-bold text-foreground">
          新しいパスワードの設定
        </h1>

        {status === "success" ? (
          <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
            <CheckCircle size={40} className="text-neon-pink" />
            <p className="text-sm font-medium text-foreground">
              パスワードが正常に更新されました
            </p>
            <p className="text-xs text-muted">
              まもなくトップページへ移動します...
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-6 space-y-3">
            <div>
              <label
                htmlFor="new-password"
                className="mb-1.5 block text-xs font-medium text-muted"
              >
                新しいパスワード
              </label>
              <PasswordInput
                id="new-password"
                required
                minLength={6}
                value={password}
                onChange={setPassword}
                placeholder="6文字以上"
                autoComplete="new-password"
              />
            </div>

            <div>
              <label
                htmlFor="confirm-password"
                className="mb-1.5 block text-xs font-medium text-muted"
              >
                パスワード（確認用）
              </label>
              <PasswordInput
                id="confirm-password"
                required
                minLength={6}
                value={confirmPassword}
                onChange={setConfirmPassword}
                placeholder="もう一度入力してください"
                autoComplete="new-password"
              />
            </div>

            {errorMessage && (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {errorMessage}
              </p>
            )}

            <button
              type="submit"
              disabled={status === "submitting"}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 glow-pink"
            >
              {status === "submitting" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <KeyRound size={16} />
              )}
              パスワードを更新する
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
