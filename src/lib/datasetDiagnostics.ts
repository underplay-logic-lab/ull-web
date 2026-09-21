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

export type DiagnosticAxis = "distance" | "view" | "pose" | "background";

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
    pose: {},
    background: {},
  };
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
        unclassified: { distance: 0, view: 0, pose: 0, background: 0 },
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

function buildIssues(subjects: SubjectDiagnostic[]): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  if (subjects.length === 0) return issues;

  for (const s of subjects) {
    // --- 構造的な欠落（仮値に依存しないので断定できる）---
    for (const axis of ["view", "pose", "background"] as DiagnosticAxis[]) {
      const buckets = DIAGNOSTIC_AXES[axis].buckets;
      const covered = buckets.filter((b) => (s.axes[axis][b.id] ?? 0) > 0);
      if (covered.length === 1 && s.unique >= 5) {
        issues.push({
          level: "error",
          subject: s.trigger,
          message: `${DIAGNOSTIC_AXES[axis].label}が「${covered[0].label}」だけです（${
            buckets
              .filter((b) => (s.axes[axis][b.id] ?? 0) === 0)
              .map((b) => b.label)
              .join("・")
          }が0枚）。生成時にその条件から外れると崩れやすくなります。`,
          notFixableByRepeats: true,
        });
      }
    }

    // --- 距離の穴（目安に依存する warn）---
    for (const b of DIAGNOSTIC_AXES.distance.buckets) {
      const got = s.axes.distance[b.id] ?? 0;
      const want = DIAGNOSTIC_TARGETS.distance[b.id] ?? 0;
      if (want > 0 && got < want) {
        issues.push({
          level: got === 0 ? "error" : "warn",
          subject: s.trigger,
          message: `「${b.label}」が ${got}枚です（目安 ${want}枚）。${
            got === 0 ? "この距離では生成できません。" : ""
          }`,
          notFixableByRepeats: true,
        });
      }
    }

    if (s.unique < DIAGNOSTIC_TARGETS.minUniquePerSubject) {
      issues.push({
        level: "warn",
        subject: s.trigger,
        message: `ユニーク ${s.unique}枚 は少なめです（目安 ${DIAGNOSTIC_TARGETS.minUniquePerSubject}枚以上）。学習回数を増やしても同じ絵を繰り返すだけで、情報量は増えません。`,
        notFixableByRepeats: true,
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
          issues.push({
            level: "error",
            subject: s.trigger,
            message: `${DIAGNOSTIC_AXES[axis].label}の「${bucket.label}」が ${n}枚しかありません（${richer} は ${peak}枚）。この構図では ${richer} に比べて明らかに弱くなります。`,
            notFixableByRepeats: true,
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
      });
    }
  }

  return issues;
}
