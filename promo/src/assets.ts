// 素材の差し込み口。ファイルを promo/public/ に置いて、ここにファイル名を書く。
// null のままの所は仮の枠（ラベル付き）で描くので、素材が揃う前から尺とテロップを確認できる。
// 画像（png/jpg/webp）でも動画（mp4/webm）でもよい。拡張子で見分ける。
//
// 守ること（CLAUDE.md §2）: GPU 型番・ベンダー名・基盤モデル名が写り込んだ画面を使わない。人物は自前生成の顔だけ。

export type Asset = string | null;

export const assets = {
  // 一番映えるカット（寄り・しゃべっている）。つかみと締めに使う
  hero: null as Asset,
  // 元の顔 1 枚
  sourceFace: null as Asset,
  // 「こだわり」で選ぶ基準の全身像・真横・後ろ姿（横型の 2 段目）
  baseViews: [null, null, null] as Asset[],
  // 素材づくりの結果。45 枚前後。足りない分は仮の枠で埋める
  dataset: [] as Asset[],
  // LoRA の途中の版から同じ指示で 1 枚ずつ（左から step 順）
  steps: [
    { label: "1,000 step", src: null as Asset },
    { label: "2,000 step", src: null as Asset },
    { label: "3,000 step", src: null as Asset },
    { label: "final", src: null as Asset },
  ],
  // 場面違いの動画。label は仮の枠に出す説明（本番の画面には出ない）
  clips: [
    { label: "屋外・昼・普段着", src: null as Asset },
    { label: "屋内・夜・別の服", src: null as Asset },
    { label: "振り向き（横顔）", src: null as Asset },
    { label: "引きの全身で歩く", src: null as Asset },
    { label: "季節がはっきりした場面", src: null as Asset },
  ],
  // （任意）動画超解像の使用前・使用後
  upscaleBefore: null as Asset,
  upscaleAfter: null as Asset,
  // 操作画面の録画（Playwright）。横型で早送りして使う
  screenDataset: null as Asset,
  screenLora: null as Asset,
};

export const DATASET_TILES = 45;
