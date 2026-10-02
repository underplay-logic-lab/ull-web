// Studio の各タブに出す「使い方の動画」（2026-10-02、ホスト要望: 説明動画としてサイトから見られるように）。
// 動画は YouTube（ullstudio チャンネル）に置き、ここに ID を書くとタブの説明の下にボタンが出る。書かなければ何も出ない。
// 作り方は promo/README.md（録画 → Remotion で書き出し）。

export type TutorialVideo = {
  /** YouTube の動画 ID（https://youtu.be/<ここ>） */
  youtubeId: string;
  /** ボタンに添える長さ（例: "1分半"） */
  length: string;
};

export const TUTORIAL_VIDEOS: Partial<Record<string, TutorialVideo>> = {
  angle: { youtubeId: "rHp12Zydb-g", length: "1分" },
};
