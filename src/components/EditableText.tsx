"use client";

type EditableTag = "span" | "p" | "h1" | "h2" | "h3" | "div";

type EditableTextProps = {
  // 以前は site_contents の key。今は識別用に残しているだけで、表示には使わない。
  siteKey: string;
  // 表示する文言（これがそのまま出る）。
  fallback: string;
  as?: EditableTag;
  className?: string;
};

// サイトの文言（2026-09-30 ホスト判断でコードに一本化）。
// 以前は管理画面の編集モードで site_contents（DB）に上書きでき、表示は「DB の値 → 無ければ fallback」だったが、
// DB とコードが 22 件食い違い、どちらが表示されているか分からなくなっていた。文言はこのコードの fallback だけを
// 表示し、DB は読まない。直すときはソースを直す（ローカルでは SourceTextEditor でクリック編集できる）。
// リンク先（EditableLink）・画像（EditableMedia）・セクションの表示と並び順（HomeSections）は従来どおり DB。
export function EditableText({ fallback, as = "span", className }: EditableTextProps) {
  const Tag = as;
  return <Tag className={className}>{fallback}</Tag>;
}
