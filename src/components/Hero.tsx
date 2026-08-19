import { ArrowDown, Download, Gift, Sparkles, Wand2 } from "lucide-react";

export function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden grid-bg">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute top-1/4 left-1/4 h-96 w-96 rounded-full bg-neon-pink/10 blur-[120px] animate-pulse-glow" />
        <div className="absolute bottom-1/4 right-1/4 h-96 w-96 rounded-full bg-neon-violet/10 blur-[120px] animate-pulse-glow" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6 pt-32 pb-20 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface/60 px-4 py-1.5 text-xs font-mono text-muted backdrop-blur-sm">
          <Sparkles size={12} className="text-neon-pink" />
          AI Generation & Automation Lab
        </div>

        <h1 className="mx-auto max-w-4xl text-4xl font-bold leading-tight tracking-tight sm:text-5xl md:text-6xl lg:text-7xl">
          <span className="inline-block text-gradient">スマホや低スペックPCから</span>
          <br />
          <span className="inline-block text-foreground">ブラウザで手軽に動く</span>
          <br />
          <span className="inline-block text-gradient">商用AI画像・動画生成スタジオ</span>
        </h1>

        <p className="mx-auto mt-8 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
          最新モデルをクラウドGPUで高速生成。独自AI環境の構築受託・自動化相談も受付中。
        </p>

        <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-neon-pink/30 bg-neon-pink/10 px-4 py-1.5 text-xs font-mono font-medium text-neon-pink">
          <Gift size={14} />
          Googleログインで即時10クレジット無料進呈（クレカ登録不要）
        </div>

        <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <a
            href="#studio"
            className="group flex items-center gap-2 rounded-full bg-gradient-to-r from-neon-pink to-neon-violet px-8 py-3.5 text-sm font-semibold text-white transition-all hover:opacity-90 glow-pink"
          >
            <Wand2 size={16} />
            Studioを試す
          </a>
          <a
            href="#products"
            className="flex items-center gap-2 rounded-full border border-border bg-surface/60 px-8 py-3.5 text-sm font-medium text-foreground backdrop-blur-sm transition-colors hover:border-neon-violet/50 hover:bg-surface-hover"
          >
            <Download size={16} />
            ツールをダウンロード
          </a>
        </div>

        <div className="mt-20 flex items-center justify-center gap-8 text-center">
          {[
            { value: "¥500〜", label: "都度チャージで開始" },
            { value: "180日", label: "クレジット有効期限" },
            { value: "100%", label: "商用利用可能" },
          ].map((stat) => (
            <div key={stat.label} className="hidden sm:block">
              <div className="font-mono text-2xl font-bold text-gradient">
                {stat.value}
              </div>
              <div className="mt-1 text-xs text-muted">{stat.label}</div>
            </div>
          ))}
        </div>

        <a
          href="#studio"
          className="mt-16 inline-flex animate-float flex-col items-center gap-2 text-muted transition-colors hover:text-neon-pink"
          aria-label="スクロール"
        >
          <span className="text-xs font-mono tracking-widest uppercase">
            Scroll
          </span>
          <ArrowDown size={16} />
        </a>
      </div>
    </section>
  );
}
