// 人ごとに許可する機能の一覧（2026-10-09）。DB の user_feature_grants.feature はここのキーを持つ。
// 一般公開しない機能だけを載せる（全員が使える機能はここに書かない）。admin は許可が無くても全部使える。
// label / description は admin 画面の表示用。一般の画面に出すときは各タブ側の文言を使う（内部モデル名を出さない、CLAUDE.md §2）。

export const FEATURES = {
  face_swap_head: {
    label: "顔入れ替え（髪型ごと）",
    description: "頭まるごと（顔＋髪型）の入れ替え。ライセンス上の義務があるため許可制。",
  },
  worldgen_trial: {
    label: "背景づくり（360°）",
    description: "文章や画像から 360 度の部屋を作る。非商用ライセンスのモデルを含むため、許可した人だけの限定公開。",
  },
  restyle_trial: {
    label: "画風を変える（構図そのまま）",
    description: "元画像の構図だけ借りて、指定の画風で描き直す（お客さんの要望・料金の実測が済むまで許可制）。",
  },
  qwen21_trial: {
    label: "Qwen Image 2.1 お試し",
    description: "非商用ライセンスのモデル。受注前のお試し・ワークフロー納品の検討用。",
  },
} as const;

export type FeatureKey = keyof typeof FEATURES;

export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === "string" && value in FEATURES;
}
