"use client";

import { useState } from "react";
import { Download, Loader2, LogIn, Sparkles, Wand2 } from "lucide-react";
import { aspectRatios, type AspectRatio } from "@/lib/data";
import { LoginModal } from "@/components/LoginModal";

type Status = "idle" | "loading" | "done";

const RATIO_DIMENSIONS: Record<AspectRatio, [number, number]> = {
  "16:9": [640, 360],
  "9:16": [360, 640],
  "1:1": [480, 480],
};

const RATIO_ASPECT_CLASS: Record<AspectRatio, string> = {
  "16:9": "aspect-video",
  "9:16": "aspect-[9/16]",
  "1:1": "aspect-square",
};

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPreviewDataUrl(prompt: string, ratio: AspectRatio) {
  const [w, h] = RATIO_DIMENSIONS[ratio];
  const trimmed = prompt.trim();
  const label = escapeXml(
    trimmed.length > 64 ? `${trimmed.slice(0, 64)}…` : trimmed || "Generated Preview",
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ff2a85"/>
        <stop offset="100%" stop-color="#8b5cf6"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="#1c1c1e"/>
    <rect width="${w}" height="${h}" fill="url(#g)" opacity="0.28"/>
    <foreignObject x="24" y="${h / 2 - 40}" width="${w - 48}" height="80">
      <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: monospace; font-size: 15px; line-height: 1.5; color: #ffffff; text-align: center; word-break: break-word;">
        ${label}
      </div>
    </foreignObject>
    <text x="16" y="${h - 16}" fill="#ffffff" fill-opacity="0.6" font-family="monospace" font-size="11">UNDERPLAY STUDIO · ${ratio}</text>
  </svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function Studio() {
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<AspectRatio>("1:1");
  const [status, setStatus] = useState<Status>("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [generationCount, setGenerationCount] = useState(0);
  const [loginOpen, setLoginOpen] = useState(false);

  const isGuestLimitReached = generationCount >= 1;

  const handleGenerate = () => {
    if (!prompt.trim() || status === "loading") return;

    if (isGuestLimitReached) {
      setLoginOpen(true);
      return;
    }

    setStatus("loading");
    setPreviewUrl(null);

    window.setTimeout(() => {
      setPreviewUrl(buildPreviewDataUrl(prompt, ratio));
      setStatus("done");
      setGenerationCount((count) => count + 1);
    }, 1800);
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
              ) : isGuestLimitReached ? (
                <>
                  <LogIn size={16} />
                  ログインして続ける
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
              {isGuestLimitReached
                ? "無料体験は1回のみです。続けて生成するにはGoogleログインが必要です。"
                : "登録なしで1回まで無料体験できます。2回目以降はGoogleログインが必要です。"}
            </p>
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
                    生成しています...
                  </span>
                </div>
              )}

              {status === "idle" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted">
                  <Wand2 size={28} className="opacity-40" />
                  <span className="text-xs">生成結果がここに表示されます</span>
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
                download="underplay-studio-preview.svg"
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
        message="無料体験は1回のみです。続けてStudioを利用するにはログインしてください。"
      />
    </section>
  );
}
