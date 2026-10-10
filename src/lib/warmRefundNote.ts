/** 温まり返金（2026-10-10）: ジョブの metadata から、完了時にワーカーが返した額を取り出す（無ければ null）。 */
export function warmRefundOf(metadata: unknown): number | null {
  const v = (metadata as { warm_refund_credits?: unknown } | null)?.warm_refund_credits;
  return typeof v === "number" && v > 0 ? v : null;
}
