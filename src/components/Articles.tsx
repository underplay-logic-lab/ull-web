import { ArrowUpRight, Clock } from "lucide-react";
import { articles } from "@/lib/data";

const categoryColors: Record<string, string> = {
  Architecture: "text-neon-pink bg-neon-pink/10",
  Tutorial: "text-neon-violet bg-neon-violet/10",
  Workflow: "text-emerald-400 bg-emerald-400/10",
  "Deep Dive": "text-amber-400 bg-amber-400/10",
};

export function Articles() {
  return (
    <section id="articles" className="relative py-24 sm:py-32">
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-50" />

      <div className="relative mx-auto max-w-6xl px-6">
        <div className="mb-16 text-center">
          <p className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-violet">
            Articles
          </p>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            ノウハウ・技術解説
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted">
            AI開発・自動化・ComfyUI に関する実践的な記事を公開しています。
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          {articles.map((article) => (
            <a
              key={article.id}
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex flex-col rounded-2xl border border-border bg-surface/40 p-6 transition-all duration-300 hover:border-neon-violet/30 hover:bg-surface/70"
            >
              <div className="mb-4 flex items-center justify-between">
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-mono font-medium ${
                    categoryColors[article.category] ??
                    "text-muted bg-border"
                  }`}
                >
                  {article.category}
                </span>
                <ArrowUpRight
                  size={16}
                  className="text-muted transition-all group-hover:text-neon-pink group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                />
              </div>

              <h3 className="text-base font-semibold leading-snug transition-colors group-hover:text-neon-pink sm:text-lg">
                {article.title}
              </h3>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">
                {article.excerpt}
              </p>

              <div className="mt-4 flex items-center gap-4 text-xs text-muted">
                <time dateTime={article.date}>
                  {new Date(article.date).toLocaleDateString("ja-JP", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </time>
                <span className="flex items-center gap-1">
                  <Clock size={12} />
                  {article.readTime}
                </span>
              </div>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
