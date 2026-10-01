// ロゴ（2026-10-01 ブランド刷新: 黒 × 明朝の文字だけ。記号や差し色は付けない）。
// SNS の素材（promo/brand/render.mjs）と同じ組み方: 「ULL」を地の文字色、「Studio」を控えめの色、字間は広め。
// 運営者名 UNDERPLAY LOGIC LAB は法務ページ・フッターの著作権表記にだけ出す（siteConfig.name）。
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`whitespace-nowrap font-serif tracking-[0.16em] ${className}`}>
      ULL<span className="ml-[0.5em] text-muted">Studio</span>
    </span>
  );
}
