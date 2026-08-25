import { CheckCircle2 } from "lucide-react";
import { products } from "@/lib/data";
import { DownloadButton } from "@/components/DownloadButton";

export function Products() {
  return (
    <section id="products" data-source-file="src/components/Products.tsx" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-16 text-center">
          <p className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-pink">
            Products
          </p>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            自作ツール配布
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted">
            実際のAI開発現場で使用・検証されたツール群。無料でダウンロード可能です。
          </p>
        </div>

        <div className="mx-auto grid max-w-xl gap-8">
          {products.map((product, index) => (
            <article
              key={product.id}
              id={product.id}
              className="group relative flex flex-col rounded-2xl border-gradient bg-surface/40 p-8 transition-all duration-300 hover:bg-surface/70"
            >
              {product.badge && (
                <span
                  className={`absolute top-6 right-6 rounded-full px-3 py-1 text-xs font-mono font-medium ${
                    index === 0
                      ? "bg-neon-pink/10 text-neon-pink"
                      : "bg-neon-violet/10 text-neon-violet"
                  }`}
                >
                  {product.badge}
                </span>
              )}

              <div className="mb-1 font-mono text-xs text-muted">
                {product.version}
              </div>
              <h3 className="text-xl font-bold leading-snug sm:text-2xl">
                {product.name}
              </h3>
              <p className="mt-1 text-sm font-medium text-neon-violet">
                {product.tagline}
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                {product.quickBadges.map((badge) => (
                  <span
                    key={badge}
                    className="rounded-full border border-border bg-background px-3 py-1 font-mono text-xs text-foreground/80"
                  >
                    {badge}
                  </span>
                ))}
              </div>

              <p className="mt-4 text-sm leading-relaxed text-muted">
                {product.description}
              </p>

              <ul className="mt-6 flex-1 space-y-2.5">
                {product.features.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-start gap-2.5 text-sm text-foreground/80"
                  >
                    <CheckCircle2
                      size={16}
                      className="mt-0.5 shrink-0 text-neon-pink"
                    />
                    {feature}
                  </li>
                ))}
              </ul>

              {product.note && (
                <p className="mt-4 text-xs leading-relaxed text-muted">{product.note}</p>
              )}

              <DownloadButton
                productName={product.name}
                version={product.version}
                variant={index === 0 ? "pink" : "violet"}
                downloadUrl={product.downloadUrl}
              />

              {product.downloadUrl && (
                <p className="mt-3 text-xs leading-relaxed text-muted">
                  ※
                  初回ダウンロード時、ブラウザやWindowsの警告（SmartScreen）が表示される場合があります。「保持する」および「詳細情報
                  ➔ 実行」を選択して起動してください（ウイルスフリー・安全確認済み）。
                </p>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
