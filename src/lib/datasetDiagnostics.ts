// データセット構成の自動診断（2026-09-21）。
//
// 背景: ホスト自身の実案件で「男性キャラだけ再現性が低い」が長く続き、学習回数を
// ×20 まで上げても直らなかった。実データをキャプションから集計したところ、
// 原因は露出比（既に 89% で最優遇）ではなく **構図の偏り** だった:
//   - kocho の upper body が 4枚（hitozuma は 23枚）= 顔が判別できる中距離が無い
//   - 背景が全 113枚とも「無地」= 屋内も屋外も 0枚
//   - 姿勢が「立ち」のみ = 座り 0枚 / 寝 0枚
// どれも学習回数では直らない。**焼く前にこれを出せれば防げた**、というのが
// この機能の動機（ホスト: 「全然焼けないじゃないかというクレームを防ぐため」）。
//
// 入力はキャプション（既に生成済みの Danbooru タグ列）だけ。新しいモデルも
// GPU も要らず、ブラウザ内で完結する。
//
// ⚠️ この集計は **キャプションの語彙に依存する**。VLM が "upper body" ではなく
// "medium shot" と書けば分類から漏れるので、`unclassified` を必ず一緒に出して
// 指標を鵜呑みにさせないこと。

import { matchLeadingSubjectTriggers, type LoraSubject } from "@/lib/loraCaptionSpec";

export type DiagnosticAxis = "distance" | "view" | "elevation" | "pose" | "background";

type AxisDef = {
  label: string;
  /** 表示順を持たせたいのでオブジェクトではなく配列で持つ。 */
  buckets: { id: string; label: string; keywords: string[] }[];
};

// Danbooru の定番タグ。部分一致で拾う（"full body shot" も "full body" で当たる）。
export const DIAGNOSTIC_AXES: Record<DiagnosticAxis, AxisDef> = {
  distance: {
    label: "距離",
    buckets: [
      { id: "closeup", label: "顔アップ", keywords: ["close-up", "closeup", "face shot", "portrait", "head shot"] },
      { id: "bust", label: "バスト", keywords: ["bust shot", "bust", "chest up"] },
      { id: "upper", label: "上半身", keywords: ["upper body", "half body", "waist up", "medium shot"] },
      { id: "full", label: "全身", keywords: ["full body", "full-body", "cowboy shot", "knee up"] },
    ],
  },
  view: {
    label: "向き",
    buckets: [
      { id: "front", label: "正面", keywords: ["front view", "facing viewer", "looking at viewer", "from front"] },
      { id: "side", label: "斜め・横", keywords: ["three quarter", "3/4", "from the side", "side view", "profile"] },
      { id: "back", label: "後ろ", keywords: ["from behind", "back view", "rear view", "from back"] },
    ],
  },
  // 仰角。Multi-Angle Studio の ELEVATION_OPTIONS（アオリ/水平/やや俯瞰/フカン）
  // と対応させてある。ここが1種類しか無いと「常に目線の高さ」でしか出せない。
  elevation: {
    label: "仰角",
    buckets: [
      { id: "low", label: "アオリ", keywords: ["low angle", "from below", "worms eye", "worm's eye"] },
      { id: "eye", label: "水平", keywords: ["eye level", "eye-level", "straight on"] },
      { id: "high", label: "俯瞰", keywords: ["high angle", "from above", "overhead", "birds eye", "bird's eye", "top-down"] },
    ],
  },
  pose: {
    label: "姿勢",
    buckets: [
      { id: "standing", label: "立ち", keywords: ["standing", "walking", "running"] },
      { id: "sitting", label: "座り", keywords: ["sitting", "kneeling", "squatting", "crouching"] },
      { id: "lying", label: "寝", keywords: ["lying", "on back", "on stomach", "reclining"] },
    ],
  },
  background: {
    label: "背景",
    buckets: [
      {
        id: "plain",
        label: "無地",
        keywords: ["plain", "simple background", "white background", "black background", "grey background", "gray background", "solid background"],
      },
      { id: "indoor", label: "屋内", keywords: ["indoors", "bedroom", "classroom", "room", "restaurant", "cafe", "office", "kitchen", "bathroom"] },
      { id: "outdoor", label: "屋外", keywords: ["outdoors", "street", "park", "forest", "beach", "grass", "city", "sky", "garden"] },
    ],
  },
};

