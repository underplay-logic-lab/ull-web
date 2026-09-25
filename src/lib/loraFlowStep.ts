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
  | "baseModel"
  | "loraName"
  | "trigger"
  | "genderTag"
  | "description"
  | "addSubject"
  | "captionSpec"
  | "dropzone"
  | "startAnalysis"
  | "startCaption"
  | "upscaleSmall"
  | "diagnostics"
  | "identityConfirm"
  | "recaption"
  | "cropPrepare"
  | "crop"
  | "suggestRepeats"
  | "goToSettings"
  | "submit";

export type LoraFlowState = {
  /** 光らせる対象（1つ、または選択肢として複数）。 */
  targets: LoraFlowTarget[];
  /** その場でやることの一言。対象の近くに出す。 */
  hint: string;
};

export type LoraFlowInput = {
  /** SDXL 系のジョブか（2026-09-25 から導線の分岐には使っていない。人物の欄は全モデル共通）。 */
  isSdxlJob: boolean;
  /** 生 YAML モード（導線を出さない）。 */
  yamlMode: boolean;
  /** 送信中・学習中など、操作を受け付けない状態。 */
  busy: boolean;
  /**
   * ベースモデルの選択欄を一度でも触ったか。
   *
   * ベースモデルは常に既定値が入っているので「未選択」を状態から検出できない。
   * ここだけは「触ったか」のフラグを持つ（2026-09-22）。false -> true にしか
   * 動かず、光らせる位置以外には何も影響しないので、戻る操作でズレる心配は
   * 無い。これが無いと LoRA 名が光る場面が存在しなくなる。
   */
  baseModelTouched: boolean;
  /** LoRA 名が入っているか。 */
  loraNameFilled: boolean;
  /** 短辺が足りない（超解像へ誘導する）画像の枚数。解析開始と同時に光らせる（2026-09-24）。 */
  tooSmallCount?: number;
  triggerFilled: boolean;
  /** 被写体のうち、性別/人数タグが未選択のものがあるか。 */
  genderTagMissing: boolean;
  /** 被写体のうち、「どんな人物か」が未記入のものがあるか。 */
  descriptionMissing: boolean;
  imageCount: number;
  /** 「取り込み完了」が押されたか。押すまで特徴の抽出も構図の判定も走らない。 */
  analysisStarted: boolean;
  /** 構図の判定（WD タガー・無料）が走っている最中（2026-09-25）。 */
  compositionRunning: boolean;
  /** 構図がまだ判定できていない枚数（判定が止まっているときだけ意味がある）。 */
  untaggedCount: number;
  /** キャプションを AI に作らせるか、自分で書くか（2026-09-25）。 */
  captionSource: "ai" | "manual";
  /** 「LoRA に最適化したキャプションを作成」が押されたか。 */
  captionStarted: boolean;
  /** metadata の目視確認が必要なのに未確認。 */
  needsIdentityConfirm: boolean;
  /** 特徴の抽出が走っている最中。 */
  identityRunning: boolean;
  /** キャプション解析が走っている最中。 */
  captionRunning: boolean;
  /** キャプションがまだ付いていない枚数。 */
  pendingCaptionCount: number;
  /** 診断の「要確認」（赤）の件数。 */
  diagnosticErrors: number;
  /** クロップで埋められる穴があるか。 */
  cropAvailable: boolean;
  /** 診断の「◯◯ の…を切り出す準備をする」を押して対象が選ばれているか。 */
  cropPrepared: boolean;
};

/**
 * 光らせる対象を決める。返すのは常に 0〜2 個。
 * 0 個（＝光らせない）になるのは、操作を受け付けない間と生 YAML モード。
 */
