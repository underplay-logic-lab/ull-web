"use client";

// 「編集して作り直す」の欄の上に出す「日本語訳／英語の原文」の切り替え（2026-10-06、Director・Photo Director 共用）。
// 日本語訳を直すと送るときに英訳の AI を通る（制限ワードなら解除の確認＋追加料金）。英語の原文なら AI を通さずそのまま使う。
// 小さなリンクでは気づかれなかったので、欄の真上に押しやすい大きさで置く。

export function PromptLanguageSwitch({
  ja,
  en,
  draft,
  onPick,
}: {
  ja: string | null;
  en: string;
  draft: string;
  onPick: (text: string) => void;
}) {
  if (!ja) return null;
  const isEn = draft === en;
  const isJa = draft === ja;
  const btn = (active: boolean) =>
    `flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
      active ? "bg-neon-violet/15 text-foreground" : "text-muted hover:text-foreground"
    }`;
  return (
    <div className="mb-2">
      <div className="flex items-center gap-1 rounded-xl border border-border bg-background p-1">
        <button type="button" onClick={() => onPick(ja)} className={btn(isJa)}>
          日本語訳を直す
        </button>
        <button type="button" onClick={() => onPick(en)} className={btn(isEn)}>
          英語の原文を直す
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">
        {isEn || !/[ぁ-んァ-ヶ一-龯]/.test(draft)
          ? "英語はそのまま使います（AI を通さないので、表現の制限にかからず追加料金もかかりません）。"
          : "日本語は送るときに英語へ直します（表現の制限にかかると、解除するか確認が出ます）。"}
        {!isEn && !isJa && " 切り替えると、いま書き換えた内容は元に戻ります。"}
      </p>
    </div>
  );
}
