/**
 * 生成ボタンの下に出す期待値の一文（2026-10-03 ホスト判断）。
 * 崩れや別人（性別・人種が変わる等）が実際に出ている Director と素材づくりだけに置く。
 * 個別の禁止事項は書かず「AI の性質としてこういう結果が出る」とだけ伝える（STATUS「期待値の方針」）。
 */
export default function GenerationCaveat({ className = "mt-2" }: { className?: string }) {
  return (
    <p className={`${className} text-[11px] leading-relaxed text-muted`}>
      AI による生成のため、崩れた結果や、元とかけ離れた結果（別人など）が出ることがあります。
    </p>
  );
}
