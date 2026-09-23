// 「実行中でも並列で今すぐ実行」の追加料金（全タブ共通の式、2026-09-23 ホスト決定）。
//
//   上乗せ = ceil(通常料金 × 率) + 固定分
//
// 順番待ち（無料・既定）は自分の 1 枠で順に流すだけだが、並列は 1 人で複数の GPU 枠
// （ワークスペースで 10 台）を同時に占有する。奪うのは GPU 時間ではなく枠の占有時間
// なので、占有時間の代理である通常料金に比例させる（率 1.0 = 合計 2 倍）。固定分は
// 余計に発生するコールドスタート 1 回分の markup（50C）。原価回収ではなく混雑料金
// （「急ぎたいなら金を払え」）なので、原価に合わせて下げる提案はしない。
// 固定だけだと、枠を長く占有する大きいジョブほど相対的に安くなり、狙いと逆になる。
//
// 新しい生成タブを作るときも同じ式・同じ knob 構成（<tab>_priority_parallel_rate /
// <tab>_priority_parallel_surcharge）にすること（CLAUDE.md §6-7）。
// フロント表示と API 検証は同じ baseCost と同じ knob をこの関数へ渡す。

export function parallelSurcharge(baseCost: number, rate: number, flat: number): number {
  const r = Number.isFinite(rate) ? Math.max(0, rate) : 0;
  const f = Number.isFinite(flat) ? Math.max(0, Math.round(flat)) : 0;
  return Math.ceil(Math.max(0, baseCost) * r) + f;
}
