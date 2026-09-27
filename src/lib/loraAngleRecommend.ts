// LoRA Studio → マルチアングルで、診断の「足りない構図」から初期の選択を組み立てる（2026-09-27、ホスト要望）。
// 決め打ちのプリセットだと素材ごとの不足に合わない（kch3 は上半身が足りない、別の素材は後ろ姿が足りない等）。
// 距離の対応は 2026-09-27 の実測（docs/STATUS.md）: close-up＝全身の元→腰から上・バストの元→胸から上、
// wide＝全身、距離の語なし＝元の距離のまま向きだけ変わる。

import type { AngleSelection } from "@/lib/angleStudio";
import { DIAGNOSTIC_TARGETS, WHOLE_DATASET_SUBJECT, type DatasetDiagnostic } from "@/lib/datasetDiagnostics";

// 向きは「分類できた枚数に対してこの割合より少ない」を不足とする（未校正の出発点）。
const VIEW_MIN_SHARE = 0.15;

export type AngleRecommendation = { selection: AngleSelection; reason: string };

export function recommendAngleSelection(diag: DatasetDiagnostic): AngleRecommendation | null {
  const real = diag.subjects.filter((s) => s.trigger !== WHOLE_DATASET_SUBJECT && s.unique > 0);
  const subjects = real.length > 0 ? real : diag.subjects.filter((s) => s.unique > 0);
  if (subjects.length === 0) return null;

  const lackDist = new Set<"closeup" | "upper" | "full">();
  const lackView = new Set<"front" | "side" | "back">();
  for (const s of subjects) {
    const d = s.axes.distance;
    const total = (d.closeup ?? 0) + (d.upper ?? 0) + (d.full ?? 0);
    if (total > 0) {
      for (const id of ["closeup", "upper", "full"] as const) {
        const n = d[id] ?? 0;
        if (n < (DIAGNOSTIC_TARGETS.distanceMin[id] ?? 0) || n < (DIAGNOSTIC_TARGETS.distanceShare[id] ?? 0) * total) {
          lackDist.add(id);
        }
      }
    }
    const v = s.axes.view;
    const vTotal = (v.front ?? 0) + (v.side ?? 0) + (v.back ?? 0);
    if (vTotal >= 5) {
      for (const id of ["front", "side", "back"] as const) {
        if ((v[id] ?? 0) < VIEW_MIN_SHARE * vTotal) lackView.add(id);
      }
    }
  }
  if (lackDist.size === 0 && lackView.size === 0) return null;

  const distances: string[] = [];
  if (lackDist.has("closeup") || lackDist.has("upper")) distances.push("close_up");
  if (lackDist.has("full")) distances.push("wide");

  const azimuths: string[] = [];
  if (lackView.has("front")) azimuths.push("front");
  if (lackView.has("side")) azimuths.push("front_right", "right_profile", "left_profile", "front_left");
  // 「寄り」×後ろ向きは回転が弱い組み合わせ（angleSelectionWarning）なので、寄りを選ぶときは後ろを外して案内する。
  const backLater = lackView.has("back") && distances.includes("close_up") && !distances.includes("wide");
  if (lackView.has("back") && !backLater) azimuths.push("back_right", "back", "back_left");
  // 距離だけが足りないときは、正面と斜め前で数を揃える（向きも少し散らす）。
  if (azimuths.length === 0) azimuths.push("front", "front_right", "front_left");
  // 向きだけが足りないときは、元の距離のまま向きだけ変える。
  if (distances.length === 0) distances.push("keep");

  const label = { closeup: "顔アップ", upper: "上半身", full: "全身", front: "正面", side: "斜め・横", back: "後ろ" };
  const lacks = [...lackDist, ...lackView].map((k) => label[k]).join("・");
  return {
    selection: { azimuths, elevations: ["eye_level"], distances },
    reason:
      `診断で足りなかった「${lacks}」に合わせて構図を選んであります。` +
      (backLater ? "後ろ姿は、距離を「そのまま」にして別に作ってください（寄りのままだと後ろへの回転が弱くなります）。" : ""),
  };
}
