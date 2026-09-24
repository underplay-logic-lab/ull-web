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
  /** SDXL 系のジョブか（複数被写体・特徴の欄はこの時だけ出る）。 */
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
  /** 「解析を開始」が押されたか。押すまで抽出も解析も走らない。 */
  analysisStarted: boolean;
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
  if (v.isSdxlJob && v.genderTagMissing) {
    return {
      targets: ["genderTag"],
      hint: "性別/人数タグを選びます（誰を学習するかの判定に使います）",
    };
  }
  if (v.isSdxlJob && v.descriptionMissing) {
    return {
      targets: ["description"],
      hint: "どんな人物かを書きます（画像から特徴を抽出するときの手がかりになります）",
    };
  }
  if (v.imageCount === 0) {
    return {
      targets: v.isSdxlJob ? ["addSubject", "dropzone", "captionSpec"] : ["dropzone"],
      hint: "もう1人登録する / 画像を取り込む / キャプションの方針を変える — どれでも進めます",
    };
  }
  // 取り込みが終わったら、ユーザー自身に開始を押してもらう。タイマーでは
  // 「全部入れ終わった」を判定できず、途中で走らせると片方の被写体しか
  // 写っていないサンプルで特徴を確定してしまう（2026-09-22、ホスト指摘）。
  if (!v.analysisStarted) {
    // 小さすぎる素材があれば、解析前に超解像で差し替える選択肢も同時に光らせる
    // （2026-09-24、ホスト要望）。解析後に差し替えるとキャプションを作り直すことになる。
    if ((v.tooSmallCount ?? 0) > 0) {
      return {
        targets: ["startAnalysis", "upscaleSmall"],
        hint: "小さすぎる画像を超解像で拡大して入れ直す / このまま解析を始める — どちらでも進めます",
      };
    }
    return {
      targets: ["startAnalysis"],
      hint: "画像を全部入れ終えたら押してください（ここから解析が始まります）",
    };
  }
  // 抽出中は待つだけ。何も光らせない。
  if (v.identityRunning) return { targets: [], hint: "" };
  // ⚠️ メタデータの確認は**キャプション解析より前**（2026-09-22、ホスト提案）。
  // 特徴は「キャプションに書いてはいけない言葉」のリストなので、確認時に直すと
  // 解析済みのキャプションは全部作り直しになる。解析前に確定させれば、その
  // 作り直しが構造的に起きない。キャプション解析側もこの確認を待つ。
  if (v.needsIdentityConfirm) {
    return {
      targets: ["identityConfirm"],
      hint: "抽出した特徴を確認してください。ここを確定させてからキャプションを作ります",
    };
  }
  // 解析中は「終わったら診断を見る」とだけ伝える。ボタンは光らせない
  // （待つしかない場面で押せるものを点滅させると急かすだけ）。
  if (v.captionRunning) {
    return {
      targets: ["diagnostics"],
      hint: "画像を解析しています。終わると、この下の診断に何が足りないかが出ます",
    };
  }
  if (v.pendingCaptionCount > 0) {
    return { targets: ["recaption"], hint: "解析できなかった画像を解析し直します" };
  }
  // --- ここから先は画面の並び順に沿って進める ---
  //   クロップ → 学習回数 → （設定欄）メタデータの確認 → 実行
  //
  // ⚠️ メタデータの確認を「未解析の再解析」の直後に置いていたため、診断に赤が
  // あってもクロップが光らなかった（2026-09-22、ホスト報告）。確認欄は設定側に
  // あり、流れとしては学習回数より後。常に2箇所までに抑えるため「いまやる場所」
  // と「飛ばして次へ行く場所」の2つを出す。
  //
  // 赤があってもクロップで埋まらない軸（向き・姿勢・背景）はここへ落ちるので、
  // なぜクロップが光らないのかを文言で補う。
  // ここへ来る時点で確認は済んでいる（上で返しているため）。
  // 飛び先は実行ボタン。メタデータの確認を解析前へ移したので、設定欄に用が
  // ある人だけが「学習設定へ進む」を使えばよく、導線としては実行へ送る
  // （2026-09-22、ホスト指摘）。
  const next: LoraFlowTarget = "submit";
  const nextLabel = "次へ進む";

  if (v.diagnosticErrors > 0 && v.cropAvailable) {
    // 切り出しは「準備をする → 切り出す」の2手（2026-09-22、ホスト指摘）。
    // いきなりクロップ欄を光らせると、対象も構図も選ばれていない状態で
    // 押させることになる。まず診断側の準備ボタンへ送る。
    return v.cropPrepared
      ? { targets: ["crop"], hint: `切り出しを実行する（対象と構図はセット済み）` }
      : {
          targets: ["cropPrepare", next],
          hint: `足りない構図を切り出す準備をする ／ ${nextLabel}`,
        };
  }
  // 「構図の偏りを均す回数を自動で入れる」を名指しで光らせる。パネル全体だと
  // この操作を見逃す（2026-09-22、ホスト指摘）。
  return {
    targets: ["suggestRepeats", next],
    hint:
      (v.diagnosticErrors > 0
        ? "診断の指摘は切り出しでは埋まりません。構図の偏りを学習回数で均す"
        : "構図の偏りを学習回数で均す") + ` ／ ${nextLabel}`,
  };
}