// ⚠️ ここは **未校正の出発点** であって実測値ではない（CLAUDE.md §0）。
// 「0枚・1枚」という構造的な欠落は仮値なしで断定できるので、まずそこを主役に
// する。数値目標の方は実ジョブの結果が溜まってから校正すること。
export const DIAGNOSTIC_TARGETS = {
  /** 1被写体あたりのユニーク枚数の下限。これを割ると何をしても厳しい。 */
  minUniquePerSubject: 15,
  /** 距離バケットごとの目安枚数。 */
  distance: { closeup: 3, bust: 4, upper: 4, full: 5 } as Record<string, number>,
  /** 露出比がこの倍率以上離れたら偏りとみなす。 */
  exposureImbalanceRatio: 2.5,
  /**
   * 被写体間で同じバケットの枚数がこの倍率以上離れたら偏りとみなす。
   *
   * 実データで一番効いたのはこのルール。ホストの案件では kocho の「上半身」が
   * 4枚に対し hitozuma は 23枚で、**絶対値の目安（4枚）は満たしているのに
   * 相手の1/6しか無い**状態だった。絶対値の閾値では検出できず、ここでしか
   * 拾えない（実際「男性だけ再現性が低い」の本命がこれ）。
   */
  bucketImbalanceRatio: 3,
  /** 相手側がこの枚数以上あるときだけ比較する（1枚 vs 4枚で騒がないため）。 */
  bucketImbalanceMinPeer: 8,
  /**
   * 1つのバケットが軸全体に占める割合がこれを超えたら「偏りすぎ」とみなす
   * （2026-09-21、ホスト指摘「足りない分は注意するけど、多いとは言わない」）。
   *
   * 不足と違い、**これは学習回数で直せる**（多い側を ×1 のまま、少ない側を
   * 上げる／多い側の比率を下げる）ので notFixableByRepeats=false で出す。
   * 0.7 という値は未校正。1軸が7割を超えると生成時にそこから外れた構図で
   * 崩れやすい、という一般論からの出発点でしかない。
   */
  bucketDominanceRatio: 0.7,
  /** 支配率を見る前に必要な、その軸で分類できた最低枚数。 */
  bucketDominanceMinClassified: 10,
};

export type SubjectDiagnostic = {
  trigger: string;
  /** その被写体が写っている画像の枚数（duo なら両方に計上）。 */
  unique: number;
  /** 枚数 × 学習回数。データセット内での実効的な露出量。 */
  exposure: number;
  /** 軸 -> バケットid -> 枚数 */
  axes: Record<DiagnosticAxis, Record<string, number>>;
  /** どの軸のバケットにも当たらなかった枚数（軸ごと）。 */
  unclassified: Record<DiagnosticAxis, number>;
};

export type DiagnosticIssue = {
  /** error = ほぼ確実に学習に影響する構造的欠落 / warn = 目安を下回る */
  level: "error" | "warn";
  subject: string | null;
  message: string;
  /** 学習回数を増やしても解決しない種類か（＝素材を足すしかない）。 */
  notFixableByRepeats: boolean;
  /**
   * 製品内で作れる出口があるか（2026-09-21、ホスト指摘「用意してくれと言う
   * だけでなく、これを使って用意しろという出口を用意したい」）。
   *
   * "multi_angle" = Multi-Angle Studio で生成できる。あちらはカメラを動かす
   * もので、方位角8方向 / 仰角4段 / 距離3段（顔アップ・バストアップ・全身）を
   * 揃えられる＝診断の 距離 / 向き / 仰角 の3軸と1:1で対応する。
   *
   * "smart_crop" = 手持ちの画像から切り出せる。距離軸だけは**寄せる方向**に
   * 限り無料・即時で作れるので、クレジットを使う Multi-Angle より優先する。
   * 逆方向（顔アップしか無い被写体の全身）は切り出しでは作れないので、
   * その場合は "multi_angle" に倒す。
   *
   * null = 製品内に作る手段が無い（姿勢・背景）。**作れないものを 🔴 で
   * 突きつけない** — 指摘のレベルも warn に落とす。
   */
  fixableWith: "multi_angle" | "smart_crop" | null;
  /** smart_crop のとき、どの構図で切り出せば埋まるか（UI の初期選択に使う）。 */
  cropKinds?: ("face" | "upper")[];
};

