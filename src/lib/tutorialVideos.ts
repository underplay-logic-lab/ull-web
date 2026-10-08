// Studio の各タブに出す「使い方の動画」（2026-10-02、ホスト要望: 説明動画としてサイトから見られるように）。
// 動画は YouTube（ullstudio チャンネル）に置き、ここに ID を書くとタブの説明の下にボタンが出る。書かなければ何も出ない。
// 1 つのタブに複数本を並べられる（2026-10-05、LoRA Studio に「作り方」と「学び直し」）。label は 2 本以上のときにボタンに出す。
// 作り方は promo/README.md（録画 → Remotion で書き出し）。

export type TutorialVideo = {
  /** YouTube の動画 ID（https://youtu.be/<ここ>） */
  youtubeId: string;
  /** ボタンに添える長さ（例: "1分半"） */
  length: string;
  /** 同じタブに 2 本以上あるときの見分け（例: "学び直し"） */
  label?: string;
};

export const TUTORIAL_VIDEOS: Partial<Record<string, TutorialVideo[]>> = {
  angle: [{ youtubeId: "97jplBqgBiU", length: "1分" }],
  dataset: [{ youtubeId: "HM0POrlvkLQ", length: "7分" }],
  lora: [
    { youtubeId: "LtYgcKU_hJw", length: "4分", label: "作り方" },
    { youtubeId: "S7YOU78KkPk", length: "2分半", label: "学び直し" },
  ],
  song: [{ youtubeId: "PDD-UU6L75I", length: "5分" }],
  director: [{ youtubeId: "zrO661jI5T4", length: "2分半" }],
};
