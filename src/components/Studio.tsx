"use client";

import { useState } from "react";
import { Download, Loader2, LogIn, Sparkles, Wand2 } from "lucide-react";
import { aspectRatios, type AspectRatio } from "@/lib/data";
import { LoginModal } from "@/components/LoginModal";
import { CreditsBadge } from "@/components/CreditsBadge";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { supabase } from "@/lib/supabaseClient";

type Status = "idle" | "loading" | "done" | "error";

const RATIO_ASPECT_CLASS: Record<AspectRatio, string> = {
  "16:9": "aspect-video",
  "9:16": "aspect-[9/16]",
  "1:1": "aspect-square",
};

export function Studio() {
  const { user } = useSupabaseUser();
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<AspectRatio>("1:1");
  const [status, setStatus] = useState<Status>("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

  const handleGenerate = async () => {
    if (!prompt.trim() || status === "loading") return;

    if (!user) {
      setLoginOpen(true);
      return;
    }

    setStatus("loading");
    setPreviewUrl(null);
    setErrorMessage(null);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;

      if (!accessToken) {
        setLoginOpen(true);
        setStatus("idle");
        return;
      }

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ prompt, ratio }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "画像生成に失敗しました。");
      }

      setPreviewUrl(data.image as string);
      setStatus("done");
    } catch (err) {
      console.error("[Studio] generation failed:", err);
      setErrorMessage(err instanceof Error ? err.message : "画像生成に失敗しました。");
      setStatus("error");
    }
  };

  return (
    <section id="studio" className="relative py-24 sm:py-32">
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-40" />

      <div className="relative mx-auto max-w-5xl px-6">
        <div className="mb-16 text-center">
          <p className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-pink">
            Studio
          </p>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            AI Generation Studio
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted">
            プロンプトとアスペクト比を指定するだけ。ブラウザから今すぐAI生成を体験できます。
          </p>
          {user && (
            <div className="mt-5 flex justify-center">
              <CreditsBadge user={user} className="inline-flex" />
            </div>
          )}
        </div>

        <div className="grid gap-8 rounded-2xl border-gradient bg-surface/40 p-6 sm:p-8 lg:grid-cols-2">
          <div className="flex flex-col">
            <label
              htmlFor="prompt"
              className="mb-1.5 block text-xs font-medium text-muted"
            >
              プロンプト
            </label>
            <textarea
              id="prompt"
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="例: 夜のネオン街を歩くサイバーパンクな猫、シネマティックライティング"
              className="w-full resize-none rounded-lg border border-border bg-background px-4 py-3 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
            />

            <div className="mt-5">
              <p className="mb-2 text-xs font-medium text-muted">アスペクト比</p>
              <div className="flex gap-2">
                {aspectRatios.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setRatio(option.id)}
                    className={`flex-1 rounded-lg border px-3 py-2.5 font-mono text-sm transition-colors ${
                      ratio === option.id
                        ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                        : "border-border bg-background text-muted hover:border-neon-violet/40 hover:text-foreground"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={handleGenerate}
              disabled={!prompt.trim() || status === "loading"}
              className="mt-6 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 glow-pink"
            >
              {status === "loading" ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  生成中...
                </>
              ) : !user ? (
                <>
                  <LogIn size={16} />
                  ログインして生成
                </>
              ) : (
                <>
                  <Wand2 size={16} />
                  Generate
                </>
              )}
            </button>

            <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted">
              <Sparkles size={14} className="mt-0.5 shrink-0 text-neon-violet" />
              {user
                ? "保有クレジットの範囲でいつでも生成できます（1生成につき1クレジット消費）。"
                : "Studioの利用にはGoogleログインが必要です。ログインすると10クレジットが付与されます。"}
            </p>

            {status === "error" && errorMessage && (
              <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {errorMessage}
              </p>
            )}
          </div>

          <div className="flex flex-col">
            <p className="mb-1.5 text-xs font-medium text-muted">プレビュー</p>
            <div
              className={`relative w-full overflow-hidden rounded-xl border border-border bg-background ${RATIO_ASPECT_CLASS[ratio]}`}
            >
              {status === "loading" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface/60">
                  <Loader2 size={28} className="animate-spin text-neon-pink" />
                  <span className="font-mono text-xs text-muted">
                    GPUを起動して生成しています...
                  </span>
                  <span className="max-w-[80%] text-center text-[11px] text-muted/70">
                    初回起動には数十秒〜数分かかる場合があります
                  </span>
                </div>
              )}

              {status === "idle" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted">
                  <Wand2 size={28} className="opacity-40" />
                  <span className="text-xs">生成結果がここに表示されます</span>
                </div>
              )}

              {status === "error" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted">
                  <Wand2 size={28} className="opacity-40" />
                  <span className="text-xs">生成に失敗しました</span>
                </div>
              )}

              {status === "done" && previewUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt={prompt || "生成されたプレビュー"}
                  className="h-full w-full object-cover"
                />
              )}
            </div>

            {status === "done" && previewUrl && (
              <a
                href={previewUrl}
                download="underplay-studio-generation.png"
                className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-border bg-surface/60 px-6 py-3 text-sm font-medium text-foreground transition-colors hover:border-neon-pink/50 hover:bg-surface-hover"
              >
                <Download size={16} />
                Download
              </a>
            )}
          </div>
        </div>
      </div>

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        message="Studioで画像を生成するにはログインしてください。"
      />
    </section>
  );
}
