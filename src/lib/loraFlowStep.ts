// LoRA Studio の「次にやること」を1つの派生値として求める（2026-09-22）。
//
// ホスト提案:「初めての人には手順が分かりにくい。次に入力／押下すべき欄や
// ボタンが順次光ると直感的。選択肢があるときは両方光れば、どちらかを選べば
// いいと分かる」。
//
// ⚠️ **新しい状態を持たない。** 画面の状態から毎回導出する。独立した進行状態
// を持つと、ユーザーが前の工程へ戻ったときに必ずズレる（このタブは戻る操作が
// 多い——画像を足す、特徴を直す、クロップをやり直す）。
//
// ⚠️ 順序は一本道ではない。クロップは任意で、診断が問題なしなら飛ばす。
// 「必須の未完了があればそれを1つだけ、無ければ次に進む選択肢を複数」という
// 優先順位で決める。

/** 光らせる対象の識別子。UI 側はこれと自分の id を突き合わせるだけ。 */
export type LoraFlowTarget =
  | "trigger"
  | "genderTag"
  | "dropzone"
  | "identityConfirm"
  | "recaption"
  | "crop"
  | "repeats"
  | "submit";

export type LoraFlowState = {
  /** 光らせる対象（1つ、または選択肢として複数）。 */
  targets: LoraFlowTarget[];
  /** その場でやることの一言。対象の近くに出す。 */
  hint: string;
};

export type LoraFlowInput = {
  /** SDXL 系のジョブか（複数被写体・特徴の欄はこの時だけ出る）。 */
  isSdxlJob: boolean;
  /** 生 YAML モード（導線を出さない）。 */
  yamlMode: boolean;
  /** 送信中・学習中など、操作を受け付けない状態。 */
  busy: boolean;
  triggerFilled: boolean;
  /** 被写体のうち、性別/人数タグが未選択のものがあるか。 */
  genderTagMissing: boolean;
  imageCount: number;
  /** metadata の目視確認が必要なのに未確認。 */
  needsIdentityConfirm: boolean;
  /** キャプション解析が走っている最中。 */
  captionRunning: boolean;
  /** キャプションがまだ付いていない枚数。 */
  pendingCaptionCount: number;
  /** 診断の「要確認」（赤）の件数。 */
  diagnosticErrors: number;
  /** クロップで埋められる穴があるか。 */
  cropAvailable: boolean;
};

/**
 * 光らせる対象を決める。返すのは常に 0〜2 個。
 * 0 個（＝光らせない）になるのは、操作を受け付けない間と生 YAML モード。
 */
export function loraFlowStep(v: LoraFlowInput): LoraFlowState {
  if (v.yamlMode || v.busy) return { targets: [], hint: "" };

  // --- ここから先は「必須の未完了」を上から順に1つだけ ---
  if (!v.triggerFilled) {
    return { targets: ["trigger"], hint: "まずトリガーワードを決めます" };
  }
  if (v.isSdxlJob && v.genderTagMissing) {
    return {
      targets: ["genderTag"],
      hint: "性別/人数タグを選びます（誰を学習するかの判定に使います）",
    };
  }
  if (v.imageCount === 0) {
    return { targets: ["dropzone"], hint: "学習させたい画像を取り込みます" };
  }
  // 解析中は何も光らせない。待つしかない場面で点滅させると急かすだけ。
  if (v.captionRunning) return { targets: [], hint: "" };
  if (v.pendingCaptionCount > 0) {
    return { targets: ["recaption"], hint: "解析できなかった画像を解析し直します" };
  }
  if (v.needsIdentityConfirm) {
    return {
      targets: ["identityConfirm"],
      hint: "埋め込むタグを確認してチェックします",
    };
  }

  // --- ここから先は選択肢。両方光らせて「どちらでもよい」と伝える ---
  if (v.diagnosticErrors > 0 && v.cropAvailable) {
    return {
      targets: ["crop", "submit"],
      hint: "足りない構図を切り出すか、このまま学習へ進むか選べます",
    };
  }
  return { targets: ["repeats", "submit"], hint: "学習回数を調整するか、このまま学習へ進みます" };
}