export type DatasetDiagnostic = {
  totalImages: number;
  totalExposure: number;
  /** キャプションが空 / 被写体が特定できなかった枚数。 */
  uncaptioned: number;
  subjects: SubjectDiagnostic[];
  issues: DiagnosticIssue[];
};

export type DiagnosticInput = {
  caption: string;
  /** 学習回数（既定1）。 */
  repeats?: number;
};

function splitTags(caption: string): string[] {
  return caption
    .toLowerCase()
    .split(/[,、\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function emptyAxes(): Record<DiagnosticAxis, Record<string, number>> {
  return {
    distance: {},
    view: {},
    elevation: {},
    pose: {},
    background: {},
  };
}

/**
 * キャプションが指定軸のどのバケットに当たるかを返す（0個・複数個あり）。
 * 診断と同じ判定を UI の一括選択チップから使い回すために公開する
 * （2026-09-21）。判定がズレると「診断で全身が多いと言われた」のに
 * 「全身チップで選べない」という食い違いが起きるので、必ず同じ関数を通す。
 */
export function captionBuckets(caption: string, axis: DiagnosticAxis): string[] {
  const tags = splitTags(caption);
  return DIAGNOSTIC_AXES[axis].buckets
    .filter((b) => tags.some((t) => b.keywords.some((k) => t.includes(k))))
    .map((b) => b.id);
}

/**
 * 構図（距離）の偏りを均す学習回数を提案する（2026-09-21、ホスト指摘
 * 「どれだけ増やせば良いのかがわかりにくい」）。
 *
 * 考え方はこれだけ:
 *   被写体ごとに距離バケットの枚数を数え、**一番多いバケットに合わせる**
 *   回数を割り当てる（少ないバケットほど回数を上げる）。
 *
 * ただし上限を設ける。4枚を25枚に合わせようとすると ×6 になるが、同じ4枚を
 * 6回見せても情報は増えず、その4枚の背景・ポーズまで焼き込む方向にしか
 * 働かない。`cap` はそのための足枷で、既定 4 は「×4 を超える重み付けは
 * 素材不足の先送りでしかない」という判断からの出発点（未校正）。
 *
 * 1枚が複数のバケット／被写体に該当することがある（duo の全身など）。
 * その場合は**大きい方**を採る — 足りないバケットを埋めるのが目的なので。
 *
 * ⚠️ これは**被写体間の比率までは触らない**。距離の偏りだけを均すので、
 * 結果として被写体ごとの総露出は動く。Illustrious の男性バイアス
 * （docs/STATUS.md）のように意図して比率を傾けている場合は、適用後に
 * 露出の数字を必ず確認すること。
 */
export function suggestRepeats(
  items: DiagnosticInput[],
  subjects: LoraSubject[],
  cap = 4,
): number[] {
  // 1パス目: 被写体ごと・バケットごとの枚数を数える。
  const counts = new Map<string, Map<string, number>>();
  const perItem = items.map((item) => {
    const caption = (item.caption ?? "").trim();
    if (!caption) return null;
    const present = matchLeadingSubjectTriggers(caption, subjects);
    const targets =
      present.length > 0
        ? present.map((x) => x.trigger.trim())
        : [subjects[0]?.trigger.trim() || "（この LoRA）"];
    const buckets = captionBuckets(caption, "distance");
    for (const t of targets) {
      let m = counts.get(t);
      if (!m) counts.set(t, (m = new Map()));
      for (const b of buckets) m.set(b, (m.get(b) ?? 0) + 1);
    }
    return { targets, buckets };
  });

  // 2パス目: 各被写体の最大バケットへ合わせる回数を割り当てる。
  return perItem.map((info) => {
    if (!info || info.buckets.length === 0) return 1;
    let best = 1;
    for (const t of info.targets) {
      const m = counts.get(t);
      if (!m || m.size === 0) continue;
      const peak = Math.max(...m.values());
      for (const b of info.buckets) {
        const n = m.get(b) ?? 0;
        if (n <= 0) continue;
        best = Math.max(best, Math.min(cap, Math.max(1, Math.round(peak / n))));
      }
    }
    return best;
  });
}

export function analyzeDataset(
  items: DiagnosticInput[],
  subjects: LoraSubject[],
): DatasetDiagnostic {
  const bySubject = new Map<string, SubjectDiagnostic>();
  let totalExposure = 0;
  let uncaptioned = 0;

  const ensure = (trigger: string): SubjectDiagnostic => {
    let d = bySubject.get(trigger);
    if (!d) {
      d = {
        trigger,
        unique: 0,
        exposure: 0,
        axes: emptyAxes(),
        unclassified: { distance: 0, view: 0, elevation: 0, pose: 0, background: 0 },
      };
      bySubject.set(trigger, d);
    }
    return d;
  };

  for (const item of items) {
    const caption = (item.caption ?? "").trim();
    const repeats = Math.max(1, Math.round(item.repeats ?? 1));
    totalExposure += repeats;
    if (!caption) {
      uncaptioned += 1;
      continue;
    }
    const present = matchLeadingSubjectTriggers(caption, subjects);
    // 被写体が登録されていない（単独 LoRA）場合は1つの塊として扱う。
    const targets =
      present.length > 0
        ? present.map((s) => s.trigger.trim())
        : [subjects[0]?.trigger.trim() || "（この LoRA）"];
    if (present.length === 0 && subjects.length > 1) uncaptioned += 1;

    const tags = splitTags(caption);
    for (const trigger of targets) {
      const d = ensure(trigger);
      d.unique += 1;
      d.exposure += repeats;
      for (const axis of Object.keys(DIAGNOSTIC_AXES) as DiagnosticAxis[]) {
        let hit = false;
        for (const bucket of DIAGNOSTIC_AXES[axis].buckets) {
          if (tags.some((t) => bucket.keywords.some((k) => t.includes(k)))) {
            d.axes[axis][bucket.id] = (d.axes[axis][bucket.id] ?? 0) + 1;
            hit = true;
          }
        }
        if (!hit) d.unclassified[axis] += 1;
      }
    }
  }

  const list = [...bySubject.values()].sort((a, b) => b.exposure - a.exposure);
  return {
    totalImages: items.length,
    totalExposure,
    uncaptioned,
    subjects: list,
    issues: buildIssues(list),
  };
}

// Multi-Angle Studio が担当できる軸。ここに無い軸（姿勢・背景）は製品内に
// 作る手段が無いので、指摘は参考情報（warn）に留める。
const MULTI_ANGLE_AXES: DiagnosticAxis[] = ["distance", "view", "elevation"];

/**
 * スマートクロップが実際に作れる距離バケットだけを smart_crop 扱いにする
 * （2026-09-22）。クロッパーの出力は 顔 / 上半身 / 全身 の3種で、
 * **「バスト」に対応する出力は無い**。また「全身」は元画像より引いた画が
 * 必要なので作れない。よって埋められるのは closeup と upper だけ。
 * さらに、その被写体に**より引いた画の在庫**が無ければ切り出しようがない。
 */
const CROPPABLE_DISTANCE: Record<string, "face" | "upper"> = {
  closeup: "face",
  upper: "upper",
};
const DISTANCE_ORDER = ["closeup", "bust", "upper", "full"];

function canCrop(bucketId: string, axes: Record<string, number>): "face" | "upper" | null {
  const kind = CROPPABLE_DISTANCE[bucketId];
  if (!kind) return null;
  const idx = DISTANCE_ORDER.indexOf(bucketId);
  const wider = DISTANCE_ORDER.slice(idx + 1).reduce((n, b) => n + (axes[b] ?? 0), 0);
  return wider > 0 ? kind : null;
}

function distanceFix(
  bucketId: string,
  axes: Record<string, number>,
): { fixableWith: "smart_crop" | "multi_angle"; cropKinds?: ("face" | "upper")[] } {
  const kind = canCrop(bucketId, axes);
  return kind ? { fixableWith: "smart_crop", cropKinds: [kind] } : { fixableWith: "multi_angle" };
}

function buildIssues(subjects: SubjectDiagnostic[]): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  if (subjects.length === 0) return issues;

  for (const s of subjects) {
    // --- 構造的な欠落（仮値に依存しないので断定できる）---
    for (const axis of ["view", "elevation", "pose", "background"] as DiagnosticAxis[]) {
      const buckets = DIAGNOSTIC_AXES[axis].buckets;
      const covered = buckets.filter((b) => (s.axes[axis][b.id] ?? 0) > 0);
      // 分類できた枚数が薄いのに「◯◯だけ」と断定しない。仰角はキャプションに
      // 書かれないことが多く、66枚中65枚が未分類なのに「水平だけ」と言い切る
      // 誤検出が実データで出た（2026-09-21）。
      const classified = s.unique - s.unclassified[axis];
      const enough = classified >= Math.max(5, Math.round(s.unique * 0.3));
      if (covered.length === 1 && s.unique >= 5 && enough) {
        const fixable = MULTI_ANGLE_AXES.includes(axis);
        const missing = buckets
          .filter((b) => (s.axes[axis][b.id] ?? 0) === 0)
          .map((b) => b.label)
          .join("・");
        issues.push({
          // 製品内に作る手段が無い軸（姿勢・背景）は参考情報に留める。
          // 作れないものを 🔴 で突きつけない（ホスト指摘）。
          level: fixable ? "error" : "warn",
          subject: s.trigger,
          message: `${DIAGNOSTIC_AXES[axis].label}が「${covered[0].label}」だけです（${missing}が0枚）。生成時にその条件から外れると崩れやすくなります。${
            fixable ? "" : "（用途によっては問題ありません）"
          }`,
          notFixableByRepeats: true,
          fixableWith: fixable ? "multi_angle" : null,
        });
      }
    }

    // --- 距離の穴（目安に依存する warn）---
    // distance.buckets は寄り → 引き の順に並んでいる。切り出しは「引き画を
    // 寄せる」ことしかできないので、自分より後ろ（広い）バケットに在庫が
    // あるときだけ smart_crop を出口にする。
    for (const b of DIAGNOSTIC_AXES.distance.buckets) {
      const got = s.axes.distance[b.id] ?? 0;
      const want = DIAGNOSTIC_TARGETS.distance[b.id] ?? 0;
      if (want <= 0 || got >= want) continue;
      const fix = distanceFix(b.id, s.axes.distance);
      issues.push({
        level: got === 0 ? "error" : "warn",
        subject: s.trigger,
        message: `「${b.label}」が ${got}枚です（目安 ${want}枚）。${
          got === 0 ? "この距離では生成できません。" : ""
        }${fix.fixableWith === "smart_crop" ? "より引いた画から、スマートクロップで作れます。" : ""}`,
        notFixableByRepeats: true,
        ...fix,
      });
    }

    if (s.unique < DIAGNOSTIC_TARGETS.minUniquePerSubject) {
      issues.push({
        level: "warn",
        subject: s.trigger,
        message: `ユニーク ${s.unique}枚 は少なめです（目安 ${DIAGNOSTIC_TARGETS.minUniquePerSubject}枚以上）。学習回数を増やしても同じ絵を繰り返すだけで、情報量は増えません。`,
        notFixableByRepeats: true,
        fixableWith: "multi_angle",
      });
    }

    // --- 1つの構図に偏りすぎ（不足ではなく「多すぎ」側）-----------------
    // 不足しか言わないと「全身ばかり80枚」のような構成を素通りさせてしまう。
    for (const axis of Object.keys(DIAGNOSTIC_AXES) as DiagnosticAxis[]) {
      const counts = DIAGNOSTIC_AXES[axis].buckets.map((b) => ({ b, n: s.axes[axis][b.id] ?? 0 }));
      const classified = counts.reduce((t, c) => t + c.n, 0);
      if (classified < DIAGNOSTIC_TARGETS.bucketDominanceMinClassified) continue;
      const top = counts.reduce((a, c) => (c.n > a.n ? c : a), counts[0]);
      const share = top.n / classified;
      if (share < DIAGNOSTIC_TARGETS.bucketDominanceRatio) continue;
      // 他のバケットが全部0なら「1つだけ」の指摘と重複するので出さない。
      if (counts.filter((c) => c.n > 0).length <= 1) continue;
      // 距離軸なら、薄いほうの構図を**引き画から切り出して実際に増やせる**
      // （2026-09-22、ホスト指摘「全身に偏っているという指摘だけ出て、
      // crop ボタンが出てこない」）。学習回数での調整もできるが、実物が
      // 増えるほうが常に上位なので両方を案内する。
      const thin =
        axis === "distance"
          ? (Object.keys(CROPPABLE_DISTANCE) as string[])
              .filter((b) => (s.axes.distance[b] ?? 0) < top.n / 2)
              .map((b) => canCrop(b, s.axes.distance))
              .filter((k): k is "face" | "upper" => Boolean(k))
          : [];
      const uniqThin = [...new Set(thin)];
      issues.push({
        level: "warn",
        subject: s.trigger,
        message:
          `${DIAGNOSTIC_AXES[axis].label}が「${top.b.label}」に偏っています（${top.n}枚 / 分類できた ${classified}枚 の ${Math.round(share * 100)}%）。この構図以外での再現性が落ちます。` +
          (uniqThin.length
            ? "薄いほうの構図は、引いた画からスマートクロップで増やせます。学習回数での調整も併用できます。"
            : "多い側の学習回数を上げない、または少ない側を上げて比率を整えてください。"),
        notFixableByRepeats: false,
        fixableWith: uniqThin.length ? "smart_crop" : null,
        ...(uniqThin.length ? { cropKinds: uniqThin } : {}),
      });
    }
  }

  // --- 被写体間の「構図カバレッジ」の偏り -----------------------------------
  // 絶対値の目安を満たしていても、相手より極端に少ないバケットは実務で効く
  // （DIAGNOSTIC_TARGETS.bucketImbalanceRatio のコメント参照）。
  if (subjects.length >= 2) {
    for (const axis of Object.keys(DIAGNOSTIC_AXES) as DiagnosticAxis[]) {
      for (const bucket of DIAGNOSTIC_AXES[axis].buckets) {
        const counts = subjects.map((s) => ({ s, n: s.axes[axis][bucket.id] ?? 0 }));
        const peak = Math.max(...counts.map((c) => c.n));
        if (peak < DIAGNOSTIC_TARGETS.bucketImbalanceMinPeer) continue;
        for (const { s, n } of counts) {
          if (n === 0) continue; // 0枚は上の構造的欠落側で拾う
          if (peak / n < DIAGNOSTIC_TARGETS.bucketImbalanceRatio) continue;
          const richer = counts.find((c) => c.n === peak)!.s.trigger;
          // 距離軸の不足は、より引いた画が在庫にあればクロップで埋まる
          // （2026-09-22）。以前は一律でマルチアングルへ誘導しており、
          // 無料・即時で作れるものにクレジットを使わせる案内になっていた。
          const fix: { fixableWith: DiagnosticIssue["fixableWith"]; cropKinds?: ("face" | "upper")[] } =
            axis === "distance"
              ? distanceFix(bucket.id, s.axes.distance)
              : { fixableWith: MULTI_ANGLE_AXES.includes(axis) ? "multi_angle" : null };
          issues.push({
            level: MULTI_ANGLE_AXES.includes(axis) ? "error" : "warn",
            subject: s.trigger,
            message:
              `${DIAGNOSTIC_AXES[axis].label}の「${bucket.label}」が ${n}枚しかありません（${richer} は ${peak}枚）。この構図では ${richer} に比べて明らかに弱くなります。` +
              (fix.fixableWith === "smart_crop" ? "より引いた画から、スマートクロップで作れます。" : ""),
            notFixableByRepeats: true,
            ...fix,
          });
        }
      }
    }
  }

  // --- 被写体間の露出の偏り（repeats で直せる唯一の項目）---
  if (subjects.length >= 2) {
    const top = subjects[0];
    const bottom = subjects[subjects.length - 1];
    if (bottom.exposure > 0 && top.exposure / bottom.exposure >= DIAGNOSTIC_TARGETS.exposureImbalanceRatio) {
      issues.push({
        level: "warn",
        subject: null,
        message: `露出量が ${top.trigger} と ${bottom.trigger} で ${(top.exposure / bottom.exposure).toFixed(1)}倍 違います。学習回数で調整できます。`,
        notFixableByRepeats: false,
        fixableWith: null,
      });
    }
  }

  return issues;
}
