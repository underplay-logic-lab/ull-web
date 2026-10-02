// JSZip は ZIP 内のファイル日時を UTC のまま書く（ZIP の日時にはタイムゾーンが無く、展開側は現地時刻として読む）。
// そのままだと日本では 9 時間前の時刻に見える（22:37 が 13:37、2026-10-02）。現地時刻ぶんずらして渡す。
export function zipLocalDate(d: Date = new Date()): Date {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
}