export function loraFlowStep(v: LoraFlowInput): LoraFlowState {
  if (v.yamlMode || v.busy) return { targets: [], hint: "" };

  // --- ここから先は「必須の未完了」を上から順に1つだけ ---
  // ベースモデルは常に既定値が入っているので「未選択」を検出できない。
  // 名前もトリガーも空＝まだ何も始めていない状態を、最初の一歩とみなす
  // （2026-09-22、ホスト指摘「最初に光るべきはベースモデル」）。
  if (!v.baseModelTouched && !v.loraNameFilled && !v.triggerFilled) {
    return {
      targets: ["baseModel"],
      hint: "どのモデル向けの LoRA を作るか選びます（ここで下の項目の構成が変わります）",
    };
  }
  if (!v.loraNameFilled) {
    return { targets: ["loraName"], hint: "LoRA の名前を決めます" };
  }
  if (!v.triggerFilled) {
    return { targets: ["trigger"], hint: "呼び出すためのトリガーワードを決めます" };
  }
  // 性別/人数・人物の説明は全モデル共通（2026-09-25。以前は SDXL だけだった）。
  if (v.genderTagMissing) {
    return {
      targets: ["genderTag"],
      hint: "性別/人数タグを選びます（誰を学習するかの判定に使います）",
    };
  }
  if (v.descriptionMissing) {
    return {
      targets: ["description"],
      hint: "どんな人物かを書きます（画像から特徴を抽出するときの手がかりになります）",
    };
  }
  if (v.imageCount === 0) {
    return {
      targets: ["addSubject", "dropzone", "captionSpec"],
      hint: "もう1人登録する / 画像を取り込む / キャプションの方針を変える — どれでも進めます",
    };
  }
  // 取り込みが終わったら、ユーザー自身に開始を押してもらう。タイマーでは
  // 「全部入れ終わった」を判定できず、途中で走らせると片方の被写体しか
  // 写っていないサンプルで特徴を確定してしまう（2026-09-22、ホスト指摘）。
  if (!v.analysisStarted) {
    // 小さすぎる素材があれば、解析前に超解像で差し替える選択肢も同時に光らせる
    // （2026-09-24、ホスト要望）。後から差し替えると診断・キャプションをやり直すことになる。
    if ((v.tooSmallCount ?? 0) > 0) {
      return {
        targets: ["startAnalysis", "upscaleSmall"],
        hint: "小さすぎる画像を超解像で拡大して入れ直す / このまま診断へ進む — どちらでも進めます",
      };
    }
    return {
      targets: ["startAnalysis"],
      hint: "画像を全部入れ終えたら押してください（特徴の抽出と構図の診断が始まります・無料）",
    };
  }
  // 抽出中は待つだけ。何も光らせない。
  if (v.identityRunning) return { targets: [], hint: "" };
  // 特徴の確認はキャプションより前（2026-09-22、ホスト提案）。特徴は「キャプションに書いてはいけない言葉」の
  // リストなので、キャプション後に直すと全部作り直しになる。
  if (v.needsIdentityConfirm) {
    return {
      targets: ["identityConfirm"],
      hint: "抽出した特徴を確認してください。ここを確定させてから構図の診断へ進みます",
    };
  }
  // 構図の判定中は待つだけ（数十秒）。ボタンは光らせない。
  if (v.compositionRunning) {
    return {
      targets: ["diagnostics"],
      hint: "構図を判定しています。終わると、この下の診断に何が足りないかが出ます",
    };
  }
  if (v.untaggedCount > 0) {
    return { targets: ["diagnostics"], hint: "構図を判定できなかった画像を判定し直します（無料）" };
  }
  // --- ここから先は画面の並び順に沿って進める（2026-09-25 の順番の改修）---
  //   診断 → クロップ → キャプション（有料・AI のときだけ）→ 学習回数 → 実行（キュレーション）
  // キャプションは切り出した画像も含めて 1 回で作るので、クロップより後。学習回数は被写体ごとの比率を
  // キャプションで決めるので、キャプションより後。
  const captionPending = v.captionSource === "ai" && (!v.captionStarted || v.pendingCaptionCount > 0);
  if (v.captionRunning) return { targets: [], hint: "" };
  const afterCrop: LoraFlowTarget = captionPending
    ? v.captionStarted
      ? "recaption"
      : "startCaption"
    : "suggestRepeats";
  const afterCropLabel = captionPending
    ? v.captionStarted
      ? "作れなかったキャプションを作り直す"
      : "キャプションを作る"
    : "学習回数へ進む";

  if (v.diagnosticErrors > 0 && v.cropAvailable) {
    // 切り出しは「準備をする → 切り出す」の2手（2026-09-22、ホスト指摘）。
    // いきなりクロップ欄を光らせると、対象も構図も選ばれていない状態で
    // 押させることになる。まず診断側の準備ボタンへ送る。
    return v.cropPrepared
      ? { targets: ["crop"], hint: `切り出しを実行する（対象と構図はセット済み）` }
      : {
          targets: ["cropPrepare", afterCrop],
          hint: `足りない構図を切り出す準備をする ／ ${afterCropLabel}`,
        };
  }
  if (captionPending) {
    return {
      targets: [afterCrop],
      hint: v.captionStarted
        ? "作れなかった画像のキャプションを作り直します"
        : "切り出しまで済んだら、LoRA に最適化したキャプションを作ります（有料）",
    };
  }
  // 「構図の偏りを均す回数を自動で入れる」を名指しで光らせる。パネル全体だと
  // この操作を見逃す（2026-09-22、ホスト指摘）。飛び先は実行ボタン。
  return {
    targets: ["suggestRepeats", "submit"],
    hint:
      (v.diagnosticErrors > 0
        ? "診断の指摘は切り出しでは埋まりません。構図の偏りを学習回数で均す"
        : "構図の偏りを学習回数で均す") + " ／ 次へ進む",
  };
}
